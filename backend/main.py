import asyncio
import os
import re
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware

API_KEY = os.environ.get("API_KEY", "dev-secret-change-me")

SESSION_CF_LOG = "/tmp/session_cf.log"
SESSION_CF_PID = "/tmp/session_cf.pid"
ACTIVE_CONTAINER = "active_session"

# In-memory session store (single session MVP)
session_store: dict = {}


KASM_IMAGE = "kasmweb/ubuntu-jammy-desktop"


def _cleanup_stopped_containers() -> list[str]:
    """중단된 Kasm 컨테이너를 제거하고 삭제된 이름 목록을 반환한다.
    ACTIVE_CONTAINER는 저장된 세션일 수 있으므로 제외한다."""
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
        if not name or name == ACTIVE_CONTAINER:
            continue
        r = subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        if r.returncode == 0:
            removed.append(name)
    return removed


def _is_container_exited(name: str) -> bool:
    """컨테이너가 exited 상태인지 확인한다."""
    check = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Status}}", name],
        capture_output=True, text=True,
    )
    if check.returncode != 0:
        return False
    return check.stdout.strip() == "exited"


def _get_container_state(name: str) -> tuple[bool, bool]:
    """컨테이너의 (running, restarting) 상태를 반환한다."""
    check = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}},{{.State.Restarting}}", name],
        capture_output=True, text=True,
    )
    if check.returncode != 0:
        return False, False
    try:
        running_str, restarting_str = check.stdout.strip().split(",")
        return running_str == "true", restarting_str == "true"
    except ValueError:
        return False, False


def _is_cf_alive() -> bool:
    """cloudflared 프로세스가 살아있는지 확인한다."""
    pid_file = Path(SESSION_CF_PID)
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text().strip())
        os.kill(pid, 0)
        return True
    except (OSError, ValueError, ProcessLookupError):
        return False


def _start_cf_tunnel():
    """cloudflared Quick Tunnel을 시작하고 PID를 기록한다."""
    Path(SESSION_CF_LOG).unlink(missing_ok=True)
    with open(SESSION_CF_LOG, "w") as log_f:
        proc = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", "http://localhost:80"],
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
    Path(SESSION_CF_PID).write_text(str(proc.pid))


def _restore_session_from_container():
    """서버 재시작 후 실행 중인 컨테이너가 있으면 session_store를 복원한다."""
    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if not running and not restarting:
        return

    session_id = uuid.uuid4().hex[:8]
    url = _get_cf_url(SESSION_CF_LOG) if running else None
    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "log_path": SESSION_CF_LOG,
        "tunnel_url": url,
        "restarting": restarting,
        "created_at": time.time(),
    }


async def _monitor_and_restart():
    """컨테이너 재시작 및 cloudflared 장애를 감지하여 자동 복구한다."""
    while True:
        await asyncio.sleep(10)
        if not session_store:
            continue

        _, s = next(iter(session_store.items()))

        running, docker_restarting = _get_container_state(ACTIVE_CONTAINER)

        if docker_restarting:
            # 컨테이너가 재시작 중 → 클라이언트에 starting 상태 표시
            s["restarting"] = True

        elif running:
            if s.get("restarting"):
                # 재시작 완료 → URL 복원 시도
                url = _get_cf_url(s["log_path"])
                if url:
                    s["tunnel_url"] = url
                    s["restarting"] = False
                # URL이 아직 없으면 계속 대기

            # cloudflared가 죽은 경우 재시작 (재시작 대기 중이 아닐 때만)
            if not s.get("restarting") and not _is_cf_alive():
                _start_cf_tunnel()
                s["tunnel_url"] = None
                s["restarting"] = True  # 새 URL 발급 대기


@asynccontextmanager
async def lifespan(app: FastAPI):
    _cleanup_stopped_containers()
    _restore_session_from_container()
    task = asyncio.create_task(_monitor_and_restart())
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
        if _is_container_exited(ACTIVE_CONTAINER):
            return {"status": "suspended"}
        return {"status": "none"}

    session_id, s = next(iter(session_store.items()))

    # 컨테이너 재시작 중이면 starting 반환
    if s.get("restarting"):
        return {"status": "starting", "session_id": session_id}

    if s["tunnel_url"]:
        return {"status": "ready", "session_id": session_id, "url": s["tunnel_url"]}

    url = _get_cf_url(s["log_path"])
    if url:
        s["tunnel_url"] = url
        return {"status": "ready", "session_id": session_id, "url": url}

    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if not running and not restarting:
        return {"status": "none"}

    return {"status": "starting", "session_id": session_id}


@app.post("/session", dependencies=[Depends(require_key)])
async def create_session(resume: bool = Query(False)):
    session_id = uuid.uuid4().hex[:8]

    if resume:
        # 저장된 컨테이너 재시작
        running, _ = _get_container_state(ACTIVE_CONTAINER)
        if not running:
            result = subprocess.run(
                ["docker", "start", ACTIVE_CONTAINER],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"docker start error: {result.stderr.strip()}",
                )
        time.sleep(2)
        _kill_session_cf()
        _start_cf_tunnel()
        session_store.clear()
        session_store[session_id] = {
            "session_id": session_id,
            "container": ACTIVE_CONTAINER,
            "log_path": SESSION_CF_LOG,
            "tunnel_url": None,
            "restarting": False,
            "created_at": time.time(),
        }
        return {"session_id": session_id, "status": "starting"}

    # Tear down any existing session and create new container
    _kill_session_cf()
    _stop_all_containers()
    session_store.clear()

    # Start Kasm container on port 8080
    # --restart unless-stopped: 컨테이너 내부에서 종료/재부팅 시 자동 재시작
    result = subprocess.run(
        [
            "docker", "run", "-d",
            "--name", ACTIVE_CONTAINER,
            "--restart", "unless-stopped",
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
    _start_cf_tunnel()

    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "log_path": SESSION_CF_LOG,
        "tunnel_url": None,
        "restarting": False,
        "created_at": time.time(),
    }

    return {"session_id": session_id, "status": "starting"}


@app.get("/session/{session_id}", dependencies=[Depends(require_key)])
async def get_session(session_id: str):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    s = session_store[session_id]

    # 재시작 대기 중이면 starting 반환
    if s.get("restarting"):
        return {"status": "starting"}

    if s["tunnel_url"]:
        return {"status": "ready", "url": s["tunnel_url"]}

    url = _get_cf_url(s["log_path"])
    if url:
        s["tunnel_url"] = url
        return {"status": "ready", "url": url}

    # Check container is still running
    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if restarting:
        return {"status": "starting"}
    if not running:
        return {"status": "error", "message": "컨테이너 시작 실패"}

    return {"status": "starting"}


@app.delete("/session/{session_id}", dependencies=[Depends(require_key)])
async def delete_session(session_id: str):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    _kill_session_cf()
    # 컨테이너를 삭제하지 않고 중지만 — 데이터 보존 및 이어서 사용 가능
    subprocess.run(["docker", "stop", ACTIVE_CONTAINER], capture_output=True)
    session_store.clear()

    return {"status": "suspended"}


@app.post("/admin/cleanup", dependencies=[Depends(require_key)])
async def admin_cleanup():
    """중단된 Kasm 컨테이너를 즉시 정리한다."""
    removed = _cleanup_stopped_containers()
    return {"removed": removed, "count": len(removed)}
