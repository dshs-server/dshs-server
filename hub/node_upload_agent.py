"""
파일 수신 에이전트 — 각 노드 port 8100에서 실행.
허브가 서명한 토큰을 검증하고 파일을 컨테이너 바탕화면/받은파일에 저장한다.
토큰 형식: base64url("email|container|exp") + "." + HMAC-SHA256(UPLOAD_SECRET, payload_b64)
"""
import base64, hashlib, hmac, os, re, subprocess, time
from pathlib import Path
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

UPLOAD_SECRET = os.environ.get("UPLOAD_SECRET", os.environ.get("API_KEY", ""))
DESKTOP_SHARE = "/root/Desktop/받은파일"

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


def _share_key(email: str) -> str:
    return re.sub(r"[^a-z0-9._@-]", "_", (email or "anon").lower()) or "anon"


def _share_dir(email: str) -> Path:
    base = os.environ.get("SHARED_BASE", str(Path.home() / "dshs-shared"))
    return Path(base) / _share_key(email)


def _verify_token(token: str) -> tuple[str, str]:
    if not token or "." not in token:
        raise HTTPException(status_code=401, detail="업로드 토큰 없음")
    payload_b64, sig = token.rsplit(".", 1)
    expected = hmac.new(UPLOAD_SECRET.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="토큰 서명 불일치")
    try:
        pad = "=" * (-len(payload_b64) % 4)
        parts = base64.urlsafe_b64decode(payload_b64 + pad).decode().split("|")
        email, container, exp = parts[0], parts[1], float(parts[2])
    except Exception:
        raise HTTPException(status_code=401, detail="토큰 파싱 오류")
    if time.time() > exp:
        raise HTTPException(status_code=401, detail="토큰 만료")
    return email.lower(), container


def _container_running(container: str) -> bool:
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", container],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and r.stdout.strip() == "true"


def _has_mount(container: str) -> bool:
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{range .Mounts}}{{.Destination}}\n{{end}}", container],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and DESKTOP_SHARE in r.stdout


@app.post("/upload")
async def upload(
    files: list[UploadFile] = File(...),
    x_upload_token: str = Header(""),
):
    email, container = _verify_token(x_upload_token)

    share_dir = _share_dir(email)
    share_dir.mkdir(parents=True, exist_ok=True)
    share_dir.chmod(0o777)

    saved: list[str] = []
    for f in files:
        fname = Path(f.filename or "file").name or "file"
        dest = share_dir / fname
        with dest.open("wb") as out:
            while chunk := await f.read(4 * 1024 * 1024):
                out.write(chunk)
        dest.chmod(0o666)
        saved.append(fname)

    running = _container_running(container)
    if running and not _has_mount(container):
        subprocess.run(["docker", "exec", "-u", "root", container, "mkdir", "-p", DESKTOP_SHARE])
        for fname in saved:
            subprocess.run(["docker", "cp", str(share_dir / fname), f"{container}:{DESKTOP_SHARE}/"])
        subprocess.run(["docker", "exec", "-u", "root", container, "chown", "-R", "1000:1000", DESKTOP_SHARE])

    return {"uploaded": saved, "count": len(saved), "live": running}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
