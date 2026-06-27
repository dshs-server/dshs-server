import asyncio
import json
import os
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware

API_KEY = os.environ.get("API_KEY", "dev-secret-change-me")

# 세션 최대 사용 시간(분). 초과 시 자동 suspend. 0 이하면 제한 없음.
SESSION_MAX_MINUTES = int(os.environ.get("SESSION_MAX_MINUTES", "120"))

ACTIVE_CONTAINER = "active_session"
SESSION_URL = os.environ.get("SESSION_URL", "https://kasm.dshs-app.net")
SESSION_STATE_FILE = Path(
    os.environ.get(
        "SESSION_STATE_FILE",
        str(Path.home() / ".dshs-server-session.json"),
    )
)

# In-memory session store (single session MVP)
session_store: dict = {}

# 대기열 (FIFO, 이메일 문자열). 단일 머신이라 한 명만 점유 가능.
queue: list[str] = []

# 공지사항 (관리자가 설정, 인메모리)
notice_text: str = ""


def _load_session_state() -> dict:
    """재시작 및 suspend 후에도 유지할 최소 세션 메타데이터를 읽는다."""
    try:
        data = json.loads(SESSION_STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_session_state(owner: Optional[str], created_at: float) -> None:
    """소유자와 시작 시각을 원자적으로 저장한다."""
    SESSION_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_path = SESSION_STATE_FILE.with_suffix(".tmp")
    temp_path.write_text(
        json.dumps(
            {"owner": owner, "created_at": created_at},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    temp_path.replace(SESSION_STATE_FILE)


def _clear_session_state() -> None:
    SESSION_STATE_FILE.unlink(missing_ok=True)


def _mask_email(email: str) -> str:
    """이메일을 부분 마스킹한다. abc@ts.hs.kr → ab***@ts.hs.kr"""
    if not email or "@" not in email:
        return email or "익명"
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        masked = local[0] + "***"
    else:
        masked = local[:2] + "***"
    return f"{masked}@{domain}"


def _session_expires_at(s: dict) -> Optional[float]:
    if SESSION_MAX_MINUTES <= 0:
        return None
    return s.get("created_at", time.time()) + SESSION_MAX_MINUTES * 60


def _active_owner() -> Optional[str]:
    """현재 활성 세션의 소유자 이메일. 없으면 None."""
    if not session_store:
        return None
    _, s = next(iter(session_store.items()))
    return s.get("owner")


KASM_IMAGE = "dshs-kasm-win10"


def _cleanup_stopped_containers() -> list[str]:
    """중단된 Kasm 컨테이너를 제거하고 삭제된 이름 목록을 반환한다.
    ACTIVE_CONTAINER는 저장된 세션일 수 있으므로 제외한다."""
    result = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"ancestor={KASM_IMAGE}:latest",
         "--filter", "status=exited",
         "--format", "{{.Names}}"],
        capture_output=True, text=True,
    )
    # exited가 아닌 dead/created 상태도 포함
    result2 = subprocess.run(
        ["docker", "ps", "-a",
         "--filter", f"ancestor={KASM_IMAGE}:latest",
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

    saved = _load_session_state()
    session_id = uuid.uuid4().hex[:8]
    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "tunnel_url": SESSION_URL if running else None,
        "restarting": restarting,
        "created_at": saved.get("created_at", time.time()),
        "owner": saved.get("owner"),
    }


async def _monitor_and_restart():
    """컨테이너 재시작을 감지하여 session_store 상태를 동기화한다."""
    while True:
        await asyncio.sleep(10)
        if not session_store:
            continue

        sid, s = next(iter(session_store.items()))

        # 시간 초과 자동 suspend
        expires_at = _session_expires_at(s)
        if expires_at and time.time() >= expires_at:
            subprocess.run(["docker", "stop", ACTIVE_CONTAINER], capture_output=True)
            session_store.clear()
            continue

        running, docker_restarting = _get_container_state(ACTIVE_CONTAINER)

        if docker_restarting:
            # 컨테이너가 재시작 중 → 클라이언트에 starting 상태 표시
            s["restarting"] = True

        elif running and s.get("restarting"):
            s["tunnel_url"] = SESSION_URL
            s["restarting"] = False


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


async def require_user(x_user_email: str = Header("")):
    if not (x_user_email or "").strip():
        raise HTTPException(status_code=401, detail="Login required")


def _stop_all_containers():
    # Stop the legacy test container and any active session container
    for name in ["test_kasm", ACTIVE_CONTAINER]:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get(
    "/session",
    dependencies=[Depends(require_key), Depends(require_user)],
)
async def get_active_session(
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    me = (x_user_email or "").lower()
    is_admin = x_user_admin == "1"

    if not session_store:
        # 활성 세션 없음 — 대기열 처리
        if me and queue:
            if queue[0] == me:
                queue.pop(0)  # 내 차례 → 시작 가능
                return {"status": "your_turn"}
            if me in queue:
                return {"status": "queued", "queue_position": queue.index(me) + 1,
                        "queue_length": len(queue)}
        if _is_container_exited(ACTIVE_CONTAINER):
            saved_owner = (_load_session_state().get("owner") or "").lower()
            if is_admin or (saved_owner and saved_owner == me):
                return {"status": "suspended"}
            # 다른 사용자의 저장된 환경은 노출하지 않고 새 대여만 허용한다.
            return {"status": "none"}
        return {"status": "none"}

    session_id, s = next(iter(session_store.items()))
    owner = (s.get("owner") or "").lower()

    # 소유자 메타데이터가 없는 복원 세션은 관리자만 접근할 수 있다.
    if not owner and not is_admin:
        return {"status": "busy", "owner": "관리자 확인 필요"}

    # 다른 사용자가 점유 중 → busy / queued
    if me and owner and me != owner and not is_admin:
        if me in queue:
            return {"status": "queued", "owner": _mask_email(owner),
                    "queue_position": queue.index(me) + 1, "queue_length": len(queue)}
        return {"status": "busy", "owner": _mask_email(owner)}

    expires_at = _session_expires_at(s)

    # 컨테이너 재시작 중이면 starting 반환
    if s.get("restarting"):
        return {"status": "starting", "session_id": session_id}

    if s["tunnel_url"]:
        return {"status": "ready", "session_id": session_id,
                "url": s["tunnel_url"], "expires_at": expires_at}

    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if not running and not restarting:
        return {"status": "none"}

    return {"status": "starting", "session_id": session_id}


@app.post(
    "/session",
    dependencies=[Depends(require_key), Depends(require_user)],
)
async def create_session(
    resume: bool = Query(False),
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    session_id = uuid.uuid4().hex[:8]
    me = (x_user_email or "").lower()
    is_admin = x_user_admin == "1"

    # 다른 사용자가 점유 중이면 409 + 대기열 등록
    owner = (_active_owner() or "").lower()
    if owner and me and owner != me and not is_admin:
        if me not in queue:
            queue.append(me)
        raise HTTPException(
            status_code=409,
            detail={"owner": _mask_email(owner),
                    "queue_position": queue.index(me) + 1},
        )

    # 내 차례가 되어 시작 → 대기열에서 제거
    if me and me in queue:
        queue.remove(me)

    if resume:
        saved_owner = (_load_session_state().get("owner") or "").lower()
        if not is_admin and (not saved_owner or saved_owner != me):
            raise HTTPException(
                status_code=403,
                detail="본인의 저장된 세션만 이어서 사용할 수 있습니다.",
            )

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
        created_at = time.time()
        session_store[session_id] = {
            "session_id": session_id,
            "container": ACTIVE_CONTAINER,
            "tunnel_url": SESSION_URL,
            "restarting": False,
            "created_at": created_at,
            "owner": me or None,
        }
        _save_session_state(me or None, created_at)
        return {"session_id": session_id, "status": "starting"}

    # Tear down any existing session and create new container
    _stop_all_containers()
    session_store.clear()
    _clear_session_state()

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
            f"{KASM_IMAGE}:latest",
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

    created_at = time.time()
    session_store[session_id] = {
        "session_id": session_id,
        "container": ACTIVE_CONTAINER,
        "tunnel_url": SESSION_URL,
        "restarting": False,
        "created_at": created_at,
        "owner": me or None,
    }
    _save_session_state(me or None, created_at)

    return {"session_id": session_id, "status": "starting"}


@app.get(
    "/session/{session_id}",
    dependencies=[Depends(require_key), Depends(require_user)],
)
async def get_session(
    session_id: str,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    s = session_store[session_id]
    me = (x_user_email or "").lower()
    owner = (s.get("owner") or "").lower()
    if x_user_admin != "1" and (not owner or owner != me):
        raise HTTPException(status_code=403, detail="본인 세션만 조회할 수 있습니다.")

    # 재시작 대기 중이면 starting 반환
    if s.get("restarting"):
        return {"status": "starting"}

    if s["tunnel_url"]:
        return {"status": "ready", "url": s["tunnel_url"]}

    # Named Tunnel은 고정 URL이므로 컨테이너 상태만 확인한다.
    running, restarting = _get_container_state(ACTIVE_CONTAINER)
    if restarting:
        return {"status": "starting"}
    if not running:
        return {"status": "error", "message": "컨테이너 시작 실패"}

    s["tunnel_url"] = SESSION_URL
    return {"status": "ready", "url": SESSION_URL}


@app.delete(
    "/session/{session_id}",
    dependencies=[Depends(require_key), Depends(require_user)],
)
async def delete_session(
    session_id: str,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    if session_id not in session_store:
        raise HTTPException(status_code=404, detail="Session not found")

    # 소유자 또는 관리자만 종료 가능
    me = (x_user_email or "").lower()
    owner = (session_store[session_id].get("owner") or "").lower()
    if x_user_admin != "1" and (not owner or owner != me):
        raise HTTPException(status_code=403, detail="본인 세션만 종료할 수 있습니다.")

    # 컨테이너를 삭제하지 않고 중지만 — 데이터 보존 및 이어서 사용 가능
    subprocess.run(["docker", "stop", ACTIVE_CONTAINER], capture_output=True)
    session_store.clear()

    return {"status": "suspended"}


@app.post("/admin/cleanup", dependencies=[Depends(require_key)])
async def admin_cleanup():
    """중단된 Kasm 컨테이너를 즉시 정리한다."""
    removed = _cleanup_stopped_containers()
    return {"removed": removed, "count": len(removed)}


@app.post("/admin/terminate", dependencies=[Depends(require_key)])
async def admin_terminate():
    """관리자가 현재 활성 세션을 강제로 종료(suspend)한다."""
    subprocess.run(["docker", "stop", ACTIVE_CONTAINER], capture_output=True)
    session_store.clear()
    return {"status": "terminated"}


@app.get("/admin/status", dependencies=[Depends(require_key)])
async def admin_status():
    """관리자용: 현재 세션 소유자·만료시각·대기열 조회."""
    active = None
    if session_store:
        sid, s = next(iter(session_store.items()))
        if s.get("restarting"):
            st = "starting"
        elif s.get("tunnel_url"):
            st = "ready"
        else:
            st = "starting"
        active = {
            "owner": _mask_email(s.get("owner") or "익명"),
            "since": s.get("created_at"),
            "expires_at": _session_expires_at(s),
            "url": s.get("tunnel_url"),
            "status": st,
        }
    return {
        "active": active,
        "queue": [_mask_email(e) for e in queue],
        "max_minutes": SESSION_MAX_MINUTES,
    }


@app.get("/notice", dependencies=[Depends(require_key)])
async def get_notice():
    return {"notice": notice_text or None}


@app.post("/notice", dependencies=[Depends(require_key)])
async def set_notice(payload: dict):
    global notice_text
    notice_text = (payload.get("notice") or "").strip()
    return {"notice": notice_text or None}
