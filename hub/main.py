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
import logging
import os
import re
import shlex
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import unquote

import asyncssh
import firebase_admin
from firebase_admin import credentials, firestore_async
from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from .notifications import email_configured, send_email
except ImportError:  # uvicorn main:app launched from the hub directory
    from notifications import email_configured, send_email

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

API_KEY = os.environ.get("API_KEY", "dev-secret-change-me")
FIREBASE_CRED = os.environ.get("FIREBASE_CRED", "serviceAccountKey.json")
SSH_USER = os.environ.get("SSH_USER", "admin-swai")
SSH_PASSWORD = os.environ.get("SSH_PASSWORD", "")
if not SSH_PASSWORD:
    raise RuntimeError("SSH_PASSWORD environment variable is required")
KASM_IMAGE = os.environ.get("KASM_IMAGE", "dshs-kasm-win10")
ACTIVE_CONTAINER = "active_session"
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))  # seconds

# 파일 전송 — 노드 호스트의 공유 폴더(사용자별) ↔ 컨테이너 바탕화면에 bind-mount.
# 비우면 노드별 ssh_user 홈(/home/<ssh_user>/dshs-shared) 아래에 두어 sudo 없이 쓰기 가능.
SHARED_BASE = os.environ.get("SHARED_BASE", "")
# 컨테이너 안에서 사용자에게 보이는 경로 (Kasm 기본 사용자 kasm-user의 바탕화면)
DESKTOP_SHARE = os.environ.get("DESKTOP_SHARE", "/home/kasm-user/Desktop/받은파일")
# 업로드 토큰 서명 키 — Vercel과 공유. 별도 설정 없으면 API_KEY 재사용.
UPLOAD_SECRET = os.environ.get("UPLOAD_SECRET", API_KEY)
# 브라우저가 큰 파일을 나누는 고정 조각 크기. Cloudflare 100MB 요청 제한보다 작게 둔다.
UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024

# 세션 종료 후 보존·알림 정책
SESSION_RETENTION_DAYS = max(1, int(os.environ.get("SESSION_RETENTION_DAYS", "30")))
SESSION_RETENTION_SECONDS = SESSION_RETENTION_DAYS * 86400
SESSION_WARNING_HOURS = tuple(
    sorted(
        {int(value) for value in os.environ.get("SESSION_WARNING_HOURS", "24,1").split(",") if value.strip()},
        reverse=True,
    )
)
DELETION_WARNING_DAYS = tuple(
    sorted(
        {int(value) for value in os.environ.get("DELETION_WARNING_DAYS", "7,1").split(",") if value.strip()},
        reverse=True,
    )
)
LIFECYCLE_CHECK_INTERVAL = max(30, int(os.environ.get("LIFECYCLE_CHECK_INTERVAL", "60")))
PORTAL_URL = os.environ.get("PORTAL_URL", "https://dshs-server.vercel.app/dashboard")
KST = timezone(timedelta(hours=9), name="KST")

# ── Firebase ──────────────────────────────────────────────────────────────────

_cred = credentials.Certificate(FIREBASE_CRED)
firebase_admin.initialize_app(_cred)
db = firestore_async.client()

COL_NODES = "nodes"
COL_SESSIONS = "sessions"
COL_USERS = "users"
COL_ACTIVITY = "activity"

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

# Docker status
d_json = sh('docker inspect active_session')
if d_json:
    try: dock = json.loads(d_json)[0]['State']['Status']
    except: dock = 'none'
else:
    dock = 'none'

print(json.dumps({
    'cpu': cpu,
    'ram_used_gb': round((rt - ra) / 1048576, 1),
    'ram_total_gb': round(rt / 1048576, 1),
    'storage_used_gb': round(su / 1048576, 1),
    'storage_total_gb': round(st / 1048576, 1),
    'gpu': gpu,
    'top': top,
    'docker': dock,
}))
PYEOF"""

_DOCKER_STATUS_CMD = "docker inspect active_session 2>/dev/null | python3 -c \"import json,sys; d=json.load(sys.stdin); print(d[0]['State']['Status'])\" 2>/dev/null || echo none"


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


def _format_kst(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, KST).strftime("%Y년 %m월 %d일 %H:%M")


def _session_recipients(session: dict) -> list[str]:
    recipients = [session.get("owner", ""), *(session.get("team_members") or [])]
    return sorted(
        {
            email.strip().lower()
            for email in recipients
            if isinstance(email, str) and "@" in email
        }
    )


def _session_name(session: dict) -> str:
    return session.get("project_name") or "이름 없는 세션"


async def _log_activity(
    owner: str,
    type_: str,
    title: str,
    detail: str = "",
    *,
    members: Optional[list] = None,
    node_id: Optional[str] = None,
    project_name: Optional[str] = None,
    byte_count: Optional[int] = None,
    ts: Optional[float] = None,
) -> None:
    """사용 기록(활동 로그)을 activity 컬렉션에 적재한다. 실패해도 본 흐름을 막지 않는다."""
    try:
        doc = {
            "owner": (owner or "").lower(),
            "members": [m.lower() for m in (members or []) if isinstance(m, str)],
            "type": type_,
            "title": title,
            "detail": detail,
            "ts": ts if ts is not None else time.time(),
        }
        if node_id:
            doc["node_id"] = node_id
        if project_name:
            doc["project_name"] = project_name
        if byte_count is not None:
            doc["bytes"] = int(byte_count)
        await db.collection(COL_ACTIVITY).add(doc)
    except Exception:
        logger.warning("activity log failed", exc_info=True)


async def _notify_once(
    document,
    session: dict,
    event: str,
    subject: str,
    body: str,
    mark_events: tuple[str, ...] = (),
) -> bool:
    """Send one lifecycle email and persist markers only after SMTP accepts it."""
    field = f"email_{event}_sent_at"
    if session.get(field) or not email_configured():
        return False
    sent = await send_email(
        _session_recipients(session),
        subject,
        f"{body}\n\n대시보드: {PORTAL_URL}\n\n본 메일은 DSHS Server에서 자동 발송되었습니다.",
    )
    if sent:
        now = time.time()
        updates = {field: now}
        updates.update({f"email_{name}_sent_at": now for name in mark_events})
        await document.reference.update(updates)
    return sent


async def _send_expiry_warning(document, session: dict, now: float) -> None:
    expires_at = session.get("expires_at")
    if not isinstance(expires_at, (int, float)) or expires_at <= now:
        return
    remaining = expires_at - now
    eligible = [hours for hours in SESSION_WARNING_HOURS if remaining <= hours * 3600]
    pending = [
        hours
        for hours in eligible
        if not session.get(f"email_expiry_{hours}h_sent_at")
    ]
    if not pending:
        return
    hours = min(pending)
    skipped = tuple(f"expiry_{value}h" for value in eligible if value > hours)
    await _notify_once(
        document,
        session,
        f"expiry_{hours}h",
        f"[DSHS Server] 세션 종료 {hours}시간 전 알림",
        (
            f"'{_session_name(session)}' 세션이 {_format_kst(expires_at)}에 자동 종료됩니다.\n"
            "작업 내용을 저장하고 필요한 파일을 미리 내려받아 주세요.\n"
            f"종료된 세션은 {SESSION_RETENTION_DAYS}일 동안 보관된 뒤 자동 삭제됩니다."
        ),
        skipped,
    )


async def _send_deletion_warning(document, session: dict, now: float) -> None:
    delete_after = session.get("delete_after")
    if not isinstance(delete_after, (int, float)) or delete_after <= now:
        return
    remaining = delete_after - now
    eligible = [days for days in DELETION_WARNING_DAYS if remaining <= days * 86400]
    pending = [
        days
        for days in eligible
        if not session.get(f"email_deletion_{days}d_sent_at")
    ]
    if not pending:
        return
    days = min(pending)
    skipped = tuple(f"deletion_{value}d" for value in eligible if value > days)
    await _notify_once(
        document,
        session,
        f"deletion_{days}d",
        f"[DSHS Server] 저장된 세션 삭제 {days}일 전 알림",
        (
            f"'{_session_name(session)}' 세션의 컨테이너와 파일이 "
            f"{_format_kst(delete_after)}에 영구 삭제됩니다.\n"
            "보관이 필요한 파일은 삭제 전에 세션을 복원하거나 내려받아 주세요."
        ),
        skipped,
    )


async def _suspend_session(document, session: dict, node: dict, reason: str) -> dict:
    """Stop a session, start its retention clock, and notify its users."""
    now = time.time()
    ssh_user = node.get("ssh_user", SSH_USER)
    await _ssh(node["ip"], f"docker stop {ACTIVE_CONTAINER}", ssh_user)
    updates = {
        "status": "suspended",
        "suspended_at": now,
        "delete_after": now + SESSION_RETENTION_SECONDS,
        "suspension_reason": reason,
    }
    await document.reference.update(updates)
    updated = {**session, **updates}
    reason_text = {
        "expired": "사용 시간이 만료되어 세션이 자동 종료되었습니다.",
        "admin": "관리자가 세션을 종료했습니다.",
        "user": "요청하신 세션이 종료되었습니다.",
    }.get(reason, "세션이 종료되었습니다.")
    await _notify_once(
        document,
        updated,
        "suspended",
        "[DSHS Server] 세션 종료 및 보관 안내",
        (
            f"{reason_text}\n"
            f"세션: {_session_name(session)}\n"
            f"영구 삭제 예정: {_format_kst(updates['delete_after'])}\n\n"
            "삭제 예정일 전까지 대시보드에서 세션을 복원할 수 있습니다."
        ),
    )
    await _log_activity(
        session.get("owner", ""),
        "session_suspend",
        "세션이 보관되었습니다",
        _session_name(session),
        members=session.get("team_members"),
        node_id=session.get("node_id"),
        project_name=session.get("project_name"),
    )
    return updated


async def _purge_suspended_session(document, session: dict) -> bool:
    """Permanently remove one expired suspended session from its node and Firestore."""
    node_id = session.get("node_id")
    if not node_id:
        return False
    node = await _get_node(node_id)

    # A stale Firestore record must never remove a container currently assigned elsewhere.
    active_on_node = await (
        db.collection(COL_SESSIONS)
        .where("node_id", "==", node_id)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    if active_on_node:
        logger.warning("Skipping purge for %s: node %s is active", document.id, node_id)
        return False

    owner = session.get("owner", "")
    ssh_user = node.get("ssh_user", SSH_USER)
    share_dir = _share_dir(owner, ssh_user)
    command = (
        f"docker rm -f {ACTIVE_CONTAINER} 2>/dev/null || true\n"
        f"rm -rf {shlex.quote(share_dir)}"
    )
    _, rc = await _ssh(node["ip"], command, ssh_user)
    if rc != 0:
        logger.warning("Failed to purge session %s from node %s", document.id, node_id)
        return False

    recipients = _session_recipients(session)
    await document.reference.delete()
    if email_configured():
        await send_email(
            recipients,
            "[DSHS Server] 저장된 세션이 영구 삭제되었습니다",
            (
                f"'{_session_name(session)}' 세션의 컨테이너와 저장 파일이 보관 기간 만료로 "
                "영구 삭제되었습니다.\n\n"
                f"대시보드: {PORTAL_URL}\n\n"
                "본 메일은 DSHS Server에서 자동 발송되었습니다."
            ),
        )
    return True


async def _process_suspended_sessions(now: float) -> None:
    snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "==", "suspended")
        .get()
    )
    for document in snap:
        try:
            session = document.to_dict()
            delete_after = session.get("delete_after")
            if not isinstance(delete_after, (int, float)):
                # Existing sessions get a full grace period from the first upgraded check.
                delete_after = now + SESSION_RETENTION_SECONDS
                await document.reference.update({"delete_after": delete_after})
                session["delete_after"] = delete_after
                await _notify_once(
                    document,
                    session,
                    "suspended",
                    "[DSHS Server] 저장된 세션 보관 기간 안내",
                    (
                        f"'{_session_name(session)}' 세션은 현재 종료된 상태로 보관 중입니다.\n"
                        f"{_format_kst(delete_after)}에 컨테이너와 파일이 영구 삭제됩니다."
                    ),
                )

            if now >= delete_after:
                await _purge_suspended_session(document, session)
                continue
            await _send_deletion_warning(document, session, now)
        except Exception:
            logger.exception("Failed to process suspended session %s", document.id)


async def _process_active_warnings(now: float) -> None:
    snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    for document in snap:
        try:
            await _send_expiry_warning(document, document.to_dict(), now)
        except Exception:
            logger.exception("Failed to send expiry warning for %s", document.id)


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
    last_lifecycle_check = 0.0
    while True:
        try:
            snap = await db.collection(COL_NODES).get()
            nodes = [{"id": d.id, **d.to_dict()} for d in snap]

            if nodes:
                results = await asyncio.gather(
                    *[_collect_metrics(n["id"], n["ip"], n.get("ssh_user", SSH_USER)) for n in nodes],
                    return_exceptions=True,
                )
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
                        node = next((item for item in nodes if item["id"] == nid), None)
                        if node:
                            await _suspend_session(doc, s, node, "expired")
                        continue
                    # starting → active when docker running
                    if s.get("status") == "starting":
                        if _metrics.get(nid, {}).get("docker") == "running":
                            await doc.reference.update({"status": "active"})

            now = time.time()
            if now - last_lifecycle_check >= LIFECYCLE_CHECK_INTERVAL:
                await _process_active_warnings(now)
                await _process_suspended_sessions(now)
                last_lifecycle_check = now
        except Exception:
            logger.exception("Background session lifecycle check failed")

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


async def _docker_status(node_id: str, ip: str, ssh_user: str = SSH_USER) -> str:
    """Docker status from cache if fresh (<20s), else direct SSH."""
    m = _metrics.get(node_id, {})
    if not m.get("offline") and time.time() - m.get("last_seen", 0) < 20:
        return m.get("docker", "none")
    stdout, rc = await _ssh(ip, _DOCKER_STATUS_CMD, ssh_user)
    return stdout if rc == 0 and stdout else "none"


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


async def _container_has_share_mount(host: str, ssh_user: str = SSH_USER) -> bool:
    """실행 중인 컨테이너에 받은파일 bind-mount가 이미 걸려 있는지 확인한다."""
    tmpl = "{{range .Mounts}}{{.Destination}}\n{{end}}"
    out, rc = await _ssh(host, f"docker inspect -f '{tmpl}' {ACTIVE_CONTAINER}", ssh_user)
    return rc == 0 and DESKTOP_SHARE in out


async def _upload_target(email: str) -> tuple[dict, dict, str, str, str]:
    """업로드 대상 세션과 노드 접속 정보를 찾는다."""
    snap = await db.collection(COL_SESSIONS).where("owner", "==", email).get()
    sessions = [doc.to_dict() for doc in snap]
    target = next(
        (s for s in sessions if s.get("status") in ("active", "starting")),
        next((s for s in sessions if s.get("status") == "suspended"), None),
    )
    if not target:
        raise HTTPException(
            status_code=400, detail="먼저 PC 세션을 시작한 뒤 파일을 보낼 수 있습니다."
        )

    node = await _get_node(target["node_id"])
    host = node["ip"]
    ssh_user = node.get("ssh_user", SSH_USER)
    return target, node, host, ssh_user, _share_dir(email, ssh_user)


def _chunk_meta(
    upload_id: str,
    encoded_name: str,
    chunk_index: int,
    chunk_count: int,
    file_size: int,
) -> tuple[str, str]:
    """조각 헤더를 검증하고 안전한 파일명과 임시 파일명을 반환한다."""
    if not re.fullmatch(r"[a-f0-9]{24,64}", upload_id or ""):
        raise HTTPException(status_code=400, detail="올바르지 않은 업로드 ID입니다.")
    try:
        filename = os.path.basename(unquote(encoded_name or "")) or "file"
    except (TypeError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="올바르지 않은 파일명입니다.")
    if filename in (".", "..") or len(filename.encode("utf-8")) > 240:
        raise HTTPException(status_code=400, detail="파일명이 너무 길거나 올바르지 않습니다.")
    if chunk_count < 1 or chunk_count > 100_000 or not 0 <= chunk_index < chunk_count:
        raise HTTPException(status_code=400, detail="올바르지 않은 파일 조각 번호입니다.")
    if file_size < 0 or file_size > 10 * 1024**4:  # 최대 10TiB
        raise HTTPException(status_code=400, detail="올바르지 않은 파일 크기입니다.")
    expected_count = max(1, (file_size + UPLOAD_CHUNK_BYTES - 1) // UPLOAD_CHUNK_BYTES)
    if chunk_count != expected_count:
        raise HTTPException(status_code=400, detail="파일 조각 크기가 서버 설정과 다릅니다.")
    return filename, f".upload-{upload_id}.part"


# ── Routes: health ────────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "email_notifications": "configured" if email_configured() else "disabled",
        "session_retention_days": SESSION_RETENTION_DAYS,
    }


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
    work_type: Optional[str] = None
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
            "delete_after": s.get("delete_after"),
            "team_members": s.get("team_members", []),
            "resources": s.get("resources", {}),
        }
        for sid, s in suspended
    ]

    if not active:
        return {"status": "none", "suspended_sessions": suspended_sessions}

    session_id, s = active[0]
    node = await _get_node(s["node_id"])
    dock = await _docker_status(s["node_id"], node["ip"], node.get("ssh_user", SSH_USER))

    meta = {
        "project_name": s.get("project_name", ""),
        "work_type": s.get("work_type", ""),
        "node_id": s["node_id"],
        "node_name": node.get("name", s["node_id"]),
        "node_gpu": node.get("gpu", ""),
        "node_ip": node.get("ip", ""),
    }

    if dock == "running":
        return {
            "status": "ready",
            "session_id": session_id,
            "url": node.get("kasm_url", "https://kasm.dshs-app.net"),
            "expires_at": s.get("expires_at"),
            "suspended_sessions": suspended_sessions,
            **meta,
        }

    return {
        "status": "starting",
        "session_id": session_id,
        "suspended_sessions": suspended_sessions,
        **meta,
    }


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
    dock = await _docker_status(s["node_id"], node["ip"], node.get("ssh_user", SSH_USER))

    meta = {
        "project_name": s.get("project_name", ""),
        "work_type": s.get("work_type", ""),
        "node_id": s["node_id"],
        "node_name": node.get("name", s["node_id"]),
        "node_gpu": node.get("gpu", ""),
        "node_ip": node.get("ip", ""),
    }

    if dock == "running":
        return {"status": "ready", "url": node.get("kasm_url", "https://kasm.dshs-app.net"), **meta}
    return {"status": "starting", **meta}


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

        # Block resume if another user's session is active on the same node
        active_on_node = await (
            db.collection(COL_SESSIONS)
            .where("node_id", "==", s["node_id"])
            .where("status", "in", ["active", "starting"])
            .get()
        )
        for a in active_on_node:
            if a.id != target.id and a.to_dict().get("owner") != me:
                raise HTTPException(status_code=409, detail="해당 PC에 다른 사용자의 활성 세션이 있습니다.")

        stdout, rc = await _ssh(node["ip"], f"docker start {ACTIVE_CONTAINER}", _suser)
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"docker start 실패: {stdout}")

        resumed_at = time.time()
        duration = max(1, int(s.get("duration_days") or 7))
        reset_fields = {
            "status": "starting",
            "created_at": resumed_at,
            "expires_at": resumed_at + duration * 86400,
            "delete_after": None,
            "suspended_at": None,
            "suspension_reason": None,
            "email_suspended_sent_at": None,
        }
        reset_fields.update(
            {f"email_expiry_{hours}h_sent_at": None for hours in SESSION_WARNING_HOURS}
        )
        reset_fields.update(
            {f"email_deletion_{days}d_sent_at": None for days in DELETION_WARNING_DAYS}
        )
        await target.reference.update(reset_fields)
        await _log_activity(
            me,
            "session_resume",
            "세션을 이어서 시작했습니다",
            _session_name(s),
            members=s.get("team_members"),
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
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
                node = await _get_node(old_s["node_id"])
                old_ssh_user = node.get("ssh_user", SSH_USER)
                old_share_dir = _share_dir(old_s.get("owner", me), old_ssh_user)
                await _ssh(
                    node["ip"],
                    f"docker rm -f {ACTIVE_CONTAINER} 2>/dev/null || true\n"
                    f"rm -rf {shlex.quote(old_share_dir)}",
                    old_ssh_user,
                )
                await old_doc.reference.delete()

    # Pick node
    node_id = body.node_id if body else None
    if not node_id:
        nodes_snap = await db.collection(COL_NODES).get()
        busy_snap = await (
            db.collection(COL_SESSIONS)
            .where("status", "in", ["active", "starting", "suspended"])
            .get()
        )
        busy_nodes = {s.to_dict().get("node_id") for s in busy_snap}
        for doc in nodes_snap:
            if doc.id not in busy_nodes:
                node_id = doc.id
                break
        if not node_id:
            raise HTTPException(status_code=503, detail="사용 가능한 PC가 없습니다.")
    else:
        # Explicit node_id: verify no active or suspended session from another user
        conflict_snap = await (
            db.collection(COL_SESSIONS)
            .where("node_id", "==", node_id)
            .where("status", "in", ["active", "starting", "suspended"])
            .get()
        )
        for conflict_doc in conflict_snap:
            conflict_s = conflict_doc.to_dict()
            if conflict_s.get("owner") != me:
                raise HTTPException(status_code=409, detail="해당 PC에 다른 사용자의 세션이 있습니다.")
            # Same user's suspended session must be resumed, not replaced (unless replace_session_id given)
            if conflict_s.get("status") == "suspended" and not (body and body.replace_session_id):
                raise HTTPException(status_code=409, detail="저장된 세션이 있습니다. 복원하거나 새로 시작하기를 선택하세요.")

    node = await _get_node(node_id)
    _suser = node.get("ssh_user", SSH_USER)

    # Tear down only if there's no suspended session from another user
    # (replace_session_id case already cleaned up above; auto-picked node is guaranteed clean)
    await _ssh(node["ip"], f"docker rm -f {ACTIVE_CONTAINER} 2>/dev/null || true", _suser)

    # 사용자별 공유 폴더 준비 후 컨테이너 바탕화면에 bind-mount → 업로드한 파일이 보임
    share_dir = _share_dir(me, _suser)
    await _ssh(
        node["ip"],
        f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)}",
        _suser,
    )

    cmd = (
        f"docker run -d --name {ACTIVE_CONTAINER} --restart unless-stopped "
        f"--gpus all --shm-size=2gb -p 8080:6901 {_mount_arg(me, _suser)} "
        f"-e VNC_PW=test1234 {KASM_IMAGE}:latest"
    )
    stdout, rc = await _ssh(node["ip"], cmd, _suser)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"docker run 실패: {stdout}")

    duration = (body.duration_days if body else None) or 7
    new_id = uuid.uuid4().hex[:8]
    await db.collection(COL_SESSIONS).document(new_id).set({
        "node_id": node_id,
        "owner": me,
        "team_members": (body.team_members if body else None) or [],
        "project_name": (body.project_name if body else None) or "",
        "status": "starting",
        "created_at": time.time(),
        "expires_at": time.time() + duration * 86400,
        "duration_days": duration,
        "work_type": (body.work_type if body else None) or "",
        "resources": (body.resources if body else None) or {},
    })

    await _log_activity(
        me,
        "session_start",
        "세션을 시작했습니다",
        f"{(body.project_name if body else '') or '세션'} · {node.get('name', node_id)}",
        members=(body.team_members if body else None),
        node_id=node_id,
        project_name=(body.project_name if body else None),
    )

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

    if permanent:
        owner = s.get("owner", me)
        share_dir = _share_dir(owner, _suser)
        _, rc = await _ssh(
            node["ip"],
            f"docker rm -f {ACTIVE_CONTAINER} 2>/dev/null || true\n"
            f"rm -rf {shlex.quote(share_dir)}",
            _suser,
        )
        if rc != 0:
            raise HTTPException(status_code=502, detail="노드의 세션 파일 삭제에 실패했습니다.")
        recipients = _session_recipients(s)
        await doc.reference.delete()
        await _log_activity(
            s.get("owner", me),
            "session_delete",
            "세션을 영구 삭제했습니다",
            _session_name(s),
            members=s.get("team_members"),
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
        if email_configured():
            await send_email(
                recipients,
                "[DSHS Server] 세션이 영구 삭제되었습니다",
                (
                    f"요청하신 '{_session_name(s)}' 세션의 컨테이너와 파일이 영구 삭제되었습니다.\n\n"
                    f"대시보드: {PORTAL_URL}"
                ),
            )
        return {"message": "세션을 완전히 삭제했습니다."}

    suspended = await _suspend_session(doc, s, node, "user")
    return {"status": "suspended", "delete_after": suspended["delete_after"]}


@app.get("/history", dependencies=[Depends(require_key), Depends(require_user)])
async def get_history(
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    me = x_user_email.lower()
    now = time.time()
    month_start = (
        datetime.now(KST)
        .replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        .timestamp()
    )

    act_snap = await db.collection(COL_ACTIVITY).where("owner", "==", me).get()
    events = sorted(
        (d.to_dict() for d in act_snap),
        key=lambda e: e.get("ts", 0),
        reverse=True,
    )

    sessions_started = sum(
        1
        for e in events
        if e.get("type") in ("session_start", "session_resume") and e.get("ts", 0) >= month_start
    )
    upload_bytes = sum(
        int(e.get("bytes", 0))
        for e in events
        if e.get("type") == "file_upload" and e.get("ts", 0) >= month_start
    )

    # 이번 달에 걸친 세션 활성 구간 합산 (근사치)
    sess_snap = await db.collection(COL_SESSIONS).where("owner", "==", me).get()
    usage_seconds = 0
    for d in sess_snap:
        s = d.to_dict()
        created = s.get("created_at")
        if not isinstance(created, (int, float)):
            continue
        end = s.get("suspended_at")
        if not isinstance(end, (int, float)):
            end = now if s.get("status") in ("active", "starting") else created
        start = max(created, month_start)
        if end > start:
            usage_seconds += int(end - start)

    recent = [
        {
            "ts": e.get("ts", 0),
            "type": e.get("type", ""),
            "title": e.get("title", ""),
            "detail": e.get("detail", ""),
        }
        for e in events[:40]
    ]
    return {
        "summary": {
            "usage_seconds": usage_seconds,
            "sessions_started": sessions_started,
            "upload_bytes": upload_bytes,
        },
        "events": recent,
    }


# ── Routes: file upload ───────────────────────────────────────────────────────


@app.post("/upload/chunk")
async def upload_file_chunk(
    request: Request,
    x_upload_token: str = Header(""),
    x_upload_id: str = Header(""),
    x_file_name: str = Header(""),
    x_chunk_index: int = Header(-1),
    x_chunk_count: int = Header(-1),
    x_file_size: int = Header(-1),
):
    """대용량 파일 한 조각을 중앙 PC 디스크에 쌓지 않고 노드 임시 파일로 바로 쓴다."""
    email = _verify_upload_token(x_upload_token)
    filename, temp_name = _chunk_meta(
        x_upload_id, x_file_name, x_chunk_index, x_chunk_count, x_file_size
    )
    _, _, host, ssh_user, share_dir = await _upload_target(email)
    remote_temp = f"{share_dir}/{temp_name}"
    expected = min(
        UPLOAD_CHUNK_BYTES,
        max(0, x_file_size - x_chunk_index * UPLOAD_CHUNK_BYTES),
    )

    # 완료/취소되지 않은 임시 파일도 24시간 뒤에는 자동 정리한다.
    cleanup = (
        f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)} && "
        f"find {shlex.quote(share_dir)} -maxdepth 1 -type f "
        f"-name '.upload-*.part' -mmin +1440 -delete"
    )
    await _ssh(host, cleanup, ssh_user)

    received = 0
    try:
        async with asyncssh.connect(
            host,
            username=ssh_user,
            password=SSH_PASSWORD,
            known_hosts=None,
            connect_timeout=10,
        ) as conn:
            async with conn.start_sftp_client() as sftp:
                mode = "wb" if x_chunk_index == 0 else "r+b"
                async with sftp.open(remote_temp, mode) as remote_file:
                    offset = x_chunk_index * UPLOAD_CHUNK_BYTES
                    buffer = bytearray()
                    async for data in request.stream():
                        if not data:
                            continue
                        received += len(data)
                        if received > expected:
                            raise HTTPException(status_code=400, detail="파일 조각이 예상보다 큽니다.")
                        buffer.extend(data)
                        if len(buffer) >= 1024 * 1024:
                            payload = bytes(buffer)
                            await remote_file.write(payload, offset)
                            offset += len(payload)
                            buffer.clear()
                    if buffer:
                        await remote_file.write(bytes(buffer), offset)
    except HTTPException:
        raise
    except (OSError, asyncssh.Error) as exc:
        raise HTTPException(status_code=502, detail=f"노드 전송 실패: {exc}")

    if received != expected:
        raise HTTPException(
            status_code=400,
            detail=f"파일 조각 크기가 올바르지 않습니다. ({received}/{expected} bytes)",
        )
    return {
        "received": received,
        "chunk": x_chunk_index + 1,
        "chunks": x_chunk_count,
        "filename": filename,
    }


@app.post("/upload/complete")
async def complete_chunked_upload(
    x_upload_token: str = Header(""),
    x_upload_id: str = Header(""),
    x_file_name: str = Header(""),
    x_chunk_count: int = Header(-1),
    x_file_size: int = Header(-1),
):
    """모든 조각이 도착한 임시 파일을 원래 이름으로 원자적으로 공개한다."""
    email = _verify_upload_token(x_upload_token)
    filename, temp_name = _chunk_meta(
        x_upload_id, x_file_name, max(0, x_chunk_count - 1), x_chunk_count, x_file_size
    )
    target, node, host, ssh_user, share_dir = await _upload_target(email)
    remote_temp = f"{share_dir}/{temp_name}"
    remote = f"{share_dir}/{filename}"

    finalize = (
        f"test \"$(stat -c %s {shlex.quote(remote_temp)} 2>/dev/null)\" = "
        f"{shlex.quote(str(x_file_size))} && "
        f"mv -f {shlex.quote(remote_temp)} {shlex.quote(remote)} && "
        f"chmod 666 {shlex.quote(remote)}"
    )
    output, rc = await _ssh(host, finalize, ssh_user)
    if rc != 0:
        raise HTTPException(
            status_code=409,
            detail="일부 파일 조각이 빠졌거나 크기가 맞지 않습니다. 다시 시도해주세요.",
        )

    has_mount = await _container_has_share_mount(host, ssh_user)
    if not has_mount:
        copy_cmd = (
            f"docker exec -u root {ACTIVE_CONTAINER} mkdir -p {shlex.quote(DESKTOP_SHARE)} && "
            f"docker cp {shlex.quote(remote)} "
            f"{ACTIVE_CONTAINER}:{shlex.quote(DESKTOP_SHARE + '/')} && "
            f"docker exec -u root {ACTIVE_CONTAINER} "
            f"chown -R 1000:1000 {shlex.quote(DESKTOP_SHARE)}"
        )
        copy_output, copy_rc = await _ssh(host, copy_cmd, ssh_user)
        if copy_rc != 0:
            raise HTTPException(status_code=502, detail=f"컨테이너 복사 실패: {copy_output}")
        # 구형 컨테이너는 bind-mount가 없으므로 docker cp 성공 후 호스트 사본을 제거한다.
        await _ssh(host, f"rm -f {shlex.quote(remote)}", ssh_user)

    await _log_activity(
        email,
        "file_upload",
        "파일 전송 완료",
        filename,
        node_id=target.get("node_id"),
        byte_count=x_file_size if x_file_size and x_file_size > 0 else None,
    )

    return {
        "uploaded": [filename],
        "count": 1,
        "node": node.get("name", target["node_id"]),
        "live": has_mount or target.get("status") in ("active", "starting"),
    }


@app.delete("/upload/chunk")
async def cancel_chunked_upload(
    x_upload_token: str = Header(""),
    x_upload_id: str = Header(""),
):
    """사용자가 취소한 대용량 업로드의 노드 임시 파일을 즉시 지운다."""
    email = _verify_upload_token(x_upload_token)
    if not re.fullmatch(r"[a-f0-9]{24,64}", x_upload_id or ""):
        raise HTTPException(status_code=400, detail="올바르지 않은 업로드 ID입니다.")
    _, _, host, ssh_user, share_dir = await _upload_target(email)
    remote_temp = f"{share_dir}/.upload-{x_upload_id}.part"
    await _ssh(host, f"rm -f {shlex.quote(remote_temp)}", ssh_user)
    return {"cancelled": True}


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
    sessions = [doc.to_dict() for doc in snap]
    target = next(
        (s for s in sessions if s.get("status") in ("active", "starting")),
        next((s for s in sessions if s.get("status") == "suspended"), None),
    )
    if not target:
        raise HTTPException(
            status_code=400, detail="먼저 PC 세션을 시작한 뒤 파일을 보낼 수 있습니다."
        )

    node = await _get_node(target["node_id"])
    host = node["ip"]
    ssh_user = node.get("ssh_user", SSH_USER)
    share_dir = _share_dir(email, ssh_user)

    await _ssh(host, f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)}", ssh_user)
    has_mount = await _container_has_share_mount(host, ssh_user)

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
                    f"docker exec -u root {ACTIVE_CONTAINER} mkdir -p {shlex.quote(DESKTOP_SHARE)}"
                )
                for fname in saved:
                    remote = f"{share_dir}/{fname}"
                    await conn.run(
                        f"docker cp {shlex.quote(remote)} "
                        f"{ACTIVE_CONTAINER}:{shlex.quote(DESKTOP_SHARE + '/')}"
                    )
                await conn.run(
                    f"docker exec -u root {ACTIVE_CONTAINER} "
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
        elif m.get("docker") == "running":
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
    f"--format '{{{{.Names}}}}' | grep -v '^{ACTIVE_CONTAINER}$' | xargs -r docker rm -f"
)


@app.get("/admin/sessions", dependencies=[Depends(require_key)])
async def admin_sessions():
    snap = await db.collection(COL_SESSIONS).get()
    node_names: dict[str, str] = {}
    result = []
    for doc in snap:
        s = doc.to_dict()
        nid = s.get("node_id")
        name = nid
        if nid:
            if nid not in node_names:
                try:
                    ndoc = await db.collection(COL_NODES).document(nid).get()
                    node_names[nid] = (ndoc.to_dict() or {}).get("name", nid) if ndoc.exists else nid
                except Exception:
                    node_names[nid] = nid
            name = node_names[nid]
        result.append({
            "id": doc.id,
            "owner": s.get("owner"),
            "project_name": s.get("project_name"),
            "node_id": nid,
            "node_name": name,
            "status": s.get("status"),
            "expires_at": s.get("expires_at"),
            "delete_after": s.get("delete_after"),
        })
    order = {"active": 0, "starting": 1, "suspended": 2}
    result.sort(key=lambda r: order.get(r.get("status"), 3))
    return {"sessions": result}


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
        await _suspend_session(doc, s, node, "admin")
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
