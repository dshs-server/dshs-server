"""Hub backend — multi-node orchestrator for dshs PC rental system.

Architecture:
  Vercel frontend → This hub (FastAPI on 100.79.232.71) → Each node (SSH)
  Firebase Firestore: nodes, sessions, users collections
  In-memory metrics cache: updated every 10s via SSH from each node
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import shlex
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import asyncssh
import firebase_admin
from firebase_admin import credentials, firestore_async
from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("API_KEY", "dev-secret-change-me")
FIREBASE_CRED = os.environ.get("FIREBASE_CRED", "serviceAccountKey.json")
SSH_USER = os.environ.get("SSH_USER", "admin-swai")
SSH_PASSWORD = os.environ.get("SSH_PASSWORD", "")
if not SSH_PASSWORD:
    raise RuntimeError("SSH_PASSWORD environment variable is required")
KASM_IMAGE = os.environ.get("KASM_IMAGE", "dshs-kasm-win10")
ACTIVE_CONTAINER = "active_session"  # legacy sessions only
PORT_BASE = 8081   # multi-session container port range start
PORT_MAX  = 8199   # max 119 concurrent sessions per node
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))  # seconds

# 파일 전송 — 노드 호스트의 공유 폴더(사용자별) ↔ 컨테이너 바탕화면에 bind-mount.
# 비우면 노드별 ssh_user 홈(/home/<ssh_user>/dshs-shared) 아래에 두어 sudo 없이 쓰기 가능.
SHARED_BASE = os.environ.get("SHARED_BASE", "")
# 컨테이너 안에서 사용자에게 보이는 경로 (Kasm 기본 사용자 kasm-user의 바탕화면)
DESKTOP_SHARE = os.environ.get("DESKTOP_SHARE", "/home/kasm-user/받은파일")
# 업로드 토큰 서명 키 — Vercel과 공유. 별도 설정 없으면 API_KEY 재사용.
UPLOAD_SECRET = os.environ.get("UPLOAD_SECRET", API_KEY)

# ── Firebase ──────────────────────────────────────────────────────────────────

_cred = credentials.Certificate(FIREBASE_CRED)
firebase_admin.initialize_app(_cred)
db = firestore_async.client()

COL_NODES = "nodes"
COL_SESSIONS = "sessions"
COL_USERS = "users"

# ── Metrics cache ─────────────────────────────────────────────────────────────
# node_id → {cpu, ram_used_gb, ram_total_gb, storage_used_gb, storage_total_gb,
#             gpu, top, docker, offline, last_seen}
_metrics: dict[str, dict] = {}

# ── SSH ───────────────────────────────────────────────────────────────────────

# Collects all metrics in one SSH round-trip using only stdlib + /proc + system tools.
_METRICS_SCRIPT = r"""python3 << 'PYEOF'
import json, subprocess, time

def sh(c):
    try: return subprocess.check_output(c, shell=True, text=True, stderr=subprocess.DEVNULL).strip()
    except: return ''

# CPU: two /proc/stat samples 0.5s apart
def _stat():
    parts = open('/proc/stat').readline().split()[1:]
    return [int(x) for x in parts]
s1 = _stat(); time.sleep(0.5); s2 = _stat()
idle = lambda s: s[3] + (s[4] if len(s) > 4 else 0)
total = lambda s: sum(s[:8])
dt = total(s2) - total(s1)
cpu = round((1 - (idle(s2) - idle(s1)) / dt) * 100, 1) if dt > 0 else 0.0

# RAM from /proc/meminfo
mi = {}
for line in open('/proc/meminfo'):
    k, *v = line.split(); mi[k.rstrip(':')] = int(v[0]) if v else 0
rt, ra = mi.get('MemTotal', 0), mi.get('MemAvailable', 0)

# Storage
sr = sh('df --output=used,size / | tail -1').split()
su = int(sr[0]) if sr else 0
st = int(sr[1]) if len(sr) > 1 else 0

# GPU
gpu_raw = sh('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits')
gpu = float(gpu_raw.splitlines()[0]) if gpu_raw.strip() else 0.0

# Top process by CPU
top = sh("ps -eo comm --sort=-%cpu | sed -n '2p'") or None

# Count running kasm_* containers
kasm_raw = sh("docker ps --filter 'name=kasm_' --format '{{.Names}}'")
kasm_running = len([x for x in kasm_raw.splitlines() if x.strip()]) if kasm_raw.strip() else 0

print(json.dumps({
    'cpu': cpu,
    'ram_used_gb': round((rt - ra) / 1048576, 1),
    'ram_total_gb': round(rt / 1048576, 1),
    'storage_used_gb': round(su / 1048576, 1),
    'storage_total_gb': round(st / 1048576, 1),
    'gpu': gpu,
    'top': top,
    'kasm_running': kasm_running,
}))
PYEOF"""

def _docker_status_cmd(container: str) -> str:
    return (
        f"docker inspect {container} 2>/dev/null | "
        f"python3 -c \"import json,sys; d=json.load(sys.stdin); print(d[0]['State']['Status'])\" "
        f"2>/dev/null || echo none"
    )


async def _ssh(host: str, command: str, ssh_user: str = SSH_USER) -> tuple[str, int]:
    """Run command on remote node. Returns (stdout, returncode). -1 on connection failure."""
    try:
        async with asyncssh.connect(
            host,
            username=ssh_user,
            password=SSH_PASSWORD,
            known_hosts=None,  # 내부망 직통 — 호스트 검증 불필요
            connect_timeout=10,
        ) as conn:
            r = await conn.run(command)
            return (r.stdout or "").strip(), r.returncode or 0
    except Exception:
        return "", -1


# ── Background polling ────────────────────────────────────────────────────────


async def _collect_metrics(node_id: str, ip: str, ssh_user: str = SSH_USER) -> dict:
    stdout, rc = await _ssh(ip, _METRICS_SCRIPT, ssh_user)
    if rc != 0 or not stdout:
        return {"offline": True}
    try:
        data = json.loads(stdout)
        data["offline"] = False
        data["last_seen"] = time.time()
        return data
    except json.JSONDecodeError:
        return {"offline": True}


async def _poll_nodes_loop():
    while True:
        try:
            snap = await db.collection(COL_NODES).get()
            nodes = [{"id": d.id, **d.to_dict()} for d in snap]

            if nodes:
                results = await asyncio.gather(
                    *[_collect_metrics(n["id"], n["ip"], n.get("ssh_user", SSH_USER)) for n in nodes],
                    return_exceptions=True,
                )
                # node_id → (ip, ssh_user) lookup
                node_info = {n["id"]: (n["ip"], n.get("ssh_user", SSH_USER)) for n in nodes}

                for node, result in zip(nodes, results):
                    if isinstance(result, Exception):
                        _metrics[node["id"]] = {"offline": True}
                    else:
                        _metrics[node["id"]] = result

                # Sync session status: starting → active, auto-expire
                now = time.time()
                sessions_snap = await (
                    db.collection(COL_SESSIONS)
                    .where("status", "in", ["active", "starting"])
                    .get()
                )
                for doc in sessions_snap:
                    s = doc.to_dict()
                    nid = s.get("node_id", "")
                    # Auto-expire
                    if s.get("expires_at") and now >= s["expires_at"]:
                        node_ip, node_suser = node_info.get(nid, (None, SSH_USER))
                        if node_ip and not _metrics.get(nid, {}).get("offline"):
                            await _ssh(node_ip, f"docker stop {_container_name(doc.id)}", node_suser)
                        await doc.reference.update({"status": "suspended", "suspended_at": now})
                        continue
                    # starting → active when container running
                    if s.get("status") == "starting":
                        node_ip, node_suser = node_info.get(nid, (None, SSH_USER))
                        if node_ip:
                            dock = await _docker_status(node_ip, node_suser, _container_name(doc.id))
                            if dock == "running":
                                await doc.reference.update({"status": "active"})
        except Exception:
            pass

        await asyncio.sleep(POLL_INTERVAL)


# ── App ───────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_poll_nodes_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Auth ──────────────────────────────────────────────────────────────────────


async def require_key(x_api_key: str = Header(...)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


async def require_user(x_user_email: str = Header("")):
    if not (x_user_email or "").strip():
        raise HTTPException(status_code=401, detail="Login required")


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _get_node(node_id: str) -> dict:
    doc = await db.collection(COL_NODES).document(node_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return {"id": doc.id, **doc.to_dict()}


async def _get_user_max_sessions(email: str) -> int:
    doc = await db.collection(COL_USERS).document(email).get()
    return doc.to_dict().get("max_sessions", 1) if doc.exists else 1


async def _count_active_sessions(email: str) -> int:
    docs = await (
        db.collection(COL_SESSIONS)
        .where("owner", "==", email)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    return len(docs)


async def _docker_status(ip: str, ssh_user: str, container: str) -> str:
    """Direct SSH check for specific container status."""
    stdout, rc = await _ssh(ip, _docker_status_cmd(container), ssh_user)
    return stdout if rc == 0 and stdout else "none"


def _container_name(session_id: str) -> str:
    return f"kasm_{session_id}"

def _session_url(session_id: str, kasm_url: str) -> str:
    return f"{kasm_url.rstrip('/')}/{session_id}/"

async def _allocate_port(node_id: str, node_ip: str, ssh_user: str) -> int:
    snap = await (
        db.collection(COL_SESSIONS)
        .where("node_id", "==", node_id)
        .where("status", "in", ["active", "starting", "suspended"])
        .get()
    )
    used = {s.to_dict().get("port") for s in snap if s.to_dict().get("port")}
    # 실제 docker 포트도 확인 (Firestore에 없는 orphaned 컨테이너 대비)
    stdout, _ = await _ssh(
        node_ip,
        "docker ps --format '{{.Ports}}' | grep -oP '0\\.0\\.0\\.0:\\K\\d+(?=->)'",
        ssh_user,
    )
    for p in stdout.splitlines():
        try:
            used.add(int(p))
        except ValueError:
            pass
    for port in range(PORT_BASE, PORT_MAX + 1):
        if port not in used:
            return port
    raise HTTPException(503, "노드 포트 부족 — 최대 세션 수 초과")

_NGINX_LOCATION = """\
    location /{session_id}/ {{
        proxy_pass https://localhost:{port}/;
        proxy_set_header Authorization "Basic a2FzbV91c2VyOnRlc3QxMjM0";
        proxy_set_header Host $host;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }}"""

async def _nginx_update(node_id: str, node_ip: str, ssh_user: str, kasm_url: str):
    snap = await (
        db.collection(COL_SESSIONS)
        .where("node_id", "==", node_id)
        .where("status", "in", ["active", "starting", "suspended"])
        .get()
    )
    domain = kasm_url.removeprefix("https://").rstrip("/")
    locations = [
        _NGINX_LOCATION.format(session_id=doc.id, port=s["port"])
        for doc in snap
        if (s := doc.to_dict()).get("port")
    ]
    inner = "\n".join(locations) if locations else "    # no sessions"
    config = f"server {{\n    listen 80;\n    server_name {domain};\n{inner}\n}}"
    b64 = base64.b64encode(config.encode()).decode()
    cmd = (
        f"echo {b64} | base64 -d > /home/{ssh_user}/.nginx-kasm.conf "
        f"&& sudo nginx -s reload"
    )
    await _ssh(node_ip, cmd, ssh_user)


def _node_session_state(node_id: str, sessions: list[dict]) -> str:
    for s in sessions:
        if s.get("node_id") == node_id:
            if s.get("status") in ("active", "starting"):
                return "active"
            if s.get("status") == "suspended":
                return "suspended"
    return "none"


# ── File transfer helpers ─────────────────────────────────────────────────────


def _share_key(email: str) -> str:
    """이메일을 안전한 디렉터리 이름으로 변환한다 (사용자별 공유 폴더 키)."""
    return re.sub(r"[^a-z0-9._@-]", "_", (email or "anon").lower()) or "anon"


def _shared_base(ssh_user: str) -> str:
    """노드 호스트의 공유 폴더 베이스. SHARED_BASE env가 있으면 그대로, 없으면 노드 ssh_user 홈 기준."""
    return SHARED_BASE or f"/home/{ssh_user}/dshs-shared"


def _share_dir(email: str, ssh_user: str) -> str:
    return f"{_shared_base(ssh_user)}/{_share_key(email)}"


def _mount_arg(email: str, ssh_user: str) -> str:
    """docker run 에 붙일 -v 옵션 문자열. 사용자 공유 폴더 → 컨테이너 바탕화면."""
    return f"-v {shlex.quote(_share_dir(email, ssh_user))}:{shlex.quote(DESKTOP_SHARE)}"


def _verify_upload_token(token: str) -> str:
    """Vercel이 발급한 HMAC 업로드 토큰을 검증하고 email을 반환한다.

    토큰 형식: base64url(`<email>|<exp>`) + '.' + HMAC-SHA256(UPLOAD_SECRET, payload_b64)
    """
    if not token or "." not in token:
        raise HTTPException(status_code=401, detail="업로드 토큰이 없습니다.")
    payload_b64, sig = token.rsplit(".", 1)
    expected = hmac.new(
        UPLOAD_SECRET.encode(), payload_b64.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="업로드 토큰 서명이 올바르지 않습니다.")
    try:
        pad = "=" * (-len(payload_b64) % 4)
        payload = base64.urlsafe_b64decode(payload_b64 + pad).decode()
        email, exp = payload.rsplit("|", 1)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=401, detail="업로드 토큰 형식이 올바르지 않습니다.")
    if time.time() > float(exp):
        raise HTTPException(status_code=401, detail="업로드 토큰이 만료되었습니다. 새로고침 후 다시 시도해주세요.")
    return email.lower()


async def _container_has_share_mount(host: str, container: str, ssh_user: str = SSH_USER) -> bool:
    """실행 중인 컨테이너에 받은파일 bind-mount가 이미 걸려 있는지 확인한다."""
    tmpl = "{{range .Mounts}}{{.Destination}}\n{{end}}"
    out, rc = await _ssh(host, f"docker inspect -f '{tmpl}' {container}", ssh_user)
    return rc == 0 and DESKTOP_SHARE in out


# ── Routes: health ────────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Routes: nodes ─────────────────────────────────────────────────────────────


@app.get("/nodes", dependencies=[Depends(require_key)])
async def list_nodes(
    cpu_cores: Optional[int] = None,
    ram_gb: Optional[int] = None,
    storage_gb: Optional[int] = None,
    gpu: Optional[str] = None,
):
    nodes_snap = await db.collection(COL_NODES).get()
    sessions_snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting", "suspended"])
        .get()
    )
    sessions = [s.to_dict() for s in sessions_snap]

    result = []
    for doc in nodes_snap:
        n = doc.to_dict()
        if cpu_cores is not None and n.get("cpu_cores", 0) < cpu_cores:
            continue
        if ram_gb is not None and n.get("ram_gb", 0) < ram_gb:
            continue
        if storage_gb is not None and n.get("storage_gb", 0) < storage_gb:
            continue
        if gpu is not None and n.get("gpu_type", "none") != gpu:
            continue

        state = _node_session_state(doc.id, sessions)
        result.append({
            "id": doc.id,
            "name": n.get("name", doc.id),
            "cpu": n.get("cpu", ""),
            "cpu_cores": n.get("cpu_cores", 0),
            "gpu": n.get("gpu", ""),
            "ram_gb": n.get("ram_gb", 0),
            "storage_gb": n.get("storage_gb", 0),
            "available": state != "active",
            "session_state": state,
        })

    return {"nodes": result}


@app.get("/node_specs", dependencies=[Depends(require_key)])
async def node_specs():
    """Legacy single-node spec endpoint."""
    snap = await db.collection(COL_NODES).get()
    docs = list(snap)
    if not docs:
        return {
            "id": "server-01", "name": "1호기",
            "cpu": "Intel Core i7", "gpu": "NVIDIA GTX 1660",
            "ram_gb": 32, "storage_gb": 500, "available": True, "session_state": "none",
        }
    n = docs[0].to_dict()
    sessions_snap = await (
        db.collection(COL_SESSIONS)
        .where("node_id", "==", docs[0].id)
        .where("status", "in", ["active", "starting", "suspended"])
        .get()
    )
    sessions = [s.to_dict() for s in sessions_snap]
    state = _node_session_state(docs[0].id, sessions)
    return {
        "id": docs[0].id, **n,
        "available": state != "active",
        "session_state": state,
    }


# ── Routes: sessions ──────────────────────────────────────────────────────────


class SessionBody(BaseModel):
    node_id: Optional[str] = None
    project_name: Optional[str] = None
    team_members: Optional[list[str]] = None
    resources: Optional[dict] = None
    duration_days: Optional[int] = 7
    replace_session_id: Optional[str] = None


@app.get("/session", dependencies=[Depends(require_key), Depends(require_user)])
async def get_session(
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    me = x_user_email.lower()
    snap = await db.collection(COL_SESSIONS).where("owner", "==", me).get()
    all_sessions = [(doc.id, doc.to_dict()) for doc in snap]

    active = [(sid, s) for sid, s in all_sessions if s.get("status") in ("active", "starting")]
    suspended = [(sid, s) for sid, s in all_sessions if s.get("status") == "suspended"]

    suspended_sessions = [
        {
            "id": sid,
            "project_name": s.get("project_name", ""),
            "saved_at": s.get("suspended_at") or s.get("created_at", 0),
            "team_members": s.get("team_members", []),
            "resources": s.get("resources", {}),
        }
        for sid, s in suspended
    ]

    if not active:
        return {"status": "none", "suspended_sessions": suspended_sessions}

    session_id, s = active[0]
    node = await _get_node(s["node_id"])
    _suser = node.get("ssh_user", SSH_USER)
    dock = await _docker_status(node["ip"], _suser, _container_name(session_id))

    if dock == "running":
        url = s.get("url") or _session_url(session_id, node.get("kasm_url", "https://kasm.dshs-app.net"))
        return {
            "status": "ready",
            "session_id": session_id,
            "url": url,
            "expires_at": s.get("expires_at"),
            "suspended_sessions": suspended_sessions,
        }

    if dock in ("none", "dead"):
        # 컨테이너가 없거나 완전히 죽음 — stale 세션 정리
        await db.collection(COL_SESSIONS).document(session_id).delete()
        return {"status": "none", "suspended_sessions": suspended_sessions}

    if dock == "exited":
        # 컨테이너가 중지됨 — suspended로 전환
        await db.collection(COL_SESSIONS).document(session_id).update({
            "status": "suspended",
            "suspended_at": time.time(),
        })
        suspended_sessions = [{"id": session_id, "project_name": s.get("project_name", ""),
                                "saved_at": time.time(), "team_members": s.get("team_members", []),
                                "resources": s.get("resources", {})}] + suspended_sessions
        return {"status": "none", "suspended_sessions": suspended_sessions}

    # restarting, paused 등 — 실제로 준비 중
    return {"status": "starting", "session_id": session_id, "suspended_sessions": suspended_sessions}


@app.get("/session/{session_id}", dependencies=[Depends(require_key), Depends(require_user)])
async def poll_session(
    session_id: str,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    doc = await db.collection(COL_SESSIONS).document(session_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Session not found")

    s = doc.to_dict()
    me = x_user_email.lower()
    if x_user_admin != "1" and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 조회할 수 있습니다.")

    node = await _get_node(s["node_id"])
    _suser = node.get("ssh_user", SSH_USER)
    dock = await _docker_status(node["ip"], _suser, _container_name(session_id))

    if dock == "running":
        url = s.get("url") or _session_url(session_id, node.get("kasm_url", "https://kasm.dshs-app.net"))
        return {"status": "ready", "url": url}
    if dock in ("exited", "dead"):
        return {"status": "error", "message": "컨테이너가 예기치 않게 종료되었습니다."}
    return {"status": "starting"}


@app.post("/session", dependencies=[Depends(require_key), Depends(require_user)])
async def create_session(
    resume: bool = Query(False),
    session_id: Optional[str] = Query(None),
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
    body: Optional[SessionBody] = Body(default=None),
):
    me = x_user_email.lower()
    is_admin = x_user_admin == "1"

    if resume:
        query = (
            db.collection(COL_SESSIONS)
            .where("owner", "==", me)
            .where("status", "==", "suspended")
        )
        docs = await query.get()
        if not docs:
            raise HTTPException(status_code=404, detail="저장된 세션이 없습니다.")

        target = next((d for d in docs if d.id == session_id), docs[0]) if session_id else docs[0]
        s = target.to_dict()
        node = await _get_node(s["node_id"])
        _suser = node.get("ssh_user", SSH_USER)

        container = _container_name(target.id)
        stdout, rc = await _ssh(node["ip"], f"docker start {container}", _suser)
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"docker start 실패: {stdout}")

        await target.reference.update({"status": "starting", "created_at": time.time()})
        if s.get("port"):
            await _nginx_update(s["node_id"], node["ip"], _suser, node.get("kasm_url", ""))
        return {"session_id": target.id, "status": "starting"}

    # ── New session ────────────────────────────────────────────────────────────

    if not is_admin:
        active_count = await _count_active_sessions(me)
        max_s = await _get_user_max_sessions(me)
        if active_count >= max_s:
            raise HTTPException(status_code=429, detail="이미 활성 PC가 있습니다.")

    # Delete suspended session being replaced
    if body and body.replace_session_id:
        old_doc = await db.collection(COL_SESSIONS).document(body.replace_session_id).get()
        if old_doc.exists:
            old_s = old_doc.to_dict()
            if old_s.get("owner") == me or is_admin:
                old_node = await _get_node(old_s["node_id"])
                old_container = _container_name(body.replace_session_id)
                await _ssh(
                    old_node["ip"],
                    f"docker rm -f {old_container} 2>/dev/null || true",
                    old_node.get("ssh_user", SSH_USER),
                )
                await old_doc.reference.delete()

    # Pick node — least-loaded with remaining port capacity
    node_id = body.node_id if body else None
    if not node_id:
        nodes_snap = await db.collection(COL_NODES).get()
        sessions_snap = await (
            db.collection(COL_SESSIONS)
            .where("status", "in", ["active", "starting", "suspended"])
            .get()
        )
        session_counts: dict[str, int] = {}
        for sn in sessions_snap:
            nid2 = sn.to_dict().get("node_id", "")
            session_counts[nid2] = session_counts.get(nid2, 0) + 1

        best_node: Optional[str] = None
        best_count = PORT_MAX - PORT_BASE + 1  # max capacity
        for doc in nodes_snap:
            count = session_counts.get(doc.id, 0)
            if count < best_count:
                best_count = count
                best_node = doc.id
        if not best_node:
            raise HTTPException(status_code=503, detail="사용 가능한 PC가 없습니다.")
        node_id = best_node

    node = await _get_node(node_id)
    _suser = node.get("ssh_user", SSH_USER)
    kasm_url = node.get("kasm_url", "https://kasm.dshs-app.net")

    new_id = uuid.uuid4().hex[:8]
    port = await _allocate_port(node_id, node["ip"], _suser)
    container = _container_name(new_id)

    # 사용자별 공유 폴더 준비 후 컨테이너 바탕화면에 bind-mount → 업로드한 파일이 보임
    share_dir = _share_dir(me, _suser)
    await _ssh(
        node["ip"],
        f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)}",
        _suser,
    )

    cmd = (
        f"docker run -d --name {container} --restart unless-stopped "
        f"--gpus all --shm-size=2gb -p {port}:6901 {_mount_arg(me, _suser)} "
        f"-e VNC_PW=test1234 {KASM_IMAGE}:latest"
    )
    stdout, rc = await _ssh(node["ip"], cmd, _suser)
    if rc != 0:
        # GPU 드라이버 미매치(NVML error, rc=125) 등 GPU 실패 → CPU 모드로 재시도
        await _ssh(node["ip"], f"docker rm -f {container} 2>/dev/null || true", _suser)
        cmd_no_gpu = (
            f"docker run -d --name {container} --restart unless-stopped "
            f"--shm-size=2gb -p {port}:6901 {_mount_arg(me, _suser)} "
            f"-e VNC_PW=test1234 {KASM_IMAGE}:latest"
        )
        stdout, rc = await _ssh(node["ip"], cmd_no_gpu, _suser)
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"docker run 실패: {stdout}")

    duration = (body.duration_days if body else None) or 7
    await db.collection(COL_SESSIONS).document(new_id).set({
        "node_id": node_id,
        "owner": me,
        "team_members": (body.team_members if body else None) or [],
        "project_name": (body.project_name if body else None) or "",
        "status": "starting",
        "created_at": time.time(),
        "expires_at": time.time() + duration * 86400,
        "resources": (body.resources if body else None) or {},
        "port": port,
        "url": _session_url(new_id, kasm_url),
    })

    await _nginx_update(node_id, node["ip"], _suser, kasm_url)
    return {"session_id": new_id, "status": "starting"}


@app.delete("/session/{session_id}", dependencies=[Depends(require_key), Depends(require_user)])
async def delete_session(
    session_id: str,
    permanent: bool = Query(False),
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    doc = await db.collection(COL_SESSIONS).document(session_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Session not found")

    s = doc.to_dict()
    me = x_user_email.lower()
    if x_user_admin != "1" and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 종료할 수 있습니다.")

    node = await _get_node(s["node_id"])
    _suser = node.get("ssh_user", SSH_USER)
    container = _container_name(session_id)
    kasm_url = node.get("kasm_url", "")

    if permanent:
        await _ssh(node["ip"], f"docker rm -f {container}", _suser)
        await doc.reference.delete()
        await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
        return {"message": "세션을 완전히 삭제했습니다."}

    await _ssh(node["ip"], f"docker stop {container}", _suser)
    await doc.reference.update({"status": "suspended", "suspended_at": time.time()})
    await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
    return {"status": "suspended"}


# ── Routes: file upload ───────────────────────────────────────────────────────


@app.post("/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
    x_upload_token: str = Header(""),
):
    """학생 브라우저가 LAN으로 직접 호출. 토큰으로 본인 확인 후, 본인 세션이
    떠 있는 노드의 공유 폴더로 파일을 전송한다. 컨테이너 바탕화면/받은파일에서 보임."""
    email = _verify_upload_token(x_upload_token)

    # 본인의 세션 노드 찾기 (활성/시작중 우선, 없으면 저장된 세션)
    snap = await db.collection(COL_SESSIONS).where("owner", "==", email).get()
    session_pairs = [(doc.id, doc.to_dict()) for doc in snap]
    target_pair = next(
        ((sid, s) for sid, s in session_pairs if s.get("status") in ("active", "starting")),
        next(((sid, s) for sid, s in session_pairs if s.get("status") == "suspended"), None),
    )
    if not target_pair:
        raise HTTPException(
            status_code=400, detail="먼저 PC 세션을 시작한 뒤 파일을 보낼 수 있습니다."
        )

    target_sid, target = target_pair
    node = await _get_node(target["node_id"])
    host = node["ip"]
    ssh_user = node.get("ssh_user", SSH_USER)
    share_dir = _share_dir(email, ssh_user)
    upload_container = _container_name(target_sid)

    await _ssh(host, f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)}", ssh_user)
    has_mount = await _container_has_share_mount(host, upload_container, ssh_user)

    saved: list[str] = []
    try:
        async with asyncssh.connect(
            host,
            username=ssh_user,
            password=SSH_PASSWORD,
            known_hosts=None,
            connect_timeout=10,
        ) as conn:
            async with conn.start_sftp_client() as sftp:
                for f in files:
                    fname = os.path.basename(f.filename or "file") or "file"
                    remote = f"{share_dir}/{fname}"
                    async with sftp.open(remote, "wb") as rf:
                        while True:
                            chunk = await f.read(1024 * 1024)
                            if not chunk:
                                break
                            await rf.write(chunk)
                    await conn.run(f"chmod 666 {shlex.quote(remote)}")
                    saved.append(fname)

            # 마운트 없이 이미 떠 있는 컨테이너에는 docker cp로 즉시 반영
            if not has_mount:
                await conn.run(
                    f"docker exec -u root {upload_container} mkdir -p {shlex.quote(DESKTOP_SHARE)}"
                )
                for fname in saved:
                    remote = f"{share_dir}/{fname}"
                    await conn.run(
                        f"docker cp {shlex.quote(remote)} "
                        f"{upload_container}:{shlex.quote(DESKTOP_SHARE + '/')}"
                    )
                await conn.run(
                    f"docker exec -u root {upload_container} "
                    f"chown -R 1000:1000 {shlex.quote(DESKTOP_SHARE)}"
                )
    except (OSError, asyncssh.Error) as e:
        raise HTTPException(status_code=502, detail=f"노드 전송 실패: {e}")

    return {
        "uploaded": saved,
        "count": len(saved),
        "node": node.get("name", target["node_id"]),
        "live": has_mount or target.get("status") in ("active", "starting"),
    }


# ── Routes: admin monitoring ──────────────────────────────────────────────────


@app.get("/admin/nodes", dependencies=[Depends(require_key)])
async def admin_nodes():
    nodes_snap = await db.collection(COL_NODES).get()
    active_snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    active_by_node = {s.to_dict().get("node_id"): s.to_dict() for s in active_snap}

    result = []
    for doc in nodes_snap:
        n = doc.to_dict()
        m = _metrics.get(doc.id, {})

        if not m or m.get("offline"):
            status = "offline"
        elif m.get("kasm_running", 0) > 0:
            status = "in_use"
        else:
            status = "idle"

        entry: dict = {
            "id": doc.id,
            "name": n.get("name", doc.id),
            "status": status,
            "cpu_usage": m.get("cpu", 0),
            "gpu_usage": m.get("gpu", 0),
            "ram_used_gb": m.get("ram_used_gb", 0),
            "ram_total_gb": m.get("ram_total_gb") or n.get("ram_gb", 0),
            "storage_used_gb": m.get("storage_used_gb", 0),
            "storage_total_gb": m.get("storage_total_gb") or n.get("storage_gb", 0),
            "top_process": m.get("top"),
        }

        if doc.id in active_by_node:
            active = active_by_node[doc.id]
            entry["project_name"] = active.get("project_name", "")
            entry["owner"] = active.get("owner", "")

        result.append(entry)

    return {"nodes": result}


# ── Routes: admin users ───────────────────────────────────────────────────────


@app.get("/admin/users", dependencies=[Depends(require_key)])
async def list_users():
    users_snap = await db.collection(COL_USERS).get()
    active_snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    active_counts: dict[str, int] = {}
    for s in active_snap:
        owner = s.to_dict().get("owner", "")
        active_counts[owner] = active_counts.get(owner, 0) + 1

    return {
        "users": [
            {
                "email": doc.id,
                "max_sessions": doc.to_dict().get("max_sessions", 1),
                "active_sessions": active_counts.get(doc.id, 0),
            }
            for doc in users_snap
        ]
    }


@app.patch("/admin/users/{email}", dependencies=[Depends(require_key)])
async def update_user(email: str, body: dict):
    max_sessions = body.get("max_sessions")
    if max_sessions is None:
        raise HTTPException(status_code=400, detail="max_sessions required")
    await db.collection(COL_USERS).document(email).set(
        {"max_sessions": int(max_sessions)}, merge=True
    )
    return {"email": email, "max_sessions": int(max_sessions)}


# ── Routes: node registry (admin) ─────────────────────────────────────────────


class NodeBody(BaseModel):
    name: str
    ip: str
    ssh_user: str = "ai-admin"
    cpu: str = ""
    cpu_cores: int = 0
    gpu: str = ""
    gpu_type: str = "dedicated"  # none | shared | dedicated
    ram_gb: int = 0
    storage_gb: int = 0
    kasm_url: str = "https://kasm.dshs-app.net"


@app.post("/admin/nodes", dependencies=[Depends(require_key)])
async def register_node(node_id: str = Query(...), body: NodeBody = Body(...)):
    data = body.model_dump()
    await db.collection(COL_NODES).document(node_id).set(data)
    return {"id": node_id, **data}


@app.delete("/admin/nodes/{node_id}", dependencies=[Depends(require_key)])
async def remove_node(node_id: str):
    await db.collection(COL_NODES).document(node_id).delete()
    return {"id": node_id, "deleted": True}


# ── Routes: legacy compat (admin/status, terminate, cleanup, notice) ──────────

COL_CONFIG = "config"

_CLEANUP_CMD = (
    "docker ps -a --filter status=exited --filter status=dead "
    "--format '{{.Names}}' | grep '^kasm_' | xargs -r docker rm -f"
)


@app.get("/admin/status", dependencies=[Depends(require_key)])
async def admin_status():
    snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    sessions = [{"id": doc.id, **doc.to_dict()} for doc in snap]
    active = None
    if sessions:
        s = sessions[0]
        active = {
            "owner": s.get("owner", "익명"),
            "node_id": s.get("node_id"),
            "project_name": s.get("project_name", ""),
            "since": s.get("created_at"),
            "expires_at": s.get("expires_at"),
            "status": s.get("status"),
        }
    return {"active": active, "total_active": len(sessions), "queue": []}


@app.post("/admin/terminate", dependencies=[Depends(require_key)])
async def admin_terminate(node_id: Optional[str] = Query(None)):
    snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    terminated = []
    for doc in snap:
        s = doc.to_dict()
        if node_id and s.get("node_id") != node_id:
            continue
        node = await _get_node(s["node_id"])
        await _ssh(node["ip"], f"docker stop {_container_name(doc.id)}", node.get("ssh_user", SSH_USER))
        await doc.reference.update({"status": "suspended", "suspended_at": time.time()})
        terminated.append(doc.id)
    return {"terminated": terminated, "count": len(terminated)}


@app.post("/admin/cleanup", dependencies=[Depends(require_key)])
async def admin_cleanup(node_id: Optional[str] = Query(None)):
    nodes_snap = await db.collection(COL_NODES).get()
    results = {}
    for doc in nodes_snap:
        if node_id and doc.id != node_id:
            continue
        n = doc.to_dict()
        stdout, rc = await _ssh(n["ip"], _CLEANUP_CMD, n.get("ssh_user", SSH_USER))
        results[doc.id] = {"removed": stdout.strip(), "ok": rc == 0}
    return {"nodes": results}


@app.get("/notice", dependencies=[Depends(require_key)])
async def get_notice():
    doc = await db.collection(COL_CONFIG).document("notice").get()
    text = doc.to_dict().get("text") if doc.exists else None
    return {"notice": text or None}


@app.post("/notice", dependencies=[Depends(require_key)])
async def set_notice(body: dict):
    text = (body.get("notice") or "").strip()
    await db.collection(COL_CONFIG).document("notice").set({"text": text or None})
    return {"notice": text or None}
