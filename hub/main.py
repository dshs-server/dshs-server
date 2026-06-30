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
import html
import json
import logging
import os
import re
import shlex
import time
import uuid
from binascii import Error as BinasciiError
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("hub")

import asyncssh
import firebase_admin
from firebase_admin import credentials, firestore_async
from fastapi import Body, Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))        # seconds (세션 있는 노드)
IDLE_POLL_INTERVAL = int(os.environ.get("IDLE_POLL_INTERVAL", "60"))  # seconds (세션 없는 노드)
LOG_INTERVAL = int(os.environ.get("LOG_INTERVAL", "600"))             # seconds (10분)
LOG_DIR = os.path.expanduser(os.environ.get("LOG_DIR", "~/hub/logs"))
RECOVERY_INTERVAL = int(os.environ.get("RECOVERY_INTERVAL", "60"))  # 노드당 복구 체크 최소 간격 (초)

# 활성 데스크톱의 최근 파일을 검사해 관리자 보안 경고를 만든다. 확장자 목록은
# 쉼표로 덮어쓸 수 있으며 영숫자 확장자만 허용해 원격 셸 명령에 안전하게 넣는다.
SECURITY_SCAN_ENABLED = os.environ.get("SECURITY_SCAN_ENABLED", "1").lower() not in {"0", "false", "no"}
SECURITY_SCAN_LOOKBACK = int(os.environ.get("SECURITY_SCAN_LOOKBACK", str(max(LOG_INTERVAL * 2, 900))))
SECURITY_ALERT_LIMIT = int(os.environ.get("SECURITY_ALERT_LIMIT", "200"))
SECURITY_EXTENSIONS = tuple(
    ext.strip().lower().lstrip(".")
    for ext in os.environ.get(
        "SECURITY_EXTENSIONS",
        "exe,msi,bat,cmd,com,scr,pif,vbs,vbe,wsf,wsh,ps1,apk",
    ).split(",")
    if re.fullmatch(r"[a-zA-Z0-9]{1,12}", ext.strip().lstrip("."))
)
SECURITY_ALERT_DIR = os.path.join(LOG_DIR, "security-alerts")
SECURITY_ALERTS_FILE = os.path.join(SECURITY_ALERT_DIR, "alerts.json")
KST_OFFSET = 9 * 3600  # KST = UTC+9
REBOOT_UPTIME_DAYS = int(os.environ.get("REBOOT_UPTIME_DAYS", "5"))    # 재부팅 임계 가동 일수
REBOOT_VERIFY_TIMEOUT = int(os.environ.get("REBOOT_VERIFY_TIMEOUT", "600"))  # 재부팅 후 검증 최대 대기(초)

# 파일 전송 — 노드 호스트의 공유 폴더(사용자별) ↔ 컨테이너 바탕화면에 bind-mount.
# 비우면 노드별 ssh_user 홈(/home/<ssh_user>/dshs-shared) 아래에 두어 sudo 없이 쓰기 가능.
SHARED_BASE = os.environ.get("SHARED_BASE", "")
# 컨테이너 안에서 사용자에게 보이는 경로 (Kasm 기본 사용자 kasm-user의 바탕화면)
DESKTOP_SHARE = os.environ.get("DESKTOP_SHARE", "/home/kasm-user/받은파일")
# 업로드 토큰 서명 키 — Vercel과 공유. 별도 설정 없으면 API_KEY 재사용.
UPLOAD_SECRET = os.environ.get("UPLOAD_SECRET", API_KEY)

GMAIL_CREDENTIALS = os.environ.get("GMAIL_CREDENTIALS", "")
GMAIL_TOKEN = os.environ.get("GMAIL_TOKEN", "")
GMAIL_SENDER = os.environ.get("GMAIL_SENDER", "")
EMAIL_CHECK_INTERVAL = int(os.environ.get("EMAIL_CHECK_INTERVAL", "3600"))
WARNING_SECONDS = 7 * 86400
PORTAL_URL = os.environ.get("PORTAL_URL", "https://dshs-app.net")
EMAIL_BRAND = os.environ.get("EMAIL_BRAND", "DSHS 전산실")

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
_last_polled: dict[str, float] = {}  # node_id → last SSH poll timestamp
_last_recovery: dict[str, float] = {}  # node_id → last recovery attempt timestamp
_reboot_pending: dict[str, float] = {}  # node_id → reboot_sent_at timestamp
_nodes_cache: list[dict] = []  # populated from Firestore; cleared on admin write to force reload
NODES_CACHE_FILE = os.path.expanduser("~/hub/nodes_cache.json")


# ── Sessions in-memory cache ──────────────────────────────────────────────────
# Source of truth for reads. Writes go to Firestore (backup) AND here.
# Loaded from Firestore once at startup; falls back to local JSON file if quota exceeded.
_sessions_cache: dict[str, dict] = {}
SESSIONS_CACHE_FILE = os.path.expanduser("~/hub/sessions_cache.json")

# 최신 항목부터 반환하지만 내부 저장은 오래된 순서로 유지한다.
_security_alerts: list[dict] = []


def _sc_get(session_id: str) -> dict | None:
    return _sessions_cache.get(session_id)


def _sc_list(
    *,
    owner: str | None = None,
    status: str | list[str] | None = None,
) -> list[tuple[str, dict]]:
    result = []
    statuses = ([status] if isinstance(status, str) else status) if status else None
    for sid, s in _sessions_cache.items():
        if owner and s.get("owner") != owner:
            continue
        if statuses and s.get("status") not in statuses:
            continue
        result.append((sid, s))
    return result


def _persist_sessions_cache() -> None:
    try:
        with open(SESSIONS_CACHE_FILE, "w") as f:
            json.dump(_sessions_cache, f)
    except Exception:
        pass


def _sc_set(session_id: str, data: dict) -> None:
    _sessions_cache[session_id] = dict(data)
    _persist_sessions_cache()


def _sc_update(session_id: str, updates: dict) -> None:
    if session_id in _sessions_cache:
        _sessions_cache[session_id].update(updates)
        _persist_sessions_cache()


def _sc_del(session_id: str) -> None:
    _sessions_cache.pop(session_id, None)
    _persist_sessions_cache()


async def _init_sessions_cache() -> None:
    try:
        snap = await db.collection(COL_SESSIONS).get()
        for doc in snap:
            _sessions_cache[doc.id] = doc.to_dict()
        logger.info("Sessions cache loaded from Firestore: %d sessions", len(_sessions_cache))
        _persist_sessions_cache()
    except Exception as e:
        logger.warning("Sessions cache Firestore load failed (%s) — trying local file", e)
        try:
            if os.path.exists(SESSIONS_CACHE_FILE):
                with open(SESSIONS_CACHE_FILE) as f:
                    data = json.load(f)
                _sessions_cache.update(data)
                logger.info("Sessions cache loaded from local file: %d sessions", len(_sessions_cache))
            else:
                logger.warning("Sessions cache local file not found — starting empty")
        except Exception as e2:
            logger.error("Sessions cache local file load failed: %s — starting empty", e2)


def _save_nodes_to_file() -> None:
    try:
        with open(NODES_CACHE_FILE, "w") as f:
            json.dump(_nodes_cache, f)
    except Exception:
        pass


def _load_nodes_from_file() -> None:
    try:
        if os.path.exists(NODES_CACHE_FILE):
            with open(NODES_CACHE_FILE) as f:
                data = json.load(f)
            _nodes_cache[:] = data
    except Exception:
        pass


async def _get_nodes() -> list[dict]:
    if not _nodes_cache:
        try:
            snap = await db.collection(COL_NODES).get()
            _nodes_cache[:] = [{"id": d.id, **d.to_dict()} for d in snap]
            _save_nodes_to_file()
        except Exception:
            _load_nodes_from_file()
    return list(_nodes_cache)

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

# Service status (부팅 후 자동 복구 판단용)
svc_nginx     = sh('systemctl is-active nginx')
svc_tunnel    = sh('systemctl is-active kasm-tunnel')
svc_tailscale = sh('systemctl is-active tailscaled')

# 가동 시간 (/proc/uptime 첫 번째 숫자 = 부팅 후 초)
uptime_s = float(open('/proc/uptime').readline().split()[0])

print(json.dumps({
    'cpu': cpu,
    'ram_used_gb': round((rt - ra) / 1048576, 1),
    'ram_total_gb': round(rt / 1048576, 1),
    'storage_used_gb': round(su / 1048576, 1),
    'storage_total_gb': round(st / 1048576, 1),
    'gpu': gpu,
    'top': top,
    'kasm_running': kasm_running,
    'svc_nginx': svc_nginx,
    'svc_tunnel': svc_tunnel,
    'svc_tailscale': svc_tailscale,
    'uptime_seconds': round(uptime_s),
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
            out = ((r.stdout or "") + (r.stderr or "")).strip()
            return out, r.returncode or 0
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


async def _recover_services(node_id: str, node_ip: str, ssh_user: str, metrics: dict) -> None:
    """메트릭에서 감지된 다운 서비스를 SSH로 자동 재시작한다."""
    cmds = []
    nginx_st  = metrics.get("svc_nginx", "")
    tunnel_st = metrics.get("svc_tunnel", "")

    if nginx_st and nginx_st not in ("active", "activating"):
        logger.warning("[recover] %s: nginx=%s → restart", node_id, nginx_st)
        cmds.append("sudo systemctl restart nginx")
    if tunnel_st and tunnel_st not in ("active", "activating"):
        logger.warning("[recover] %s: kasm-tunnel=%s → restart", node_id, tunnel_st)
        cmds.append("sudo systemctl restart kasm-tunnel")

    if cmds:
        _, rc = await _ssh(node_ip, " && ".join(cmds), ssh_user)
        logger.info("[recover] %s: 복구 명령 rc=%d  cmds=%s", node_id, rc, cmds)

    # kasm 컨테이너가 exited 상태로 남아있으면 재시작 (--restart unless-stopped 누락 케이스 대비)
    kasm_running = metrics.get("kasm_running", -1)
    active_for_node = [
        (sid, s) for sid, s in _sc_list(status=["active", "starting"])
        if s.get("node_id") == node_id
    ]
    if active_for_node and kasm_running >= 0 and kasm_running < len(active_for_node):
        for sid, s in active_for_node:
            container = _container_name(sid)
            dock = await _docker_status(node_ip, ssh_user, container)
            if dock == "exited":
                logger.warning("[recover] %s: %s exited → docker start", node_id, container)
                _, rc = await _ssh(node_ip, f"docker start {container}", ssh_user)
                if rc == 0:
                    _sc_update(sid, {"status": "starting"})
                    await db.collection(COL_SESSIONS).document(sid).update({"status": "starting"})


async def _poll_nodes_loop():
    while True:
        try:
            nodes = await _get_nodes()

            if nodes:
                active_node_ids = {s.get("node_id") for _, s in _sc_list(status=["active", "starting"])}

                now = time.time()
                # 세션 있으면 항상 폴링, 없으면 IDLE_POLL_INTERVAL 경과 시에만
                nodes_to_poll = [
                    n for n in nodes
                    if n["id"] in active_node_ids
                    or now - _last_polled.get(n["id"], 0) >= IDLE_POLL_INTERVAL
                ]

                results = await asyncio.gather(
                    *[_collect_metrics(n["id"], n["ip"], n.get("ssh_user", SSH_USER)) for n in nodes_to_poll],
                    return_exceptions=True,
                )
                # node_id → (ip, ssh_user) lookup
                node_info = {n["id"]: (n["ip"], n.get("ssh_user", SSH_USER)) for n in nodes}

                for node, result in zip(nodes_to_poll, results):
                    _last_polled[node["id"]] = now
                    if isinstance(result, Exception):
                        _metrics[node["id"]] = {"offline": True}
                    else:
                        _metrics[node["id"]] = result

                # Sync session status: starting → active, auto-expire
                now = time.time()
                for sid, s in list(_sc_list(status=["active", "starting"])):
                    nid = s.get("node_id", "")
                    # Auto-expire
                    if s.get("expires_at") and now >= s["expires_at"]:
                        node_ip, node_suser = node_info.get(nid, (None, SSH_USER))
                        if node_ip and not _metrics.get(nid, {}).get("offline"):
                            await _ssh(node_ip, f"docker stop {_container_name(sid)}", node_suser)
                        _sc_update(sid, {"status": "suspended", "suspended_at": now})
                        await db.collection(COL_SESSIONS).document(sid).update({"status": "suspended", "suspended_at": now})
                        await _log_activity(
                            s.get("owner", ""),
                            "session_suspend",
                            "세션이 만료되어 보관되었습니다",
                            s.get("project_name") or sid,
                            members=s.get("team_members"),
                            node_id=nid,
                            project_name=s.get("project_name"),
                            ts=now,
                        )
                        await _send_session_email(
                            "auto_suspend",
                            sid,
                            s,
                            event_at=now,
                            actor="시스템 · 대여 기간 만료",
                        )
                        continue
                    # starting → active when container running
                    if s.get("status") == "starting":
                        node_ip, node_suser = node_info.get(nid, (None, SSH_USER))
                        if node_ip:
                            dock = await _docker_status(node_ip, node_suser, _container_name(sid))
                            if dock == "running":
                                _sc_update(sid, {"status": "active"})
                                await db.collection(COL_SESSIONS).document(sid).update({"status": "active"})

                # 서비스 자동 복구 (온라인 노드, RECOVERY_INTERVAL 간격)
                now_t = time.time()
                recovery_tasks = []
                for node in nodes_to_poll:
                    m = _metrics.get(node["id"], {})
                    if not m.get("offline") and now_t - _last_recovery.get(node["id"], 0) >= RECOVERY_INTERVAL:
                        _last_recovery[node["id"]] = now_t
                        recovery_tasks.append(
                            _recover_services(node["id"], node["ip"], node.get("ssh_user", SSH_USER), m)
                        )
                if recovery_tasks:
                    await asyncio.gather(*recovery_tasks, return_exceptions=True)
        except Exception:
            logger.exception("[poll] 노드 및 세션 상태 동기화 실패")

        await asyncio.sleep(POLL_INTERVAL)


# ── Logging ───────────────────────────────────────────────────────────────────


async def _get_container_top3(node_ip: str, ssh_user: str, container: str) -> list[str]:
    stdout, rc = await _ssh(
        node_ip,
        f"docker top {container} -eo comm,pcpu --sort=-pcpu 2>/dev/null"
        f" | tail -n +2 | head -3 | awk '{{print $1}}'",
        ssh_user,
    )
    if rc != 0 or not stdout:
        return []
    return [l.strip() for l in stdout.splitlines() if l.strip()]


def _load_security_alerts() -> None:
    """Load persisted alerts. A damaged file must never stop the hub."""
    _security_alerts.clear()
    try:
        with open(SECURITY_ALERTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            _security_alerts.extend(item for item in data if isinstance(item, dict))
    except (OSError, json.JSONDecodeError):
        return


def _persist_security_alerts() -> None:
    os.makedirs(SECURITY_ALERT_DIR, exist_ok=True)
    tmp_path = SECURITY_ALERTS_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(_security_alerts, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, SECURITY_ALERTS_FILE)


def _store_security_alert(alert: dict) -> None:
    _security_alerts.append(alert)
    while len(_security_alerts) > max(1, SECURITY_ALERT_LIMIT):
        removed = _security_alerts.pop(0)
        screenshot = removed.get("screenshot")
        if screenshot:
            try:
                os.remove(os.path.join(SECURITY_ALERT_DIR, os.path.basename(screenshot)))
            except OSError:
                pass
    _persist_security_alerts()


def _public_security_alert(alert: dict) -> dict:
    return {
        key: value
        for key, value in alert.items()
        if key not in {"fingerprints", "screenshot"}
    } | {"has_screenshot": bool(alert.get("screenshot"))}


def _security_fingerprint(session_id: str, path: str, mtime: float) -> str:
    raw = f"{session_id}\0{path}\0{mtime:.6f}".encode("utf-8", "surrogatepass")
    return hashlib.sha256(raw).hexdigest()


def _security_reason(path: str) -> tuple[str, str]:
    """Return a Korean reason and severity for a suspicious filename."""
    name = os.path.basename(path).lower()
    risky = "|".join(re.escape(ext) for ext in SECURITY_EXTENSIONS)
    if risky and re.search(rf"\.[a-z0-9]{{1,8}}\.({risky})$", name):
        return "문서처럼 위장한 이중 확장자", "critical"
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    return f"실행 위험 확장자 .{ext}", "high"


def _parse_security_scan(stdout: str, session_id: str) -> list[dict]:
    """Parse base64(find -printf) output without breaking on spaces or newlines."""
    if not stdout:
        return []
    try:
        decoded = base64.b64decode(stdout, validate=True).decode("utf-8", "replace")
    except (BinasciiError, ValueError, UnicodeDecodeError):
        return []

    found: list[dict] = []
    for record in decoded.split("\0"):
        if not record:
            continue
        parts = record.split("\t", 2)
        if len(parts) != 3:
            continue
        try:
            mtime, size = float(parts[0]), int(parts[1])
        except ValueError:
            continue
        path = parts[2]
        reason, severity = _security_reason(path)
        found.append({
            "path": path,
            "size": size,
            "mtime": mtime,
            "reason": reason,
            "severity": severity,
            "fingerprint": _security_fingerprint(session_id, path, mtime),
        })
    return found


def _security_scan_command(container: str) -> str:
    minutes = max(2, (SECURITY_SCAN_LOOKBACK + 59) // 60)
    patterns = " -o ".join(f"-iname {shlex.quote('*.%s' % ext)}" for ext in SECURITY_EXTENSIONS)
    if not patterns:
        return "true"
    inner = (
        "find /home/kasm-user/Desktop /home/kasm-user/Downloads "
        "/home/kasm-user/받은파일 -xdev -type f "
        f"-mmin -{minutes} \\( {patterns} \\) "
        "-printf '%T@\\t%s\\t%p\\0' 2>/dev/null | head -z -n 100 | base64 -w0"
    )
    return f"docker exec {shlex.quote(container)} sh -lc {shlex.quote(inner)}"


async def _capture_container_screenshot(
    node_ip: str,
    ssh_user: str,
    container: str,
    alert_id: str,
) -> Optional[str]:
    """Capture a compact JPEG from the active Kasm X display and save it locally."""
    inner = (
        "export DISPLAY=${DISPLAY:-:1}; "
        "import -window root png:- 2>/dev/null | "
        "convert png:- -resize '1280x720>' -quality 70 jpg:- 2>/dev/null | base64 -w0"
    )
    stdout, rc = await _ssh(
        node_ip,
        f"docker exec {shlex.quote(container)} sh -lc {shlex.quote(inner)}",
        ssh_user,
    )
    if rc != 0 or not stdout:
        return None
    try:
        image = base64.b64decode(stdout, validate=True)
    except (BinasciiError, ValueError):
        return None
    if not image.startswith(b"\xff\xd8\xff") or len(image) > 3_000_000:
        return None

    os.makedirs(SECURITY_ALERT_DIR, exist_ok=True)
    filename = f"{alert_id}.jpg"
    with open(os.path.join(SECURITY_ALERT_DIR, filename), "wb") as f:
        f.write(image)
    return filename


async def _scan_session_security(session: dict, node: dict) -> Optional[dict]:
    if not SECURITY_SCAN_ENABLED or not SECURITY_EXTENSIONS:
        return None
    session_id = str(session.get("id") or "")
    if not session_id:
        return None
    container = _container_name(session_id)
    ssh_user = node.get("ssh_user", SSH_USER)
    stdout, rc = await _ssh(node["ip"], _security_scan_command(container), ssh_user)
    if rc != 0:
        return None

    already_seen = {
        fingerprint
        for alert in _security_alerts
        for fingerprint in (alert.get("fingerprints") or [])
    }
    files = [item for item in _parse_security_scan(stdout, session_id) if item["fingerprint"] not in already_seen]
    if not files:
        return None

    alert_id = uuid.uuid4().hex
    screenshot = await _capture_container_screenshot(
        node["ip"], ssh_user, container, alert_id
    )
    alert = {
        "id": alert_id,
        "created_at": time.time(),
        "session_id": session_id,
        "owner": session.get("owner", ""),
        "project_name": session.get("project_name", ""),
        "node_id": node.get("id", session.get("node_id", "")),
        "node_name": node.get("name", node.get("id", "")),
        "severity": "critical" if any(item["severity"] == "critical" for item in files) else "high",
        "files": [{k: v for k, v in item.items() if k != "fingerprint"} for item in files],
        "fingerprints": [item["fingerprint"] for item in files],
        "screenshot": screenshot,
        "acknowledged": False,
    }
    _store_security_alert(alert)
    logger.warning(
        "[security] %s 세션에서 위험 파일 %d개 감지 (owner=%s, node=%s)",
        session_id,
        len(files),
        alert["owner"],
        alert["node_id"],
    )
    return alert


async def _write_log():
    os.makedirs(LOG_DIR, exist_ok=True)
    now = datetime.now()
    log_path = os.path.join(LOG_DIR, now.strftime("%Y-%m-%d") + ".log")

    nodes_list = await _get_nodes()
    nodes = {n["id"]: n for n in nodes_list}

    # 세션 정보 — 인메모리 캐시에서 읽음 (Firestore 호출 없음)
    active_sessions = [{"id": sid, **s} for sid, s in _sc_list(status=["active", "starting"])]
    suspended_sessions = [{"id": sid, **s} for sid, s in _sc_list(status="suspended")]

    # 활성 세션별 컨테이너 top3 (병렬)
    session_top3: dict[str, list[str]] = {}
    if active_sessions:
        top3_results = await asyncio.gather(
            *[
                _get_container_top3(
                    nodes[s["node_id"]]["ip"],
                    nodes[s["node_id"]].get("ssh_user", SSH_USER),
                    _container_name(s["id"]),
                )
                for s in active_sessions
                if s.get("node_id") in nodes
            ],
            return_exceptions=True,
        )
        idx = 0
        for s in active_sessions:
            if s.get("node_id") in nodes:
                r = top3_results[idx]
                session_top3[s["id"]] = r if isinstance(r, list) else []
                idx += 1

    # 최근 위험 파일 검사도 세션별로 병렬 수행한다. 실패한 노드는 로그 작성을 막지 않는다.
    security_alerts: list[dict] = []
    if SECURITY_SCAN_ENABLED and active_sessions:
        scan_results = await asyncio.gather(
            *[
                _scan_session_security(s, nodes[s["node_id"]])
                for s in active_sessions
                if s.get("node_id") in nodes
            ],
            return_exceptions=True,
        )
        security_alerts = [result for result in scan_results if isinstance(result, dict)]

    lines = [f"=== {now.strftime('%Y-%m-%d %H:%M:%S')} ===", ""]

    lines.append(f"[노드 상태] ({len(nodes)}대)")
    for nid, node in sorted(nodes.items()):
        m = _metrics.get(nid, {})
        if m.get("offline"):
            lines.append(f"  {nid} ({node.get('name', '')}): OFFLINE")
        elif not m:
            lines.append(f"  {nid} ({node.get('name', '')}): 미조회")
        else:
            lines.append(
                f"  {nid} ({node.get('name', '')}): "
                f"CPU {m.get('cpu', '?')}% | "
                f"RAM {m.get('ram_used_gb', '?')}/{m.get('ram_total_gb', '?')}GB | "
                f"GPU {m.get('gpu', '?')}% | "
                f"kasm {m.get('kasm_running', '?')}세션"
            )

    lines.append("")
    lines.append(f"[활성 세션] {len(active_sessions)}개")
    for s in active_sessions:
        top3 = session_top3.get(s["id"], [])
        lines.append(
            f"  [{s['id']}] {s.get('owner', '?')} @ {s.get('node_id', '?')}"
            f" ({s.get('status', '?')})"
        )
        lines.append(f"    프로세스: {', '.join(top3) if top3 else '없음'}")

    lines.append("")
    lines.append(f"[저장된 세션] {len(suspended_sessions)}개")
    for s in suspended_sessions:
        ts = s.get("suspended_at")
        saved = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "?"
        lines.append(
            f"  [{s['id']}] {s.get('owner', '?')} @ {s.get('node_id', '?')}"
            f" (저장: {saved})"
        )

    lines.append("")
    lines.append(f"[보안 경고] 신규 {len(security_alerts)}건")
    for alert in security_alerts:
        lines.append(
            f"  [{alert['session_id']}] {alert.get('owner', '?')} @ {alert.get('node_id', '?')}"
            f" — 위험 파일 {len(alert.get('files', []))}개"
        )
        for item in alert.get("files", []):
            lines.append(f"    {item.get('path', '?')} ({item.get('reason', '확인 필요')})")

    lines.append("")

    with open(log_path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


async def _log_loop():
    await asyncio.sleep(LOG_INTERVAL)  # 첫 실행은 10분 후
    while True:
        try:
            await _write_log()
        except Exception as e:
            logger.error("_write_log 실패: %s", e)
        await asyncio.sleep(LOG_INTERVAL)


# ── Email notification loop ───────────────────────────────────────────────────


async def _check_and_send_warnings() -> None:
    """active/starting 세션 중 7일 내 만료 예정이고 경고 미발송인 세션에 이메일 발송."""
    now = time.time()
    for sid, s in _sc_list(status=["active", "starting"]):
        expires_at = s.get("expires_at")
        sent_to = set(s.get("warning_email_sent_to") or [])
        if not expires_at or s.get("warning_email_sent"):
            continue
        if expires_at - now <= WARNING_SECONDS:
            recipients = _session_email_recipients(s)
            pending = [email for email in recipients if email not in sent_to]
            if pending:
                batch = await _send_session_email("warning", sid, s, recipients=pending, event_at=now)
                sent_to.update(batch.successful_recipients)
            complete = bool(recipients) and all(email in sent_to for email in recipients)
            updates = {
                "warning_email_sent": complete,
                "warning_email_sent_to": sorted(sent_to),
            }
            _sc_update(sid, updates)
            await db.collection(COL_SESSIONS).document(sid).update(updates)


async def _email_notification_loop():
    await asyncio.sleep(60)  # 서버 시작 후 1분 뒤 첫 실행
    while True:
        try:
            await _check_and_send_warnings()
        except Exception:
            logger.exception("[email-loop] 만료 경고 처리 실패")
        await asyncio.sleep(EMAIL_CHECK_INTERVAL)


# ── Reboot loop ───────────────────────────────────────────────────────────────


def _seconds_until_3am_kst() -> float:
    """다음 KST 03:00까지 남은 초."""
    kst_3am = 3 * 3600
    now_kst_in_day = (time.time() + KST_OFFSET) % 86400
    if now_kst_in_day < kst_3am:
        return kst_3am - now_kst_in_day
    return 86400 - now_kst_in_day + kst_3am


async def _verify_node_after_reboot(node_id: str, node_ip: str, ssh_user: str) -> None:
    """재부팅 후 tailscale·nginx·kasm-tunnel 정상 작동 확인. 30초마다 폴링."""
    logger.info("[reboot] %s: 재부팅 후 서비스 확인 시작 (최대 %ds)", node_id, REBOOT_VERIFY_TIMEOUT)
    deadline = time.time() + REBOOT_VERIFY_TIMEOUT
    while time.time() < deadline:
        await asyncio.sleep(30)
        m = await _collect_metrics(node_id, node_ip, ssh_user)
        if m.get("offline"):
            continue
        _metrics[node_id] = m
        nginx_ok     = m.get("svc_nginx") == "active"
        tunnel_ok    = m.get("svc_tunnel") == "active"
        tailscale_ok = m.get("svc_tailscale") == "active"
        if nginx_ok and tunnel_ok and tailscale_ok:
            logger.info(
                "[reboot] %s: 재부팅 완료 — 모든 서비스 정상 (가동 %.0fs)",
                node_id, m.get("uptime_seconds", 0),
            )
            _reboot_pending.pop(node_id, None)
            return
        # 아직 미기동 서비스 재시작 시도
        cmds = []
        if not nginx_ok:
            cmds.append("sudo systemctl start nginx")
        if not tunnel_ok:
            cmds.append("sudo systemctl start kasm-tunnel")
        if cmds:
            logger.warning("[reboot] %s: 부팅 후 서비스 불완전 — 재시작 시도", node_id)
            await _ssh(node_ip, " && ".join(cmds), ssh_user)
    logger.error("[reboot] %s: 서비스 확인 타임아웃 (%ds 경과)", node_id, REBOOT_VERIFY_TIMEOUT)
    _reboot_pending.pop(node_id, None)


async def _reboot_loop() -> None:
    """매일 KST 03:00에 REBOOT_UPTIME_DAYS일 이상 가동된 유휴 노드를 재부팅한다."""
    while True:
        wait = _seconds_until_3am_kst()
        logger.info("[reboot] 다음 재부팅 점검까지 %.0f초 대기 (KST 03:00)", wait)
        await asyncio.sleep(wait)
        try:
            nodes = await _get_nodes()
            threshold = REBOOT_UPTIME_DAYS * 86400
            for node in nodes:
                nid      = node["id"]
                node_ip  = node["ip"]
                ssh_user = node.get("ssh_user", SSH_USER)

                # 활성·시작 중 세션 있으면 건너뜀
                active = [s for _, s in _sc_list(status=["active", "starting"]) if s.get("node_id") == nid]
                if active:
                    logger.info("[reboot] %s: 활성 세션 %d개 → 건너뜀", nid, len(active))
                    continue

                m = _metrics.get(nid, {})
                if m.get("offline"):
                    logger.info("[reboot] %s: 오프라인 → 건너뜀", nid)
                    continue

                uptime_s = m.get("uptime_seconds", 0)
                if uptime_s < threshold:
                    logger.info("[reboot] %s: 가동 %.1f일 < %d일 → 건너뜀", nid, uptime_s / 86400, REBOOT_UPTIME_DAYS)
                    continue

                logger.info("[reboot] %s: 가동 %.1f일 ≥ %d일, 세션 없음 → 재부팅 명령 전송", nid, uptime_s / 86400, REBOOT_UPTIME_DAYS)
                await _ssh(node_ip, "sudo reboot", ssh_user)
                _reboot_pending[nid] = time.time()
                asyncio.create_task(_verify_node_after_reboot(nid, node_ip, ssh_user))
        except Exception as e:
            logger.error("[reboot] 루프 오류: %s", e)
        await asyncio.sleep(60)  # 실행 직후 1분 대기 후 다음 루프에서 다음 3시까지 재슬립


# ── App ───────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_security_alerts()
    await _init_sessions_cache()
    poll_task   = asyncio.create_task(_poll_nodes_loop())
    log_task    = asyncio.create_task(_log_loop())
    email_task  = asyncio.create_task(_email_notification_loop())
    reboot_task = asyncio.create_task(_reboot_loop())
    yield
    for t in (poll_task, log_task, email_task, reboot_task):
        t.cancel()
        try:
            await t
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
    for n in _nodes_cache:
        if n["id"] == node_id:
            return n
    doc = await db.collection(COL_NODES).document(node_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return {"id": doc.id, **doc.to_dict()}


async def _get_user_max_sessions(email: str) -> int:
    doc = await db.collection(COL_USERS).document(email).get()
    return doc.to_dict().get("max_sessions", 1) if doc.exists else 1


def _count_active_sessions(email: str) -> int:
    return len(_sc_list(owner=email, status=["active", "starting"]))


async def _docker_status(ip: str, ssh_user: str, container: str) -> str:
    """Direct SSH check for specific container status."""
    stdout, rc = await _ssh(ip, _docker_status_cmd(container), ssh_user)
    return stdout if rc == 0 and stdout else "none"


def _container_name(session_id: str) -> str:
    return f"kasm_{session_id}"


def _resource_limits_for_node(node: dict, n_sessions: int) -> tuple[float, float]:
    """노드 90% 용량을 n_sessions 등분. (cpu_per, ram_gb_per) 반환."""
    if n_sessions <= 0:
        return (0.0, 0.0)
    cpu_per = round(node.get("cpu_cores", 0) * 0.9 / n_sessions, 2)
    ram_per = round(node.get("ram_gb", 0) * 0.9 / n_sessions, 1)
    return (cpu_per, ram_per)


async def _update_node_container_limits(
    node_ip: str, ssh_user: str, containers: list[str], cpu: float, ram_gb: float
) -> None:
    """실행 중인 컨테이너들에 docker update로 리소스 한도 재적용."""
    if not containers or cpu <= 0 or ram_gb <= 0:
        return
    names = " ".join(containers)
    cmd = f"docker update --cpus {cpu} --memory {ram_gb}g {names} 2>&1 || true"
    await _ssh(node_ip, cmd, ssh_user)

def _session_url(session_id: str, kasm_url: str) -> str:
    return f"{kasm_url.rstrip('/')}/{session_id}/?path={session_id}/websockify"

def _terminal_url(session_id: str, kasm_url: str) -> str:
    return f"{kasm_url.rstrip('/')}/{session_id}/terminal/"

def _ttyd_port(vnc_port: int) -> int:
    return vnc_port + 200  # VNC: 8081-8199, ttyd: 8281-8399

async def _allocate_port(node_id: str, node_ip: str, ssh_user: str) -> int:
    used = {s.get("port") for _, s in _sc_list(status=["active", "starting", "suspended"]) if s.get("node_id") == node_id and s.get("port")}
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
    location /{session_id}/terminal/ {{
        proxy_pass http://localhost:{ttyd_port}/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Accept-Encoding "";
        proxy_buffering off;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
        sub_filter '</head>' '<script>document.addEventListener("keydown",function(e){{if(e.isComposing||e.key==="Process"){{e.stopImmediatePropagation();e.preventDefault();}}}}  ,true);</script></head>';
        sub_filter_once on;
    }}
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
    domain = kasm_url.removeprefix("https://").rstrip("/")
    locations = [
        _NGINX_LOCATION.format(session_id=sid, port=s["port"], ttyd_port=_ttyd_port(s["port"]))
        for sid, s in _sc_list(status=["active", "starting", "suspended"])
        if s.get("node_id") == node_id and s.get("port")
    ]
    inner = "\n".join(locations) if locations else "    # no sessions"
    config = (
        f"server {{\n"
        f"    listen 80;\n"
        f"    server_name {domain};\n"
        f"    client_max_body_size 500M;\n"
        f"    location /upload {{\n"
        f"        proxy_pass http://localhost:8100;\n"
        f"        proxy_read_timeout 600;\n"
        f"    }}\n"
        f"{inner}\n"
        f"}}"
    )
    b64 = base64.b64encode(config.encode()).decode()
    cmd = (
        f"echo {b64} | base64 -d > /home/{ssh_user}/.nginx-kasm.conf "
        f"&& sudo nginx -s reload"
    )
    await _ssh(node_ip, cmd, ssh_user)


def _node_session_state(node_id: str, sessions: list[dict]) -> str:
    active_count = 0
    has_suspended = False
    for s in sessions:
        if s.get("node_id") != node_id:
            continue
        if s.get("status") in ("active", "starting"):
            active_count += 1
        elif s.get("status") == "suspended":
            has_suspended = True
    if active_count >= 2:
        return "full"
    if active_count == 1:
        return "partial"
    if has_suspended:
        return "suspended"
    return "none"


def _node_resource_used(node_id: str, sessions: list[dict]) -> dict:
    cpu_sum = ram_sum = 0
    for s in sessions:
        if s.get("node_id") == node_id and s.get("status") in ("active", "starting"):
            r = s.get("resources") or {}
            cpu_sum += r.get("cpu_cores", 0)
            ram_sum += r.get("ram_gb", 0)
    return {"cpu_cores": cpu_sum, "ram_gb": ram_sum}


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


# ── Email ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EmailContent:
    subject: str
    text: str
    html: str


@dataclass(frozen=True)
class EmailSendResult:
    state: Literal["sent", "skipped", "failed"]
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.state == "sent"


EmailKind = Literal[
    "created",
    "resumed",
    "warning",
    "auto_suspend",
    "suspend",
    "admin_suspend",
    "unexpected_stop",
    "delete",
]


@dataclass(frozen=True)
class EmailBatchResult:
    results: dict[str, EmailSendResult]

    @property
    def successful_recipients(self) -> list[str]:
        return [email for email, result in self.results.items() if result.ok]

    @property
    def ok(self) -> bool:
        return bool(self.results) and all(result.ok for result in self.results.values())


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalise_email(value: object) -> Optional[str]:
    email = str(value or "").strip().lower()
    return email if email and _EMAIL_RE.fullmatch(email) else None


def _session_email_recipients(session: dict) -> list[str]:
    """세션 소유자와 팀원을 순서대로 중복 제거해 반환한다."""
    members = session.get("team_members") or []
    if isinstance(members, str):
        members = [members]
    candidates = [session.get("owner"), *members]
    recipients: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        email = _normalise_email(candidate)
        if email and email not in seen:
            seen.add(email)
            recipients.append(email)
    return recipients


def _email_runtime_status() -> dict:
    token_exists = bool(GMAIL_TOKEN) and os.path.exists(GMAIL_TOKEN)
    creds_exists = bool(GMAIL_CREDENTIALS) and os.path.exists(GMAIL_CREDENTIALS)
    warnings: list[str] = []
    if not GMAIL_SENDER:
        warnings.append("GMAIL_SENDER가 설정되지 않았습니다.")
    if not GMAIL_TOKEN:
        warnings.append("GMAIL_TOKEN이 설정되지 않았습니다.")
    elif not token_exists:
        warnings.append("GMAIL_TOKEN 파일을 찾을 수 없습니다.")
    if GMAIL_CREDENTIALS and not creds_exists:
        warnings.append("GMAIL_CREDENTIALS 파일을 찾을 수 없습니다.")
    return {
        "can_send": bool(GMAIL_SENDER and token_exists),
        "sender": GMAIL_SENDER,
        "token_configured": bool(GMAIL_TOKEN),
        "token_exists": token_exists,
        "credentials_configured": bool(GMAIL_CREDENTIALS),
        "credentials_exists": creds_exists,
        "check_interval_seconds": EMAIL_CHECK_INTERVAL,
        "portal_url": PORTAL_URL,
        "brand": EMAIL_BRAND,
        "supported_events": [
            "created",
            "resumed",
            "warning",
            "auto_suspend",
            "suspend",
            "admin_suspend",
            "unexpected_stop",
            "delete",
        ],
        "warnings": warnings,
    }


def _email_display_brand() -> str:
    return EMAIL_BRAND.upper()


def _format_email_ts(ts: Optional[float]) -> str:
    if not ts:
        return "-"
    kst = timezone(timedelta(hours=9), name="KST")
    return datetime.fromtimestamp(ts, tz=kst).strftime("%Y.%m.%d %H:%M KST")


def _email_html_block(text: str) -> str:
    return "<br/>".join(html.escape(line) for line in text.splitlines()) if text else ""


def _render_email_html(
    *,
    status_label: str,
    title: str,
    summary: str,
    tone: Literal["info", "warning", "danger", "success"] = "info",
    facts: Optional[list[tuple[str, str]]] = None,
    cta_label: Optional[str] = None,
    cta_url: Optional[str] = None,
) -> str:
    tone_map = {
        "info": ("#445064", "#eef1f5", "#d7dce4"),
        "warning": ("#8a5d00", "#fff7df", "#ead39a"),
        "danger": ("#8f2727", "#fff0ee", "#e9bbb6"),
        "success": ("#266145", "#edf8f1", "#bddfc9"),
    }
    accent, tint, tint_border = tone_map[tone]
    facts_html = "".join(
        (
            "<tr>"
            f"<td width='34%' style='padding:12px 14px;border-bottom:1px solid #e7e8e9;"
            "color:#777c83;font-size:12px;line-height:1.5;'>"
            f"{html.escape(label)}</td>"
            "<td style='padding:12px 14px;border-bottom:1px solid #e7e8e9;"
            "color:#17191c;font-size:13px;font-weight:600;line-height:1.5;word-break:break-word;'>"
            f"{html.escape(value)}</td>"
            "</tr>"
        )
        for label, value in (facts or [])
        if value
    )
    cta_html = ""
    if cta_label and cta_url:
        cta_html = (
            "<table role='presentation' cellspacing='0' cellpadding='0' border='0' style='margin-top:26px;'>"
            "<tr><td style='border-radius:3px;background:#17191c;'>"
            f"<a href='{html.escape(cta_url, quote=True)}' style='display:inline-block;padding:13px 18px;"
            "color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:-.01em;'>"
            f"{html.escape(cta_label)}&nbsp;&nbsp;→</a></td></tr></table>"
        )
    preheader = html.escape(summary.replace("\n", " ")[:110])
    return (
        "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' "
        "content='width=device-width,initial-scale=1'><style>"
        "@media(max-width:640px){.mail-wrap{padding:18px 10px!important}.mail-card{width:100%!important}"
        ".mail-head,.mail-body{padding-left:22px!important;padding-right:22px!important}.mail-title{font-size:27px!important}}"
        "</style></head><body style='margin:0;padding:0;background:#f3f3f1;color:#17191c;'>"
        f"<div style='display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;'>{preheader}</div>"
        "<table role='presentation' width='100%' cellspacing='0' cellpadding='0' border='0' style='width:100%;background:#f3f3f1;'>"
        "<tr><td class='mail-wrap' align='center' style='padding:38px 16px;'>"
        "<table role='presentation' class='mail-card' width='640' cellspacing='0' cellpadding='0' border='0' "
        "style='width:640px;max-width:640px;background:#ffffff;border:1px solid #dedfdf;border-collapse:separate;"
        "border-spacing:0;border-radius:14px;overflow:hidden;box-shadow:0 18px 55px rgba(23,25,28,.08);'>"
        f"<tr><td style='height:4px;background:{accent};font-size:0;line-height:0;'>&nbsp;</td></tr>"
        "<tr><td class='mail-head' style='padding:25px 34px 22px;border-bottom:1px solid #e7e8e9;'>"
        "<table role='presentation' width='100%' cellspacing='0' cellpadding='0' border='0'><tr>"
        f"<td style='font-family:Arial,Malgun Gothic,sans-serif;color:#17191c;font-size:17px;font-weight:800;"
        f"letter-spacing:-.02em;'>{html.escape(_email_display_brand())}</td>"
        f"<td align='right'><span style='display:inline-block;padding:7px 10px;border:1px solid {tint_border};"
        f"border-radius:999px;background:{tint};color:{accent};font-family:Arial,Malgun Gothic,sans-serif;"
        f"font-size:11px;font-weight:700;'>{html.escape(status_label)}</span></td>"
        "</tr></table></td></tr>"
        "<tr><td class='mail-body' style='padding:34px;font-family:Arial,Apple SD Gothic Neo,Malgun Gothic,sans-serif;'>"
        "<div style='margin:0 0 12px;color:#8a8e93;font-size:11px;font-weight:700;letter-spacing:.13em;'>SESSION NOTICE</div>"
        f"<h1 class='mail-title' style='margin:0;color:#17191c;font-family:Georgia,Malgun Gothic,serif;"
        f"font-size:32px;font-weight:700;line-height:1.28;letter-spacing:-.035em;'>{html.escape(title)}</h1>"
        f"<p style='margin:18px 0 24px;color:#4e535a;font-size:14px;line-height:1.85;letter-spacing:-.01em;'>"
        f"{_email_html_block(summary)}</p>"
        "<table role='presentation' width='100%' cellspacing='0' cellpadding='0' border='0' "
        "style='width:100%;border:1px solid #e1e2e3;border-collapse:separate;border-spacing:0;border-radius:7px;overflow:hidden;'>"
        f"{facts_html}</table>"
        f"{cta_html}"
        "<p style='margin:28px 0 0;padding-top:18px;border-top:1px solid #ececed;color:#8a8e93;font-size:11px;line-height:1.7;'>"
        "본 메일은 PC 대여 포털의 세션 상태 변경에 따라 자동 발송되었습니다.<br>"
        f"문의가 필요하면 {html.escape(_email_display_brand())}에 연락해 주세요.</p>"
        "</td></tr></table></td></tr></table></body></html>"
    )


def _build_session_email(
    kind: EmailKind,
    session_id: str,
    project_name: Optional[str] = None,
    expires_at: Optional[float] = None,
    event_at: Optional[float] = None,
    reason: Optional[str] = None,
    actor: Optional[str] = None,
) -> EmailContent:
    project = project_name or session_id or "이름 없는 세션"
    expires_when = _format_email_ts(expires_at)
    event_when = _format_email_ts(event_at or time.time())
    facts = [("세션", project), ("세션 ID", session_id)]
    actor_label = (actor or "").strip()
    subject: str
    title: str
    status_label: str
    summary: str
    tone: Literal["info", "warning", "danger", "success"]
    cta_label: Optional[str] = "포털에서 확인하기"

    if kind == "created":
        subject = "[PC대여] 새 세션 준비를 시작했습니다"
        title = "새 작업 공간을 준비하고 있어요"
        status_label = "준비 중"
        summary = f"'{project}' 세션 생성 요청이 정상적으로 접수되었습니다.\n준비가 끝나면 포털에서 바로 접속할 수 있습니다."
        tone = "success"
        if expires_at:
            facts.append(("사용 종료 예정", expires_when))
    elif kind == "resumed":
        subject = "[PC대여] 세션을 다시 시작했습니다"
        title = "작업 공간을 다시 여는 중이에요"
        status_label = "재개 중"
        summary = f"보관 중이던 '{project}' 세션을 다시 시작했습니다.\n잠시 후 포털에서 이어서 작업할 수 있습니다."
        tone = "info"
    if kind == "warning":
        subject = "[PC대여] 세션이 7일 후 자동 일시중지됩니다"
        title = "세션 만료가 7일 남았습니다"
        status_label = "만료 예정"
        summary = (
            f"'{project}' 세션이 {expires_when}에 자동으로 일시중지될 예정입니다.\n"
            "계속 사용하시려면 포털에서 이어서 사용을 눌러주세요."
        )
        tone = "warning"
        facts.append(("일시중지 예정", expires_when))
        cta_label = "포털에서 기간 확인하기"
    elif kind == "auto_suspend":
        subject = "[PC대여] 세션이 만료되어 일시중지되었습니다"
        title = "세션을 안전하게 보관했습니다"
        status_label = "자동 보관"
        summary = (
            f"'{project}' 세션이 대여 기간 만료로 자동 일시중지되었습니다.\n"
            "포털에서 이어서 사용을 눌러 다시 시작할 수 있습니다."
        )
        tone = "warning"
        if expires_at:
            facts.append(("만료 시각", expires_when))
        cta_label = "보관된 세션 이어서 사용"
    elif kind == "suspend":
        subject = "[PC대여] 세션을 일시중지했습니다"
        title = "작업 공간을 보관했습니다"
        status_label = "일시중지"
        summary = (
            f"'{project}' 세션이{f' {actor_label}의 요청으로' if actor_label else ''} 일시중지되었습니다.\n"
            "포털에서 이어서 사용을 눌러 다시 시작할 수 있습니다."
        )
        tone = "info"
        cta_label = "보관된 세션 이어서 사용"
    elif kind == "admin_suspend":
        subject = "[PC대여] 관리자에 의해 세션이 일시중지되었습니다"
        title = "관리자가 세션을 보관했습니다"
        status_label = "관리자 조치"
        summary = (
            f"'{project}' 세션이 {actor_label or '관리자'}에 의해 일시중지되었습니다.\n"
            "필요한 경우 포털에서 다시 시작하거나 전산실에 문의해 주세요."
        )
        tone = "warning"
    elif kind == "unexpected_stop":
        subject = "[PC대여] 세션이 예기치 않게 중지되었습니다"
        title = "세션 상태를 확인해 주세요"
        status_label = "확인 필요"
        detail = reason or "실행 중이던 컴퓨터 환경이 예기치 않게 중지되었습니다."
        summary = f"'{project}' 세션을 정상적으로 실행할 수 없는 상태입니다.\n{detail}\n포털에서 다시 시작되지 않으면 전산실에 문의해 주세요."
        tone = "danger"
    elif kind == "delete":
        subject = "[PC대여] 세션이 삭제되었습니다"
        title = "세션 삭제가 완료되었습니다"
        status_label = "삭제 완료"
        summary = f"'{project}' 세션이{f' {actor_label}의 요청으로' if actor_label else ''} 완전히 삭제되었습니다."
        tone = "danger"
        cta_label = "포털로 이동"
    elif kind not in ("created", "resumed", "warning"):
        raise ValueError(f"지원하지 않는 이메일 종류입니다: {kind}")

    if actor_label:
        facts.append(("처리한 사람", actor_label))
    facts.append(("처리 시각", event_when))
    plain_facts = "\n".join(f"- {label}: {value}" for label, value in facts)
    text = (
        f"안녕하세요.\n\n{summary}\n\n{plain_facts}\n\n"
        f"포털: {PORTAL_URL}\n\n"
        f"본 메일은 자동 발송되었습니다.\n- {_email_display_brand()}"
    )
    return EmailContent(
        subject=subject,
        text=text,
        html=_render_email_html(
            status_label=status_label,
            title=title,
            summary=summary,
            tone=tone,
            facts=facts,
            cta_label=cta_label,
            cta_url=PORTAL_URL,
        ),
    )


def _build_gmail_service():
    """OAuth2 token.json으로 Gmail API 서비스 객체 생성. 미설정/만료 시 None 반환."""
    if not GMAIL_TOKEN or not os.path.exists(GMAIL_TOKEN):
        return None
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        creds = Credentials.from_authorized_user_file(
            GMAIL_TOKEN,
            ["https://www.googleapis.com/auth/gmail.send"],
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(GMAIL_TOKEN, "w") as f:
                f.write(creds.to_json())
        return build("gmail", "v1", credentials=creds, cache_discovery=False)
    except Exception as e:
        logger.warning("[gmail] 서비스 초기화 실패: %s", e)
        return None


async def _send_email(
    to: str,
    subject: str,
    text_body: str,
    html_body: Optional[str] = None,
) -> EmailSendResult:
    """Gmail API로 이메일 발송. 실패해도 세션 로직에 영향 없음."""
    if not GMAIL_SENDER or not to:
        return EmailSendResult("skipped", "sender-or-recipient-missing")
    recipient = _normalise_email(to)
    sender = _normalise_email(GMAIL_SENDER)
    if not recipient or not sender:
        return EmailSendResult("failed", "invalid-sender-or-recipient")
    try:
        import email.mime.multipart as _multipart
        import email.mime.text as _mime
        import email.utils as _utils
        service = _build_gmail_service()
        if not service:
            return EmailSendResult("skipped", "gmail-service-unavailable")
        msg = _multipart.MIMEMultipart("alternative")
        msg["To"] = recipient
        msg["From"] = _utils.formataddr((_email_display_brand(), sender))
        msg["Reply-To"] = sender
        msg["Subject"] = subject.replace("\r", " ").replace("\n", " ")
        msg["Auto-Submitted"] = "auto-generated"
        msg["X-Auto-Response-Suppress"] = "All"
        msg.attach(_mime.MIMEText(text_body, "plain", "utf-8"))
        if html_body:
            msg.attach(_mime.MIMEText(html_body, "html", "utf-8"))
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None,
            lambda: service.users().messages().send(
                userId="me", body={"raw": raw}
            ).execute(),
        )
        return EmailSendResult("sent", str((response or {}).get("id", "")))
    except Exception as e:
        logger.warning("[email] 발송 실패 (%s): %s", recipient, e)
        return EmailSendResult("failed", str(e))


async def _send_session_email(
    kind: EmailKind,
    session_id: str,
    session: dict,
    *,
    recipients: Optional[list[str]] = None,
    event_at: Optional[float] = None,
    reason: Optional[str] = None,
    actor: Optional[str] = None,
) -> EmailBatchResult:
    """세션 소유자와 팀원에게 동일한 알림을 개별 발송한다."""
    targets = recipients if recipients is not None else _session_email_recipients(session)
    deduped_targets: list[str] = []
    seen: set[str] = set()
    for target in targets:
        email = _normalise_email(target)
        if email and email not in seen:
            seen.add(email)
            deduped_targets.append(email)

    content = _build_session_email(
        kind,
        session_id,
        session.get("project_name"),
        session.get("expires_at"),
        event_at=event_at,
        reason=reason,
        actor=actor,
    )
    results: dict[str, EmailSendResult] = {}
    for target in deduped_targets:
        result = await _send_email(target, content.subject, content.text, content.html)
        results[target] = result
        if not result.ok:
            logger.warning(
                "[email] 세션 알림 미발송 kind=%s sid=%s to=%s state=%s detail=%s",
                kind,
                session_id,
                target,
                result.state,
                result.detail,
            )
    if not results:
        logger.warning("[email] 세션 알림 수신자 없음 kind=%s sid=%s", kind, session_id)
    return EmailBatchResult(results)


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
    nodes = await _get_nodes()
    sessions = [s for _, s in _sc_list(status=["active", "starting", "suspended"])]

    result = []
    for n in nodes:
        if cpu_cores is not None and n.get("cpu_cores", 0) < cpu_cores:
            continue
        if ram_gb is not None and n.get("ram_gb", 0) < ram_gb:
            continue
        if storage_gb is not None and n.get("storage_gb", 0) < storage_gb:
            continue
        if gpu is not None and n.get("gpu_type", "none") != gpu:
            continue

        state = _node_session_state(n["id"], sessions)
        res_used = _node_resource_used(n["id"], sessions)
        m = _metrics.get(n["id"], {})
        ram_total = m.get("ram_total_gb") or n.get("ram_gb") or 0
        load = None if m.get("offline") or not m else {
            "cpu_pct": m.get("cpu"),
            "ram_pct": round(m["ram_used_gb"] / ram_total * 100, 1) if ram_total else None,
            "gpu_pct": m.get("gpu"),
        }
        sc = 2 if state == "full" else (1 if state == "partial" else 0)
        result.append({
            "id": n["id"],
            "name": n.get("name", n["id"]),
            "cpu": n.get("cpu", ""),
            "cpu_cores": n.get("cpu_cores", 0),
            "gpu": n.get("gpu", ""),
            "ram_gb": n.get("ram_gb", 0),
            "storage_gb": n.get("storage_gb", 0),
            "available": state not in ("full",),
            "offline": m.get("offline", not bool(m)),
            "session_state": state,
            "session_count": sc,
            "resource_used": res_used,
            "load": load,
        })

    return {"nodes": result}


@app.get("/node_specs", dependencies=[Depends(require_key)])
async def node_specs():
    """Legacy single-node spec endpoint."""
    nodes = await _get_nodes()
    if not nodes:
        return {
            "id": "server-01", "name": "1호기",
            "cpu": "Intel Core i7", "gpu": "NVIDIA GTX 1660",
            "ram_gb": 32, "storage_gb": 500, "available": True, "session_state": "none",
        }
    n = nodes[0]
    sessions = [s for _, s in _sc_list(status=["active", "starting", "suspended"])]
    state = _node_session_state(n["id"], sessions)
    return {
        "id": n["id"], **{k: v for k, v in n.items() if k != "id"},
        "available": state != "active",
        "session_state": state,
    }


# ── Routes: sessions ──────────────────────────────────────────────────────────


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
        pass  # 사용 기록 적재 실패는 본 흐름을 막지 않는다


class SessionBody(BaseModel):
    node_id: Optional[str] = None
    project_name: Optional[str] = None
    team_members: Optional[list[str]] = None
    resources: Optional[dict] = None
    duration_days: Optional[int] = 7
    work_type: Optional[str] = None
    replace_session_id: Optional[str] = None
    behalf_of: Optional[str] = None  # admin only


class EmailPreviewBody(BaseModel):
    kind: EmailKind = "warning"
    to: Optional[str] = None
    session_id: Optional[str] = None
    project_name: Optional[str] = None
    expires_at: Optional[float] = None
    event_at: Optional[float] = None
    reason: Optional[str] = None
    actor: Optional[str] = None


class SecurityAlertUpdate(BaseModel):
    acknowledged: bool = True


@app.get("/session", dependencies=[Depends(require_key), Depends(require_user)])
async def get_session(
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    me = x_user_email.lower()
    active = _sc_list(owner=me, status=["active", "starting"])
    suspended = _sc_list(owner=me, status="suspended")

    now_ts = time.time()
    suspended_sessions = []
    for sid, s in suspended:
        orig = s.get("original_created_at") or s.get("created_at", 0)
        # 최소 1일로 재개해도 40일 초과 여부 체크
        s_extend_blocked = (not s.get("extend_unlocked", False)) and \
            ((now_ts + 86400 - orig) / 86400 >= 40)
        suspended_sessions.append({
            "id": sid,
            "project_name": s.get("project_name", ""),
            "saved_at": s.get("suspended_at") or s.get("created_at", 0),
            "team_members": s.get("team_members", []),
            "resources": s.get("resources", {}),
            "original_created_at": orig,
            "extend_blocked": s_extend_blocked,
        })

    if not active:
        return {"status": "none", "suspended_sessions": suspended_sessions}

    session_id, s = active[0]
    node = await _get_node(s["node_id"])
    _suser = node.get("ssh_user", SSH_USER)
    dock = await _docker_status(node["ip"], _suser, _container_name(session_id))

    meta = {
        "project_name": s.get("project_name", ""),
        "work_type": s.get("work_type", ""),
        "node_id": s["node_id"],
        "node_name": node.get("name", s["node_id"]),
        "node_gpu": node.get("gpu", ""),
        "node_ip": node.get("ip", ""),
    }

    if dock == "running":
        _kasm_url = node.get("kasm_url", "https://kasm.dshs-app.net")
        url = _session_url(session_id, _kasm_url)
        orig = s.get("original_created_at") or s.get("created_at", time.time())
        expires = s.get("expires_at", time.time())
        extend_blocked = (not s.get("extend_unlocked", False)) and \
            ((expires + 86400 - orig) / 86400 > 40)
        return {
            "status": "ready",
            "session_id": session_id,
            "url": url,
            "terminal_url": _terminal_url(session_id, _kasm_url),
            "expires_at": expires,
            "original_created_at": orig,
            "extend_blocked": extend_blocked,
            "suspended_sessions": suspended_sessions,
            **meta,
        }

    if dock in ("none", "dead"):
        # 컨테이너가 없거나 완전히 죽음 — stale 세션 정리
        _sc_del(session_id)
        await db.collection(COL_SESSIONS).document(session_id).delete()
        await _send_session_email(
            "unexpected_stop",
            session_id,
            s,
            reason="실행 환경을 찾을 수 없어 세션 기록을 정리했습니다.",
            actor="시스템 · 상태 감지",
        )
        return {"status": "none", "suspended_sessions": suspended_sessions}

    if dock == "exited":
        # 컨테이너가 중지됨 — suspended로 전환
        _sc_update(session_id, {"status": "suspended", "suspended_at": time.time()})
        await db.collection(COL_SESSIONS).document(session_id).update({
            "status": "suspended",
            "suspended_at": time.time(),
        })
        await _send_session_email(
            "unexpected_stop",
            session_id,
            s,
            reason="실행 환경이 중지되어 세션을 보관 상태로 전환했습니다.",
            actor="시스템 · 상태 감지",
        )
        _orig = s.get("original_created_at") or s.get("created_at", 0)
        _now_ts2 = time.time()
        _s_ext_blocked = (not s.get("extend_unlocked", False)) and \
            ((_now_ts2 + 86400 - _orig) / 86400 >= 40)
        suspended_sessions = [{"id": session_id, "project_name": s.get("project_name", ""),
                                "saved_at": _now_ts2, "team_members": s.get("team_members", []),
                                "resources": s.get("resources", {}),
                                "original_created_at": _orig,
                                "extend_blocked": _s_ext_blocked}] + suspended_sessions
        return {"status": "none", "suspended_sessions": suspended_sessions}

    # restarting, paused 등 — 실제로 준비 중
    return {"status": "starting", "session_id": session_id, "suspended_sessions": suspended_sessions, **meta}


@app.get("/session/{session_id}", dependencies=[Depends(require_key), Depends(require_user)])
async def poll_session(
    session_id: str,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    s = _sc_get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")

    me = x_user_email.lower()
    if x_user_admin != "1" and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 조회할 수 있습니다.")

    # 이전 중: docker 상태 확인 없이 즉시 반환
    if s.get("status") == "migrating":
        src_node_id = s.get("migration_source_node") or s["node_id"]
        try:
            src_node = await _get_node(src_node_id)
        except Exception:
            src_node = {"name": src_node_id, "gpu": "", "ip": "", "kasm_url": ""}
        return {
            "status": "migrating",
            "message": s.get("migration_msg", "환경 이전 중…"),
            "project_name": s.get("project_name", ""),
            "work_type": s.get("work_type", ""),
            "node_id": src_node_id,
            "node_name": src_node.get("name", src_node_id),
            "node_gpu": src_node.get("gpu", ""),
            "node_ip": src_node.get("ip", ""),
        }

    node = await _get_node(s["node_id"])
    _suser = node.get("ssh_user", SSH_USER)
    dock = await _docker_status(node["ip"], _suser, _container_name(session_id))

    meta = {
        "project_name": s.get("project_name", ""),
        "work_type": s.get("work_type", ""),
        "node_id": s["node_id"],
        "node_name": node.get("name", s["node_id"]),
        "node_gpu": node.get("gpu", ""),
        "node_ip": node.get("ip", ""),
    }

    if dock == "running":
        _kasm_url = node.get("kasm_url", "https://kasm.dshs-app.net")
        url = _session_url(session_id, _kasm_url)
        return {"status": "ready", "url": url, "terminal_url": _terminal_url(session_id, _kasm_url), **meta}
    if dock in ("exited", "dead"):
        return {"status": "error", "message": "컨테이너가 예기치 않게 종료되었습니다."}
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

    # behalf_of: 관리자가 다른 사용자 대신 신청
    if is_admin and body and body.behalf_of:
        me = body.behalf_of.lower().strip()

    if resume:
        suspended_docs = _sc_list(owner=me, status="suspended")
        if not suspended_docs:
            raise HTTPException(status_code=404, detail="저장된 세션이 없습니다.")

        target_sid, s = (
            next((pair for pair in suspended_docs if pair[0] == session_id), suspended_docs[0])
            if session_id else suspended_docs[0]
        )
        node = await _get_node(s["node_id"])
        _suser = node.get("ssh_user", SSH_USER)

        container = _container_name(target_sid)

        # 컨테이너 존재 확인
        inspect_out, inspect_rc = await _ssh(
            node["ip"],
            f"docker inspect --format={{{{.State.Status}}}} {container} 2>/dev/null",
            _suser,
        )
        if inspect_rc == -1:
            raise HTTPException(status_code=503, detail="노드 서버 연결 실패. 잠시 후 다시 시도하세요.")
        if inspect_rc != 0 or not inspect_out:
            _sc_del(target_sid)
            try:
                await db.collection(COL_SESSIONS).document(target_sid).delete()
            except Exception:
                pass
            raise HTTPException(status_code=409, detail="저장된 작업 파일이 더 이상 존재하지 않습니다. 새로 시작해주세요.", headers={"X-Container-Gone": "1"})

        # duration 결정
        resume_duration = (body.duration_days if body else None)
        if resume_duration is None or resume_duration < 0:
            resume_duration = 7
        if resume_duration == 0:
            expires_delta = 999 * 86400
        else:
            expires_delta = resume_duration * 86400

        now_ts = time.time()
        new_expires = now_ts + expires_delta
        original_created = s.get("original_created_at") or s.get("created_at", now_ts)

        # 40일 초과 체크
        if not (is_admin or s.get("extend_unlocked")):
            total_days = (new_expires - original_created) / 86400
            if total_days > 40:
                raise HTTPException(
                    status_code=403,
                    detail="세션 총 이용 기간이 40일을 초과합니다. 관리자 허가가 필요합니다.",
                )

        stdout, rc = await _ssh(node["ip"], f"docker start {container}", _suser)
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"docker start 실패: {stdout}")

        updates = {
            "status": "starting",
            "created_at": now_ts,
            "expires_at": new_expires,
        }
        _sc_update(target_sid, updates)
        await db.collection(COL_SESSIONS).document(target_sid).update(updates)
        if s.get("port"):
            await _nginx_update(s["node_id"], node["ip"], _suser, node.get("kasm_url", ""))
        await _log_activity(
            me,
            "session_resume",
            "세션을 이어서 시작했습니다",
            s.get("project_name") or target_sid,
            members=s.get("team_members"),
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
        await _send_session_email("resumed", target_sid, s, actor=me)
        return {"session_id": target_sid, "status": "starting"}

    # ── New session ────────────────────────────────────────────────────────────

    if not is_admin:
        active_count = _count_active_sessions(me)
        max_s = await _get_user_max_sessions(me)
        if active_count >= max_s:
            raise HTTPException(status_code=429, detail="이미 활성 PC가 있습니다.")

    # Delete suspended session being replaced
    if body and body.replace_session_id:
        old_s = _sc_get(body.replace_session_id)
        if old_s and (old_s.get("owner") == me or is_admin):
            old_node = await _get_node(old_s["node_id"])
            old_container = _container_name(body.replace_session_id)
            await _ssh(
                old_node["ip"],
                f"docker rm -f {old_container} 2>/dev/null || true",
                old_node.get("ssh_user", SSH_USER),
            )
            _sc_del(body.replace_session_id)
            await db.collection(COL_SESSIONS).document(body.replace_session_id).delete()

    # Pick node — least-loaded with remaining port capacity
    node_id = body.node_id if body else None
    req_res = (body.resources or {}) if body else {}
    req_cpu = req_res.get("cpu_cores", 0)
    req_ram = req_res.get("ram_gb", 0)

    if not node_id:
        all_nodes = await _get_nodes()
        active_sessions = list(_sc_list(status=["active", "starting"]))
        node_sc: dict[str, int] = {}
        node_ru: dict[str, dict] = {}
        for _, sd2 in active_sessions:
            nid2 = sd2.get("node_id", "")
            node_sc[nid2] = node_sc.get(nid2, 0) + 1
            r2 = sd2.get("resources") or {}
            if nid2 not in node_ru:
                node_ru[nid2] = {"cpu_cores": 0, "ram_gb": 0}
            node_ru[nid2]["cpu_cores"] += r2.get("cpu_cores", 0)
            node_ru[nid2]["ram_gb"] += r2.get("ram_gb", 0)

        best_node: Optional[str] = None
        best_count = PORT_MAX - PORT_BASE + 1  # max capacity
        for nn in all_nodes:
            nid = nn["id"]
            count = node_sc.get(nid, 0)
            if count >= 2:
                continue
            used = node_ru.get(nid, {"cpu_cores": 0, "ram_gb": 0})
            cpu_total = nn.get("cpu_cores", 0)
            ram_total = nn.get("ram_gb", 0)
            if cpu_total > 0 and req_cpu > 0 and (used["cpu_cores"] + req_cpu) / cpu_total > 0.9:
                continue
            if ram_total > 0 and req_ram > 0 and (used["ram_gb"] + req_ram) / ram_total > 0.9:
                continue
            if count < best_count:
                best_count = count
                best_node = nid
        if not best_node:
            raise HTTPException(status_code=503, detail="사용 가능한 PC가 없습니다.")
        node_id = best_node

    node = await _get_node(node_id)

    # Per-node capacity check: 최대 2 세션
    node_active_sids = [(sid, s) for sid, s in _sc_list(status=["active", "starting"]) if s.get("node_id") == node_id]
    if len(node_active_sids) >= 2:
        raise HTTPException(status_code=503, detail="해당 PC가 꽉 찼습니다. 다른 PC를 선택해주세요.")
    _suser = node.get("ssh_user", SSH_USER)
    kasm_url = node.get("kasm_url", "https://kasm.dshs-app.net")

    new_id = uuid.uuid4().hex[:8]
    port = await _allocate_port(node_id, node["ip"], _suser)
    container = _container_name(new_id)
    ttyd_port = _ttyd_port(port)

    # 사용자별 공유 폴더 준비 후 컨테이너 바탕화면에 bind-mount → 업로드한 파일이 보임
    share_dir = _share_dir(me, _suser)
    await _ssh(
        node["ip"],
        f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)}",
        _suser,
    )

    # 등분 리소스 한도: (기존 세션 수 + 1)로 노드 90% 용량 나눔
    n_after = len(node_active_sids) + 1
    cpu_per, ram_per = _resource_limits_for_node(node, n_after)
    resource_flags = f"--cpus {cpu_per} --memory {ram_per}g " if cpu_per > 0 and ram_per > 0 else ""

    cmd = (
        f"docker run -d --name {container} --restart unless-stopped "
        f"--gpus all --shm-size=2gb {resource_flags}-p {port}:6901 -p {ttyd_port}:7681 {_mount_arg(me, _suser)} "
        f"-e VNC_PW=test1234 {KASM_IMAGE}:latest"
    )
    stdout, rc = await _ssh(node["ip"], cmd, _suser)
    if rc != 0:
        # GPU 드라이버 미매치(NVML error, rc=125) 등 GPU 실패 → CPU 모드로 재시도
        await _ssh(node["ip"], f"docker rm -f {container} 2>/dev/null || true", _suser)
        cmd_no_gpu = (
            f"docker run -d --name {container} --restart unless-stopped "
            f"--shm-size=2gb {resource_flags}-p {port}:6901 -p {ttyd_port}:7681 {_mount_arg(me, _suser)} "
            f"-e VNC_PW=test1234 {KASM_IMAGE}:latest"
        )
        stdout, rc = await _ssh(node["ip"], cmd_no_gpu, _suser)
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"docker run 실패: {stdout}")

    duration = (body.duration_days if body else None)
    if duration is None or duration < 0:
        duration = 7
    # 무한(0) → 999일
    if duration == 0:
        expires_delta = 999 * 86400
    else:
        expires_delta = duration * 86400

    now_ts = time.time()
    session_data = {
        "node_id": node_id,
        "owner": me,
        "team_members": (body.team_members if body else None) or [],
        "project_name": (body.project_name if body else None) or "",
        "status": "starting",
        "created_at": now_ts,
        "original_created_at": now_ts,  # 연장/재개 시 불변
        "expires_at": now_ts + expires_delta,
        "extend_unlocked": False,
        "work_type": (body.work_type if body else None) or "",
        "resources": (body.resources if body else None) or {},
        "port": port,
        "url": _session_url(new_id, kasm_url),
        "terminal_url": _terminal_url(new_id, kasm_url),
    }
    _sc_set(new_id, session_data)
    await db.collection(COL_SESSIONS).document(new_id).set(session_data)

    # 기존 컨테이너들도 동일 한도로 축소 (새 세션 포함 n_after 등분)
    if node_active_sids:
        existing_containers = [_container_name(sid) for sid, _ in node_active_sids]
        await _update_node_container_limits(node["ip"], _suser, existing_containers, cpu_per, ram_per)

    await _nginx_update(node_id, node["ip"], _suser, kasm_url)
    await _log_activity(
        me,
        "session_start",
        "세션을 시작했습니다",
        f"{(body.project_name if body else '') or '세션'} · {node.get('name', node_id)}",
        members=(body.team_members if body else None),
        node_id=node_id,
        project_name=(body.project_name if body else None),
    )
    created_batch = await _send_session_email("created", new_id, session_data, actor=me)
    # 7일 이하 대여는 생성 안내에 종료 예정 시각이 포함되므로 같은 내용의
    # 7일 전 경고를 1분 뒤 중복 발송하지 않는다. 실패한 수신자만 경고 루프에서 재시도한다.
    if duration <= 7:
        recipients = _session_email_recipients(session_data)
        sent_to = sorted(created_batch.successful_recipients)
        warning_updates = {
            "warning_email_sent": bool(recipients) and len(sent_to) == len(recipients),
            "warning_email_sent_to": sent_to,
        }
        _sc_update(new_id, warning_updates)
        await db.collection(COL_SESSIONS).document(new_id).update(warning_updates)
    return {"session_id": new_id, "status": "starting"}


class ExtendBody(BaseModel):
    extend_days: Optional[int] = None
    extend_unlocked: Optional[bool] = None


class MigrateBody(BaseModel):
    target_node_id: str
    duration_days: Optional[int] = 7


@app.patch("/session/{session_id}", dependencies=[Depends(require_key), Depends(require_user)])
async def patch_session(
    session_id: str,
    body: ExtendBody,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    s = _sc_get(session_id)
    if s is None:
        # fallback to Firestore for suspended sessions evicted from memory
        try:
            doc = await db.collection(COL_SESSIONS).document(session_id).get()
            if doc.exists:
                s = doc.to_dict()
            else:
                raise HTTPException(status_code=404, detail="Session not found")
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=404, detail="Session not found")

    me = x_user_email.lower()
    is_admin = x_user_admin == "1"

    if not is_admin and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 수정할 수 있습니다.")

    # 관리자 전용: extend_unlocked 설정
    if body.extend_unlocked is not None:
        if not is_admin:
            raise HTTPException(status_code=403, detail="관리자만 허가할 수 있습니다.")
        updates = {"extend_unlocked": body.extend_unlocked}
        _sc_update(session_id, updates)
        await db.collection(COL_SESSIONS).document(session_id).update(updates)
        return {"ok": True}

    # extend_days: 연장
    if body.extend_days is not None:
        if body.extend_days <= 0:
            raise HTTPException(status_code=400, detail="extend_days는 양수여야 합니다.")

        current_expires = s.get("expires_at", time.time())
        now_ts = time.time()
        remaining = current_expires - now_ts

        # 2일 이내에만 연장 가능
        if remaining > 2 * 86400 and not is_admin:
            raise HTTPException(
                status_code=400,
                detail="세션 종료 2일 이내에만 연장할 수 있습니다.",
            )

        new_expires = current_expires + body.extend_days * 86400
        orig = s.get("original_created_at") or s.get("created_at", now_ts)

        # 40일 초과 체크
        if not (is_admin or s.get("extend_unlocked")):
            total_days = (new_expires - orig) / 86400
            if total_days > 40:
                raise HTTPException(
                    status_code=403,
                    detail="세션 총 이용 기간이 40일을 초과합니다. 관리자 허가가 필요합니다.",
                )

        updates = {"expires_at": new_expires}
        _sc_update(session_id, updates)
        await db.collection(COL_SESSIONS).document(session_id).update(updates)
        await _log_activity(
            s.get("owner", me),
            "session_extend",
            f"세션을 {body.extend_days}일 연장했습니다",
            s.get("project_name") or session_id,
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
        return {"expires_at": new_expires}

    raise HTTPException(status_code=400, detail="extend_days 또는 extend_unlocked 중 하나를 제공해야 합니다.")


async def _do_migration(
    session_id: str,
    s: dict,
    src_node: dict,
    tgt_node: dict,
    duration_days: int,
    owner: str,
) -> None:
    """docker commit → asyncssh 파이프 → docker run 으로 컨테이너를 다른 노드로 이전한다."""
    src_ip = src_node["ip"]
    src_user = src_node.get("ssh_user", SSH_USER)
    tgt_ip = tgt_node["ip"]
    tgt_user = tgt_node.get("ssh_user", SSH_USER)
    container = _container_name(session_id)
    tmp_image = f"dshs-migrate-{session_id}"

    async def _msg(msg: str) -> None:
        _sc_update(session_id, {"migration_msg": msg})

    async def _fail(reason: str) -> None:
        logger.error("[migrate] %s 실패: %s", session_id, reason)
        _sc_update(session_id, {"status": "suspended", "migration_msg": None, "migration_source_node": None})
        try:
            await db.collection(COL_SESSIONS).document(session_id).update({"status": "suspended"})
        except Exception:
            pass
        # 소스 임시 이미지 정리
        await _ssh(src_ip, f"docker rmi {tmp_image} 2>/dev/null || true", src_user)

    try:
        # 1. 소스 노드에서 컨테이너 커밋
        await _msg("컨테이너 스냅샷 생성 중…")
        out, rc = await _ssh(src_ip, f"docker commit {container} {tmp_image}", src_user)
        if rc != 0:
            await _fail(f"docker commit 실패: {out}")
            return

        # 2. asyncssh 이중 연결로 이미지 스트리밍 (소스 → 대상)
        await _msg("이미지 전송 중… (수 분 소요)")
        try:
            async with asyncssh.connect(
                src_ip, username=src_user, password=SSH_PASSWORD,
                known_hosts=None, connect_timeout=30,
            ) as src_conn:
                async with asyncssh.connect(
                    tgt_ip, username=tgt_user, password=SSH_PASSWORD,
                    known_hosts=None, connect_timeout=30,
                ) as tgt_conn:
                    tgt_proc = await tgt_conn.create_process("docker load", encoding=None)
                    async with src_conn.create_process(
                        f"docker save {tmp_image}", encoding=None
                    ) as src_proc:
                        while True:
                            chunk = await src_proc.stdout.read(65536)
                            if not chunk:
                                break
                            tgt_proc.stdin.write(chunk)
                            await tgt_proc.stdin.drain()
                        tgt_proc.stdin.write_eof()
                    await tgt_proc.wait()
        except Exception as e:
            await _fail(f"이미지 전송 오류: {e}")
            return

        # 3. 대상 노드에서 공유 폴더 생성
        share_dir = _share_dir(owner, tgt_user)
        await _ssh(tgt_ip, f"mkdir -p {shlex.quote(share_dir)} && chmod 777 {shlex.quote(share_dir)}", tgt_user)

        # 4. 대상 노드 포트 할당
        await _msg("대상 PC에서 세션 시작 중…")
        port = await _allocate_port(tgt_node["id"], tgt_ip, tgt_user)
        ttyd_port = _ttyd_port(port)
        kasm_url = tgt_node.get("kasm_url", "")

        n_existing = len([x for _, x in _sc_list(status=["active", "starting"]) if x.get("node_id") == tgt_node["id"]])
        cpu_per, ram_per = _resource_limits_for_node(tgt_node, n_existing + 1)
        resource_flags = f"--cpus {cpu_per} --memory {ram_per}g " if cpu_per > 0 and ram_per > 0 else ""
        mount = _mount_arg(owner, tgt_user)

        # 5. docker run (GPU → CPU fallback)
        cmd = (
            f"docker run -d --name {container} --restart unless-stopped "
            f"--gpus all --shm-size=2gb {resource_flags}-p {port}:6901 -p {ttyd_port}:7681 {mount} "
            f"-e VNC_PW=test1234 {tmp_image}"
        )
        out, rc = await _ssh(tgt_ip, cmd, tgt_user)
        if rc != 0:
            await _ssh(tgt_ip, f"docker rm -f {container} 2>/dev/null || true", tgt_user)
            cmd_no_gpu = (
                f"docker run -d --name {container} --restart unless-stopped "
                f"--shm-size=2gb {resource_flags}-p {port}:6901 -p {ttyd_port}:7681 {mount} "
                f"-e VNC_PW=test1234 {tmp_image}"
            )
            out, rc = await _ssh(tgt_ip, cmd_no_gpu, tgt_user)
            if rc != 0:
                await _fail(f"docker run 실패: {out}")
                return

        # 6. nginx 업데이트 (대상 노드)
        await _nginx_update(tgt_node["id"], tgt_ip, tgt_user, kasm_url)

        # 7. 세션 스토어 업데이트
        now_ts = time.time()
        expires_delta = (duration_days * 86400) if duration_days > 0 else 999 * 86400
        updates = {
            "status": "starting",
            "node_id": tgt_node["id"],
            "port": port,
            "url": _session_url(session_id, kasm_url),
            "terminal_url": _terminal_url(session_id, kasm_url),
            "created_at": now_ts,
            "expires_at": now_ts + expires_delta,
            "migration_msg": None,
            "migration_source_node": None,
        }
        _sc_update(session_id, updates)
        try:
            await db.collection(COL_SESSIONS).document(session_id).update(updates)
        except Exception:
            pass

        # 8. 소스 정리 (컨테이너 + 임시 이미지)
        await _ssh(src_ip, f"docker rm -f {container} 2>/dev/null || true && docker rmi {tmp_image} 2>/dev/null || true", src_user)
        await _ssh(tgt_ip, f"docker rmi {tmp_image} 2>/dev/null || true", tgt_user)

        logger.info("[migrate] %s: %s → %s 완료", session_id, src_node["id"], tgt_node["id"])

    except Exception as e:
        await _fail(str(e))


@app.post("/session/{session_id}/migrate", dependencies=[Depends(require_key), Depends(require_user)])
async def migrate_session(
    session_id: str,
    body: MigrateBody,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    me = x_user_email.lower()
    is_admin = x_user_admin == "1"

    s = _sc_get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다.")
    if not is_admin and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 이전할 수 있습니다.")
    if s.get("status") not in ("suspended",):
        raise HTTPException(status_code=400, detail="일시 중지된 세션만 이전할 수 있습니다.")
    if body.target_node_id == s["node_id"]:
        raise HTTPException(status_code=400, detail="같은 PC입니다. 이어하기를 사용하세요.")

    src_node = await _get_node(s["node_id"])
    tgt_node = await _get_node(body.target_node_id)

    # 대상 노드 용량 확인
    tgt_active = [x for _, x in _sc_list(status=["active", "starting"]) if x.get("node_id") == body.target_node_id]
    if len(tgt_active) >= 2:
        raise HTTPException(status_code=503, detail="대상 PC가 꽉 찼습니다. 다른 PC를 선택해주세요.")

    duration_days = body.duration_days if body.duration_days is not None else 7

    # migrating으로 마킹 (소스 node_id 보존, migration_source_node 기록)
    _sc_update(session_id, {
        "status": "migrating",
        "migration_source_node": s["node_id"],
        "migration_msg": "컨테이너 스냅샷 생성 중…",
    })

    asyncio.create_task(_do_migration(session_id, s, src_node, tgt_node, duration_days, me))

    return {"status": "migrating", "session_id": session_id}


@app.delete("/session/{session_id}", dependencies=[Depends(require_key), Depends(require_user)])
async def delete_session(
    session_id: str,
    permanent: bool = Query(False),
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    s = _sc_get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")

    me = x_user_email.lower()
    if x_user_admin != "1" and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 종료할 수 있습니다.")

    node = await _get_node(s["node_id"])
    _suser = node.get("ssh_user", SSH_USER)
    container = _container_name(session_id)
    kasm_url = node.get("kasm_url", "")

    if permanent:
        await _ssh(node["ip"], f"docker rm -f {container}", _suser)
        _sc_del(session_id)
        await db.collection(COL_SESSIONS).document(session_id).delete()
        await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
        # 남은 활성 컨테이너 한도 확장
        remaining = [(sid, ss) for sid, ss in _sc_list(status=["active", "starting"]) if ss.get("node_id") == s["node_id"]]
        if remaining:
            cpu_per, ram_per = _resource_limits_for_node(node, len(remaining))
            await _update_node_container_limits(node["ip"], _suser, [_container_name(sid) for sid, _ in remaining], cpu_per, ram_per)
        await _log_activity(
            s.get("owner", me),
            "session_delete",
            "세션을 영구 삭제했습니다",
            s.get("project_name") or session_id,
            members=s.get("team_members"),
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
        await _send_session_email("delete", session_id, s, actor=me)
        return {"message": "세션을 완전히 삭제했습니다."}

    await _ssh(node["ip"], f"docker stop {container}", _suser)
    _sc_update(session_id, {"status": "suspended", "suspended_at": time.time()})
    await db.collection(COL_SESSIONS).document(session_id).update({"status": "suspended", "suspended_at": time.time()})
    await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
    # 중지된 컨테이너는 리소스 반납 → 남은 활성 컨테이너 한도 확장
    remaining = [(sid, ss) for sid, ss in _sc_list(status=["active", "starting"]) if ss.get("node_id") == s["node_id"]]
    if remaining:
        cpu_per, ram_per = _resource_limits_for_node(node, len(remaining))
        await _update_node_container_limits(node["ip"], _suser, [_container_name(sid) for sid, _ in remaining], cpu_per, ram_per)
    await _log_activity(
        s.get("owner", me),
        "session_suspend",
        "세션이 보관되었습니다",
        s.get("project_name") or session_id,
        members=s.get("team_members"),
        node_id=s.get("node_id"),
        project_name=s.get("project_name"),
    )
    await _send_session_email("suspend", session_id, s, actor=me)
    return {"status": "suspended"}


@app.get("/history", dependencies=[Depends(require_key), Depends(require_user)])
async def get_history(
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    me = x_user_email.lower()
    now = time.time()
    lt = time.localtime(now)
    month_start = time.mktime((lt.tm_year, lt.tm_mon, 1, 0, 0, 0, 0, 0, -1))

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


@app.get("/upload-ticket", dependencies=[Depends(require_key)])
async def upload_ticket(x_user_email: str = Header("")):
    """노드 직접 업로드용 서명 토큰 + 노드 URL 반환. Vercel API 라우트가 호출한다."""
    me = x_user_email.lower()
    if not me:
        raise HTTPException(status_code=400, detail="x-user-email 헤더 필요")

    active = _sc_list(owner=me, status=["active", "starting"])
    suspended = _sc_list(owner=me, status="suspended")
    target = (active or suspended or [None])[0]
    if not target:
        raise HTTPException(status_code=400, detail="먼저 PC 세션을 시작한 뒤 파일을 보낼 수 있습니다.")

    session_id, s = target
    node = await _get_node(s["node_id"])
    container = _container_name(session_id)
    upload_url = "https://hub.dshs-app.net"

    exp = int(time.time()) + 300
    payload = f"{me}|{container}|{exp}"
    payload_b64 = base64.urlsafe_b64encode(payload.encode()).rstrip(b"=").decode()
    sig = hmac.new(UPLOAD_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()

    return {"token": f"{payload_b64}.{sig}", "upload_url": upload_url, "expires_at": exp}


@app.post("/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
    x_upload_token: str = Header(""),
):
    """학생 브라우저가 LAN으로 직접 호출. 토큰으로 본인 확인 후, 본인 세션이
    떠 있는 노드의 공유 폴더로 파일을 전송한다. 컨테이너 바탕화면/받은파일에서 보임."""
    email = _verify_upload_token(x_upload_token)

    # 본인의 세션 노드 찾기 (활성/시작중 우선, 없으면 저장된 세션)
    active_pairs = _sc_list(owner=email, status=["active", "starting"])
    suspended_pairs = _sc_list(owner=email, status="suspended")
    target_pair = (active_pairs or suspended_pairs or [None])[0]
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
            for f in files:
                fname = os.path.basename(f.filename or "file") or "file"
                remote = f"{share_dir}/{fname}"
                proc = await conn.create_process(
                    f"cat > {shlex.quote(remote)}", encoding=None
                )
                while True:
                    chunk = await f.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    proc.stdin.write(chunk)
                proc.stdin.write_eof()
                await proc.wait_closed()
                if proc.returncode != 0:
                    raise asyncssh.Error(f"파일 쓰기 실패: {fname}")
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

    if saved:
        await _log_activity(
            email,
            "file_upload",
            "파일 전송 완료",
            ", ".join(saved[:3]) + (f" 외 {len(saved) - 3}개" if len(saved) > 3 else ""),
            node_id=target.get("node_id"),
            project_name=target.get("project_name"),
        )

    return {
        "uploaded": saved,
        "count": len(saved),
        "node": node.get("name", target["node_id"]),
        "live": has_mount or target.get("status") in ("active", "starting"),
    }


# ── Routes: admin monitoring ──────────────────────────────────────────────────


@app.get("/admin/service-health", dependencies=[Depends(require_key)])
async def admin_service_health():
    """각 노드의 서비스(nginx·kasm-tunnel·tailscaled) 상태 반환. 메트릭 캐시 기반."""
    nodes = await _get_nodes()
    result = []
    for n in nodes:
        m = _metrics.get(n["id"], {})
        result.append({
            "id": n["id"],
            "name": n.get("name", n["id"]),
            "online": not m.get("offline", True),
            "svc_nginx": m.get("svc_nginx", "unknown"),
            "svc_tunnel": m.get("svc_tunnel", "unknown"),
            "svc_tailscale": m.get("svc_tailscale", "unknown"),
            "kasm_running": m.get("kasm_running", 0),
            "last_seen": m.get("last_seen"),
        })
    return {"nodes": result}


@app.get("/admin/nodes", dependencies=[Depends(require_key)])
async def admin_nodes():
    nodes = await _get_nodes()
    active_by_node = {s.get("node_id"): s for _, s in _sc_list(status=["active", "starting"])}

    result = []
    for n in nodes:
        m = _metrics.get(n["id"], {})

        if not m or m.get("offline"):
            status = "offline"
        elif m.get("kasm_running", 0) > 0:
            status = "in_use"
        else:
            status = "idle"

        entry: dict = {
            "id": n["id"],
            "name": n.get("name", n["id"]),
            "status": status,
            "cpu_usage": m.get("cpu", 0),
            "gpu_usage": m.get("gpu", 0),
            "ram_used_gb": m.get("ram_used_gb", 0),
            "ram_total_gb": m.get("ram_total_gb") or n.get("ram_gb", 0),
            "storage_used_gb": m.get("storage_used_gb", 0),
            "storage_total_gb": m.get("storage_total_gb") or n.get("storage_gb", 0),
            "top_process": m.get("top"),
            "uptime_seconds": m.get("uptime_seconds"),
        }

        if n["id"] in active_by_node:
            active = active_by_node[n["id"]]
            entry["project_name"] = active.get("project_name", "")
            entry["owner"] = active.get("owner", "")

        result.append(entry)

    return {"nodes": result}


# ── Routes: admin users ───────────────────────────────────────────────────────


@app.get("/admin/users", dependencies=[Depends(require_key)])
async def list_users():
    users_snap = await db.collection(COL_USERS).get()
    active_counts: dict[str, int] = {}
    for _, s in _sc_list(status=["active", "starting"]):
        owner = s.get("owner", "")
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


@app.get("/admin/email/status", dependencies=[Depends(require_key)])
async def admin_email_status():
    return _email_runtime_status()


@app.post("/admin/email/preview", dependencies=[Depends(require_key)])
async def admin_email_preview(body: EmailPreviewBody):
    session_id = body.session_id or "sample-session"
    project_name = body.project_name or "샘플 프로젝트"
    expires_at = body.expires_at if body.expires_at is not None else time.time() + WARNING_SECONDS
    content = _build_session_email(
        body.kind,
        session_id,
        project_name,
        expires_at,
        event_at=body.event_at,
        reason=body.reason,
        actor=body.actor,
    )
    return {
        "kind": body.kind,
        "to": body.to or GMAIL_SENDER,
        "session_id": session_id,
        "project_name": project_name,
        "expires_at": expires_at,
        "event_at": body.event_at,
        "subject": content.subject,
        "text": content.text,
        "html": content.html,
        "runtime": _email_runtime_status(),
    }


@app.post("/admin/email/test", dependencies=[Depends(require_key)])
async def admin_email_test(body: EmailPreviewBody):
    recipient = _normalise_email(body.to or GMAIL_SENDER)
    if not recipient:
        raise HTTPException(status_code=400, detail="올바른 테스트 수신자(to) 또는 GMAIL_SENDER가 필요합니다.")
    session_id = body.session_id or "sample-session"
    project_name = body.project_name or "샘플 프로젝트"
    expires_at = body.expires_at if body.expires_at is not None else time.time() + WARNING_SECONDS
    content = _build_session_email(
        body.kind,
        session_id,
        project_name,
        expires_at,
        event_at=body.event_at,
        reason=body.reason,
        actor=body.actor,
    )
    result = await _send_email(recipient, content.subject, content.text, content.html)
    return {
        "status": result.state,
        "detail": result.detail,
        "to": recipient,
        "subject": content.subject,
        "runtime": _email_runtime_status(),
    }


@app.post("/admin/nodes", dependencies=[Depends(require_key)])
async def register_node(node_id: str = Query(...), body: NodeBody = Body(...)):
    data = body.model_dump()
    await db.collection(COL_NODES).document(node_id).set(data)
    entry = {"id": node_id, **data}
    existing = next((i for i, n in enumerate(_nodes_cache) if n["id"] == node_id), None)
    if existing is not None:
        _nodes_cache[existing] = entry
    else:
        _nodes_cache.append(entry)
    _save_nodes_to_file()
    return {"id": node_id, **data}


@app.delete("/admin/nodes/{node_id}", dependencies=[Depends(require_key)])
async def remove_node(node_id: str):
    await db.collection(COL_NODES).document(node_id).delete()
    _nodes_cache[:] = [n for n in _nodes_cache if n["id"] != node_id]
    _save_nodes_to_file()
    return {"id": node_id, "deleted": True}


# ── Routes: legacy compat (admin/status, terminate, cleanup, notice) ──────────

COL_CONFIG = "config"

_CLEANUP_CMD = (
    "docker ps -a --filter status=exited --filter status=dead "
    "--format '{{.Names}}' | grep '^kasm_' | xargs -r docker rm -f"
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
        orig = s.get("original_created_at") or s.get("created_at", 0)
        expires = s.get("expires_at", 0)
        extend_blocked = (not s.get("extend_unlocked", False)) and \
            ((expires - orig) / 86400 >= 40)
        result.append({
            "id": doc.id,
            "owner": s.get("owner"),
            "project_name": s.get("project_name"),
            "node_id": nid,
            "node_name": name,
            "status": s.get("status"),
            "expires_at": expires,
            "suspended_at": s.get("suspended_at"),
            "original_created_at": orig,
            "extend_blocked": extend_blocked,
        })
    order = {"active": 0, "starting": 1, "suspended": 2}
    result.sort(key=lambda r: order.get(r.get("status"), 3))
    return {"sessions": result}


@app.get("/admin/status", dependencies=[Depends(require_key)])
async def admin_status():
    sessions = [{"id": sid, **s} for sid, s in _sc_list(status=["active", "starting"])]
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
async def admin_terminate(
    node_id: Optional[str] = Query(None),
    x_user_email: str = Header(""),
):
    terminated = []
    for sid, s in _sc_list(status=["active", "starting"]):
        if node_id and s.get("node_id") != node_id:
            continue
        node = await _get_node(s["node_id"])
        await _ssh(node["ip"], f"docker stop {_container_name(sid)}", node.get("ssh_user", SSH_USER))
        suspended_at = time.time()
        _sc_update(sid, {"status": "suspended", "suspended_at": suspended_at})
        await db.collection(COL_SESSIONS).document(sid).update({"status": "suspended", "suspended_at": suspended_at})
        actor = _normalise_email(x_user_email) or "관리자"
        await _send_session_email(
            "admin_suspend",
            sid,
            s,
            event_at=suspended_at,
            actor=actor,
        )
        terminated.append(sid)
    return {"terminated": terminated, "count": len(terminated)}


@app.post("/admin/cleanup", dependencies=[Depends(require_key)])
async def admin_cleanup(node_id: Optional[str] = Query(None)):
    nodes = await _get_nodes()
    results = {}
    for n in nodes:
        if node_id and n["id"] != node_id:
            continue
        stdout, rc = await _ssh(n["ip"], _CLEANUP_CMD, n.get("ssh_user", SSH_USER))
        results[n["id"]] = {"removed": stdout.strip(), "ok": rc == 0}
    return {"nodes": results}


@app.get("/admin/security-alerts", dependencies=[Depends(require_key)])
async def get_security_alerts():
    alerts = [_public_security_alert(alert) for alert in reversed(_security_alerts)]
    return {
        "alerts": alerts,
        "unacknowledged": sum(not alert.get("acknowledged", False) for alert in _security_alerts),
        "scan_enabled": SECURITY_SCAN_ENABLED,
        "extensions": list(SECURITY_EXTENSIONS),
    }


@app.patch("/admin/security-alerts/{alert_id}", dependencies=[Depends(require_key)])
async def update_security_alert(alert_id: str, body: SecurityAlertUpdate):
    for alert in _security_alerts:
        if alert.get("id") == alert_id:
            alert["acknowledged"] = body.acknowledged
            alert["acknowledged_at"] = time.time() if body.acknowledged else None
            _persist_security_alerts()
            return _public_security_alert(alert)
    raise HTTPException(status_code=404, detail="보안 경고를 찾을 수 없습니다.")


@app.get("/admin/security-alerts/{alert_id}/screenshot", dependencies=[Depends(require_key)])
async def get_security_alert_screenshot(alert_id: str):
    alert = next((item for item in _security_alerts if item.get("id") == alert_id), None)
    if not alert or not alert.get("screenshot"):
        raise HTTPException(status_code=404, detail="스크린샷이 없습니다.")
    screenshot_path = os.path.join(SECURITY_ALERT_DIR, os.path.basename(alert["screenshot"]))
    if not os.path.isfile(screenshot_path):
        raise HTTPException(status_code=404, detail="스크린샷 파일이 없습니다.")
    return FileResponse(screenshot_path, media_type="image/jpeg", filename=f"security-{alert_id}.jpg")


@app.get("/admin/log", dependencies=[Depends(require_key)])
async def get_today_log(date: Optional[str] = Query(None)):
    target = date or datetime.now().strftime("%Y-%m-%d")
    log_path = os.path.join(LOG_DIR, f"{target}.log")
    if not os.path.isfile(log_path):
        return {"date": target, "content": None}
    with open(log_path, encoding="utf-8") as f:
        content = f.read()
    return {"date": target, "content": content}


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
