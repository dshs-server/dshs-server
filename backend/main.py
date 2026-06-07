import os
import re
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware

API_KEY = os.environ.get("API_KEY", "dev-secret-change-me")

SESSION_CF_LOG = "/tmp/session_cf.log"
SESSION_CF_PID = "/tmp/session_cf.pid"
ACTIVE_CONTAINER = "active_session"

# In-memory session store (single session MVP)
session_store: dict = {}


KASM_IMAGE = "kasmweb/ubuntu-jammy-desktop"


def _cleanup_stopped_containers() -> list[str]:
    """중단된 Kasm 컨테이너를 제거하고 삭제된 이름 목록을 반환한다."""
    result = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"ancestor={KASM_IMAGE}:1.16.0",
         "--filter", "status=exited",
         "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    # exited가 아닌 dead/created 상태도 포함
    result2 = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"ancestor={KASM_IMAGE}:1.16.0",
         "--filter", "status=dead",
         "--filter", "status=created",
         "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    names = set(
        (result.stdout + result2.stdout).strip().splitlines()
    )
    removed = []
    for name in names:
        name = name.strip()
        if not name:
            continue
        r = subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        if r.returncode == 0:
            removed.append(name)
    return removed


def _restore_session_from_container():
    """서버 재시작 후 실행 중인 컨테이너가 있으면 session_store를 복원한다."""
    check = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", ACTIVE_CONTAINER],
        capture_output=True, text=True,
    )
    if check.returncode != 0 or check.stdout.strip() != "true":
        return

    session_id = uuid.uuid4().hex[:8]
    url = _get_cf_url(SESSION_CF_LOG)
    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "log_path": SESSION_CF_LOG,
        "tunnel_url": url,
        "created_at": time.time(),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    _cleanup_stopped_containers()
    _restore_session_from_container()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def require_key(x_api_key: str = Header(...)):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


def _kill_session_cf():
    pid_file = Path(SESSION_CF_PID)
    if pid_file.exists():
        try:
            os.kill(int(pid_file.read_text().strip()), 9)
        except (ProcessLookupError, ValueError, OSError):
            pass
        pid_file.unlink(missing_ok=True)
    # fallback pkill
    subprocess.run(["pkill", "-f", SESSION_CF_LOG], capture_output=True)


def _stop_all_containers():
    # Stop the legacy test container and any active session container
    for name in ["test_kasm", ACTIVE_CONTAINER]:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def _get_cf_url(log_path: str) -> Optional[str]:
    p = Path(log_path)
    if not p.exists():
        return None
    match = re.search(
        r"https://[a-zA-Z0-9.-]+\.trycloudflare\.com", p.read_text()
    )
    return match.group(0) if match else None


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/session", dependencies=[Depends(require_key)])
async def get_active_session():
    if not session_store:
        return {"status": "none"}

    session_id, s = next(iter(session_store.items()))

    if s["tunnel_url"]:
        return {"status": "ready", "session_id": session_id, "url": s["tunnel_url"]}

    url = _get_cf_url(s["log_path"])
    if url:
        s["tunnel_url"] = url
        return {"status": "ready", "session_id": session_id, "url": url}

    check = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", ACTIVE_CONTAINER],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0 or check.stdout.strip() != "true":
        return {"status": "none"}

    return {"status": "starting", "session_id": session_id}


@app.post("/session", dependencies=[Depends(require_key)])
async def create_session():
    session_id = uuid.uuid4().hex[:8]

    # Tear down any existing session
    _kill_session_cf()
    _stop_all_containers()
    session_store.clear()

    # Remove stale log
    Path(SESSION_CF_LOG).unlink(missing_ok=True)

    # Start Kasm container on port 8080
    result = subprocess.run(
        [
            "docker", "run", "-d",
            "--name", ACTIVE_CONTAINER,
            "--gpus", "all",
            "--shm-size=2gb",
            "-p", "8080:6901",
            "-e", "VNC_PW=test1234",
            "kasmweb/ubuntu-jammy-desktop:1.16.0",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise HTTPException(
            status_code=500, detail=f"docker error: {result.stderr.strip()}"
        )

    # Give container a moment to bind port before nginx retries
    time.sleep(2)

    # Start cloudflared → nginx:80 → kasm
    with open(SESSION_CF_LOG, "w") as log_f:
        proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", "http://localhost:80"],
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    Path(SESSION_CF_PID).write_text(str(proc.pid))

    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "log_path": SESSION_CF_LOG,
        "tunnel_url": None,
        "created_at": time.time(),
    }

    return {"session_id": session_id, "status": "starting"}


@app.get("/session/{session_id}", dependencies=[Depends(require_key)])
async def get_session(session_id: str):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    s = session_store[session_id]

    if s["tunnel_url"]:
        return {"status": "ready", "url": s["tunnel_url"]}

    url = _get_cf_url(s["log_path"])
    if url:
        s["tunnel_url"] = url
        return {"status": "ready", "url": url}

    # Check container is still running
    check = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", ACTIVE_CONTAINER],
        capture_output=True,
        text=True,
    )
    if check.returncode != 0 or check.stdout.strip() != "true":
        return {"status": "error", "message": "컨테이너 시작 실패"}

    return {"status": "starting"}


@app.delete("/session/{session_id}", dependencies=[Depends(require_key)])
async def delete_session(session_id: str):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    _kill_session_cf()
    _stop_all_containers()
    session_store.clear()

    return {"status": "terminated"}


@app.post("/admin/cleanup", dependencies=[Depends(require_key)])
async def admin_cleanup():
    """중단된 Kasm 컨테이너를 즉시 정리한다."""
    removed = _cleanup_stopped_containers()
    return {"removed": removed, "count": len(removed)}
