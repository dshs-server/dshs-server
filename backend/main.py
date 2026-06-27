import asyncio
import os
import subprocess
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware

API_KEY = os.environ.get("API_KEY", "dev-secret-change-me")

ACTIVE_CONTAINER = "active_session"
SESSION_URL = "https://kasm.dshs-app.net"

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


def _restore_session_from_container():
    """서버 재시작 후 실행 중인 컨테이너가 있으면 session_store를 복원한다."""
    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if not running and not restarting:
        return

    session_id = uuid.uuid4().hex[:8]
    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "tunnel_url": SESSION_URL,
        "restarting": restarting,
        "created_at": time.time(),
    }


async def _monitor_and_restart():
    """컨테이너 재시작을 감지하여 session_store 상태를 동기화한다."""
    while True:
        await asyncio.sleep(10)
        if not session_store:
            continue

        _, s = next(iter(session_store.items()))

        running, docker_restarting = _get_container_state(ACTIVE_CONTAINER)

        if docker_restarting:
            s["restarting"] = True
        elif running and s.get("restarting"):
            s["restarting"] = False
            s["tunnel_url"] = SESSION_URL


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


def _stop_all_containers():
    for name in ["test_kasm", ACTIVE_CONTAINER]:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


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
        session_store.clear()
        session_store[session_id] = {
            "session_id": session_id,
            "container": ACTIVE_CONTAINER,
            "tunnel_url": SESSION_URL,
            "restarting": False,
            "created_at": time.time(),
        }
        return {"session_id": session_id, "status": "starting"}

    # Tear down any existing session and create new container
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

    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "tunnel_url": SESSION_URL,
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

    # Named Tunnel은 항상 고정 URL — 컨테이너 상태만 확인
    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if restarting:
        return {"status": "starting"}
    if not running:
        return {"status": "error", "message": "컨테이너 시작 실패"}

    s["tunnel_url"] = SESSION_URL
    return {"status": "ready", "url": SESSION_URL}


@app.delete("/session/{session_id}", dependencies=[Depends(require_key)])
async def delete_session(session_id: str):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    # 컨테이너를 삭제하지 않고 중지만 — 데이터 보존 및 이어서 사용 가능
    subprocess.run(["docker", "stop", ACTIVE_CONTAINER], capture_output=True)
    session_store.clear()

    return {"status": "suspended"}


@app.post("/admin/cleanup", dependencies=[Depends(require_key)])
async def admin_cleanup():
    """중단된 Kasm 컨테이너를 즉시 정리한다."""
    removed = _cleanup_stopped_containers()
    return {"removed": removed, "count": len(removed)}
