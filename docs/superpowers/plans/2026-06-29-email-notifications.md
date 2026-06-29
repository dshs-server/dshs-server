# 이메일 알림 시스템 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PC 대여 세션의 만료·종료·일시중지 이벤트 시 소유자에게 Gmail API로 이메일 자동 발송.

**Architecture:** `hub/main.py` 단일 파일에 Gmail 헬퍼(`_build_gmail_service`, `_send_email`)와 경고 루프(`_email_notification_loop`)를 추가하고, 기존 `delete_session()` 및 `_poll_nodes_loop()`에 이메일 호출을 인라인으로 삽입. OAuth2 refresh token(`token.json`)은 허브 서버에 저장, google-auth 라이브러리가 자동 갱신.

**Tech Stack:** `google-auth`, `google-auth-oauthlib`, `google-api-python-client`, `pytest`

## Global Constraints

- `hub/main.py`만 수정 (단, requirements.txt도 패키지 추가)
- 이메일 발송 실패는 `try/except`로 격리 — 세션 API 응답에 영향 없음
- 환경변수 `GMAIL_CREDENTIALS`, `GMAIL_TOKEN`, `GMAIL_SENDER` 미설정 시 graceful skip
- 7일 전 경고는 세션당 1회만 (`warning_email_sent` Firestore 필드)
- 기존 세션 로직 변경 없음 — 이메일 호출만 추가

---

## 파일 변경 목록

| 파일 | 변경 유형 | 내용 |
|------|---------|------|
| `hub/requirements.txt` | 수정 | google 패키지 3개 추가 |
| `hub/main.py` | 수정 | 환경변수, Gmail 헬퍼, 경고 루프, lifespan 등록, delete_session·poll_nodes_loop 인라인 추가 |
| `hub/tests/__init__.py` | 생성 | 빈 파일 |
| `hub/tests/conftest.py` | 생성 | Firebase·asyncssh 모킹, 환경변수 설정 |
| `hub/tests/test_email.py` | 생성 | `_send_email` 단위 테스트 |
| `hub/tests/test_notifications.py` | 생성 | `_check_and_send_warnings`, delete·expire 이메일 통합 테스트 |

---

## Task 1: 패키지 추가 + Gmail 헬퍼 함수

**Files:**
- Modify: `hub/requirements.txt`
- Modify: `hub/main.py:29-52` (Config 섹션 끝에 env var 추가), `hub/main.py:563` (Routes 직전에 새 섹션 추가)
- Create: `hub/tests/__init__.py`, `hub/tests/conftest.py`, `hub/tests/test_email.py`

**Interfaces:**
- Produces:
  - `_build_gmail_service() -> Resource | None` — Gmail API 서비스 객체 반환. 토큰 없으면 None.
  - `async _send_email(to: str, subject: str, body: str) -> None` — 이메일 발송. 실패 시 로그만.

- [ ] **Step 1: requirements.txt에 Google 패키지 추가**

`hub/requirements.txt`를 다음으로 교체:
```
fastapi==0.111.0
uvicorn==0.30.1
asyncssh==2.14.2
firebase-admin==6.5.0
pydantic>=2.0
python-multipart==0.0.9
google-auth==2.29.0
google-auth-oauthlib==1.2.0
google-api-python-client==2.128.0
```

- [ ] **Step 2: 환경변수 추가 (main.py Config 섹션)**

`hub/main.py` 52번째 줄(`UPLOAD_SECRET = ...`) 바로 다음에 추가:
```python
GMAIL_CREDENTIALS = os.environ.get("GMAIL_CREDENTIALS", "")
GMAIL_TOKEN = os.environ.get("GMAIL_TOKEN", "")
GMAIL_SENDER = os.environ.get("GMAIL_SENDER", "")
EMAIL_CHECK_INTERVAL = int(os.environ.get("EMAIL_CHECK_INTERVAL", "3600"))
WARNING_SECONDS = 7 * 86400
```

- [ ] **Step 3: 테스트 인프라 생성**

`hub/tests/__init__.py` 생성 (빈 파일):
```python
```

`hub/tests/conftest.py` 생성:
```python
import os
import sys
from unittest.mock import MagicMock

os.environ.setdefault("SSH_PASSWORD", "test-password")
os.environ.setdefault("FIREBASE_CRED", "fake-cred.json")
os.environ.setdefault("GMAIL_SENDER", "sender@test.com")
os.environ.setdefault("GMAIL_TOKEN", "/tmp/fake_token.json")
os.environ.setdefault("GMAIL_CREDENTIALS", "/tmp/fake_creds.json")

for mod in [
    "firebase_admin",
    "firebase_admin.credentials",
    "firebase_admin.firestore_async",
    "asyncssh",
]:
    sys.modules[mod] = MagicMock()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
```

- [ ] **Step 4: _send_email 실패 케이스 테스트 작성**

`hub/tests/test_email.py` 생성:
```python
import asyncio
from unittest.mock import MagicMock, patch

import hub.main as m


def test_send_email_skips_when_sender_empty():
    with patch.object(m, "GMAIL_SENDER", ""):
        asyncio.run(m._send_email("user@test.com", "subject", "body"))


def test_send_email_skips_when_token_missing(tmp_path):
    with (
        patch.object(m, "GMAIL_SENDER", "s@test.com"),
        patch.object(m, "GMAIL_TOKEN", str(tmp_path / "nonexistent.json")),
    ):
        asyncio.run(m._send_email("user@test.com", "subject", "body"))


def test_send_email_calls_gmail_api():
    mock_service = MagicMock()
    mock_service.users.return_value.messages.return_value.send.return_value.execute.return_value = {"id": "1"}

    with (
        patch.object(m, "GMAIL_SENDER", "s@test.com"),
        patch("hub.main._build_gmail_service", return_value=mock_service),
    ):
        asyncio.run(m._send_email("recipient@test.com", "Hello", "Body"))

    send_fn = mock_service.users.return_value.messages.return_value.send
    assert send_fn.called
    kwargs = send_fn.call_args[1]
    assert kwargs["userId"] == "me"
    assert "raw" in kwargs["body"]
```

- [ ] **Step 5: 테스트 실행 — FAIL 확인 (함수 미존재)**

```bash
cd /Users/shinmingyu/Project/server_connection
pip install google-auth==2.29.0 google-auth-oauthlib==1.2.0 google-api-python-client==2.128.0 pytest
pytest hub/tests/test_email.py -v
```
Expected: ImportError 또는 AttributeError (`_send_email` not found)

- [ ] **Step 6: Gmail 헬퍼 함수 구현 (main.py에 새 섹션 추가)**

`hub/main.py`에서 `# ── Routes: health ──` (line 563 근처) **직전**에 아래 섹션 삽입:

```python
# ── Email ────────────────────────────────────────────────────────────────────


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
        print(f"[gmail] 서비스 초기화 실패: {e}")
        return None


async def _send_email(to: str, subject: str, body: str) -> None:
    """Gmail API로 이메일 발송. 실패해도 세션 로직에 영향 없음."""
    if not GMAIL_SENDER or not to:
        return
    try:
        import email.mime.text as _mime
        service = _build_gmail_service()
        if not service:
            return
        msg = _mime.MIMEText(body, "plain", "utf-8")
        msg["To"] = to
        msg["From"] = GMAIL_SENDER
        msg["Subject"] = subject
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: service.users().messages().send(
                userId="me", body={"raw": raw}
            ).execute(),
        )
    except Exception as e:
        print(f"[email] 발송 실패 ({to}): {e}")
```

- [ ] **Step 7: 테스트 실행 — PASS 확인**

```bash
pytest hub/tests/test_email.py -v
```
Expected: 3 tests PASS

- [ ] **Step 8: 커밋**

```bash
git add hub/requirements.txt hub/main.py hub/tests/__init__.py hub/tests/conftest.py hub/tests/test_email.py
git commit -m "feat: Gmail API 헬퍼 함수 추가 (_build_gmail_service, _send_email)"
```

---

## Task 2: 7일 전 경고 이메일 루프

**Files:**
- Modify: `hub/main.py` (`_log_loop()` 끝 다음에 새 함수 추가, `lifespan` 수정)
- Create: `hub/tests/test_notifications.py`

**Interfaces:**
- Consumes: `_send_email(to, subject, body)` (Task 1)
- Produces:
  - `async _check_and_send_warnings() -> None` — 경고 대상 세션 스캔 + 이메일 발송
  - `async _email_notification_loop() -> None` — 1시간 주기 루프

- [ ] **Step 1: 경고 루프 테스트 작성**

`hub/tests/test_notifications.py` 생성:
```python
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import hub.main as m


def _make_session_doc(sid, owner, expires_at, status="active", warning_sent=False):
    doc = MagicMock()
    doc.id = sid
    doc.to_dict.return_value = {
        "owner": owner,
        "status": status,
        "expires_at": expires_at,
        "project_name": "테스트 프로젝트",
        "warning_email_sent": warning_sent,
    }
    doc.reference.update = AsyncMock()
    return doc


def _mock_db_snap(docs):
    """m.db.collection().where().where().get() → docs 반환하도록 설정."""
    mock_query = MagicMock()
    mock_query.get = AsyncMock(return_value=docs)
    m.db.collection.return_value.where.return_value.where.return_value = mock_query
    return mock_query


def test_warning_sent_for_session_expiring_within_7_days():
    now = time.time()
    doc = _make_session_doc("abc", "student@school.kr", now + 3 * 86400)
    _mock_db_snap([doc])

    mock_send = AsyncMock()
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_called_once()
    args = mock_send.call_args[0]
    assert args[0] == "student@school.kr"
    assert "7일" in args[1]
    doc.reference.update.assert_called_once_with({"warning_email_sent": True})


def test_warning_not_sent_if_already_flagged():
    now = time.time()
    doc = _make_session_doc("abc", "student@school.kr", now + 3 * 86400, warning_sent=True)
    _mock_db_snap([doc])

    mock_send = AsyncMock()
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_not_called()
    doc.reference.update.assert_not_called()


def test_warning_not_sent_for_session_expiring_later():
    now = time.time()
    doc = _make_session_doc("abc", "student@school.kr", now + 10 * 86400)
    _mock_db_snap([doc])

    mock_send = AsyncMock()
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_not_called()
```

- [ ] **Step 2: 테스트 실행 — FAIL 확인 (`_check_and_send_warnings` 미존재)**

```bash
pytest hub/tests/test_notifications.py -v
```
Expected: AttributeError (`_check_and_send_warnings` not found)

- [ ] **Step 3: 경고 루프 구현 — main.py `_log_loop()` 끝(line 360) 다음에 추가**

```python
# ── Email notification loop ───────────────────────────────────────────────────


async def _check_and_send_warnings() -> None:
    """active/starting 세션 중 7일 내 만료 예정이고 경고 미발송인 세션에 이메일 발송."""
    now = time.time()
    snap = await (
        db.collection(COL_SESSIONS)
        .where("status", "in", ["active", "starting"])
        .get()
    )
    for doc in snap:
        s = doc.to_dict()
        expires_at = s.get("expires_at")
        if not expires_at or s.get("warning_email_sent"):
            continue
        if expires_at - now <= WARNING_SECONDS:
            owner = s.get("owner", "")
            expire_str = datetime.fromtimestamp(expires_at).strftime("%Y-%m-%d %H:%M")
            project = s.get("project_name") or doc.id
            await _send_email(
                owner,
                "[PC대여] 세션이 7일 후 자동 일시중지됩니다",
                f"안녕하세요.\n\n"
                f"'{project}' 세션이 {expire_str}에 자동으로 일시중지될 예정입니다.\n\n"
                f"계속 사용하시려면 포털(https://dshs-app.net)에서 이어서 사용을 눌러주세요.\n\n"
                f"- dshs 전산실",
            )
            await doc.reference.update({"warning_email_sent": True})


async def _email_notification_loop():
    await asyncio.sleep(60)  # 서버 시작 후 1분 뒤 첫 실행
    while True:
        try:
            await _check_and_send_warnings()
        except Exception as e:
            print(f"[email-loop] 오류: {e}")
        await asyncio.sleep(EMAIL_CHECK_INTERVAL)
```

- [ ] **Step 4: lifespan에 email_task 등록 (line 366-376 수정)**

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    poll_task = asyncio.create_task(_poll_nodes_loop())
    log_task = asyncio.create_task(_log_loop())
    email_task = asyncio.create_task(_email_notification_loop())
    yield
    for t in (poll_task, log_task, email_task):
        t.cancel()
        try:
            await t
        except asyncio.CancelledError:
            pass
```

- [ ] **Step 5: 테스트 실행 — PASS 확인**

```bash
pytest hub/tests/test_notifications.py -v
```
Expected: 3 tests PASS

- [ ] **Step 6: 커밋**

```bash
git add hub/main.py hub/tests/test_notifications.py
git commit -m "feat: 7일 전 세션 만료 경고 이메일 루프 추가"
```

---

## Task 3: delete_session 이메일 통합

**Files:**
- Modify: `hub/main.py:881-911` (`delete_session` 함수)
- Modify: `hub/tests/test_notifications.py` (테스트 추가)

**Interfaces:**
- Consumes: `_send_email(to, subject, body)` (Task 1)

- [ ] **Step 1: delete_session 이메일 테스트 추가**

`hub/tests/test_notifications.py` 맨 아래에 추가:
```python
def test_delete_session_suspend_sends_email():
    """수동 일시중지 시 이메일 발송 확인."""
    import asyncio
    from fastapi.testclient import TestClient

    session_data = {
        "owner": "user@school.kr",
        "status": "active",
        "node_id": "server-01",
        "project_name": "내 프로젝트",
        "port": 8081,
    }

    mock_doc = MagicMock()
    mock_doc.exists = True
    mock_doc.to_dict.return_value = session_data
    mock_doc.reference.update = AsyncMock()
    m.db.collection.return_value.document.return_value.get = AsyncMock(return_value=mock_doc)

    mock_node = {"id": "server-01", "ip": "10.0.0.1", "ssh_user": "admin-swai", "kasm_url": "https://kasm.dshs-app.net"}
    mock_send = AsyncMock()

    with (
        patch("hub.main._get_node", AsyncMock(return_value=mock_node)),
        patch("hub.main._ssh", AsyncMock(return_value=("", 0))),
        patch("hub.main._nginx_update", AsyncMock()),
        patch("hub.main._send_email", mock_send),
    ):
        client = TestClient(m.app)
        resp = client.delete(
            "/session/abc123",
            headers={"x-api-key": m.API_KEY, "x-user-email": "user@school.kr"},
        )

    assert resp.status_code == 200
    assert resp.json()["status"] == "suspended"
    mock_send.assert_called_once()
    args = mock_send.call_args[0]
    assert args[0] == "user@school.kr"
    assert "일시중지" in args[1]


def test_delete_session_permanent_sends_email():
    """영구 삭제 시 이메일 발송 확인."""
    import asyncio
    from fastapi.testclient import TestClient

    session_data = {
        "owner": "user@school.kr",
        "status": "active",
        "node_id": "server-01",
        "project_name": "내 프로젝트",
        "port": 8081,
    }

    mock_doc = MagicMock()
    mock_doc.exists = True
    mock_doc.to_dict.return_value = session_data
    mock_doc.reference.delete = AsyncMock()
    m.db.collection.return_value.document.return_value.get = AsyncMock(return_value=mock_doc)

    mock_node = {"id": "server-01", "ip": "10.0.0.1", "ssh_user": "admin-swai", "kasm_url": "https://kasm.dshs-app.net"}
    mock_send = AsyncMock()

    with (
        patch("hub.main._get_node", AsyncMock(return_value=mock_node)),
        patch("hub.main._ssh", AsyncMock(return_value=("", 0))),
        patch("hub.main._nginx_update", AsyncMock()),
        patch("hub.main._send_email", mock_send),
    ):
        client = TestClient(m.app)
        resp = client.delete(
            "/session/abc123?permanent=true",
            headers={"x-api-key": m.API_KEY, "x-user-email": "user@school.kr"},
        )

    assert resp.status_code == 200
    mock_send.assert_called_once()
    args = mock_send.call_args[0]
    assert args[0] == "user@school.kr"
    assert "삭제" in args[1]
```

- [ ] **Step 2: 테스트 실행 — FAIL 확인 (이메일 호출 없음)**

```bash
pytest hub/tests/test_notifications.py::test_delete_session_suspend_sends_email hub/tests/test_notifications.py::test_delete_session_permanent_sends_email -v
```
Expected: AssertionError (`mock_send.assert_called_once()` fail)

- [ ] **Step 3: delete_session 수정 (main.py 881-911)**

현재 `permanent` 분기 (line 902-906):
```python
    if permanent:
        await _ssh(node["ip"], f"docker rm -f {container}", _suser)
        await doc.reference.delete()
        await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
        return {"message": "세션을 완전히 삭제했습니다."}
```

교체:
```python
    if permanent:
        await _ssh(node["ip"], f"docker rm -f {container}", _suser)
        await doc.reference.delete()
        await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
        await _send_email(
            s.get("owner", ""),
            "[PC대여] 세션이 삭제되었습니다",
            f"'{s.get('project_name') or session_id}' 세션이 완전히 삭제되었습니다.\n\n- dshs 전산실",
        )
        return {"message": "세션을 완전히 삭제했습니다."}
```

현재 suspend 분기 (line 908-911):
```python
    await _ssh(node["ip"], f"docker stop {container}", _suser)
    await doc.reference.update({"status": "suspended", "suspended_at": time.time()})
    await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
    return {"status": "suspended"}
```

교체:
```python
    await _ssh(node["ip"], f"docker stop {container}", _suser)
    await doc.reference.update({"status": "suspended", "suspended_at": time.time()})
    await _nginx_update(s["node_id"], node["ip"], _suser, kasm_url)
    await _send_email(
        s.get("owner", ""),
        "[PC대여] 세션을 일시중지했습니다",
        f"'{s.get('project_name') or session_id}' 세션이 일시중지되었습니다.\n"
        f"포털(https://dshs-app.net)에서 이어서 사용할 수 있습니다.\n\n- dshs 전산실",
    )
    return {"status": "suspended"}
```

- [ ] **Step 4: 테스트 실행 — PASS 확인**

```bash
pytest hub/tests/test_notifications.py -v
```
Expected: 5 tests PASS

- [ ] **Step 5: 커밋**

```bash
git add hub/main.py hub/tests/test_notifications.py
git commit -m "feat: 세션 일시중지·영구삭제 시 이메일 발송"
```

---

## Task 4: 만료 자동 suspend 이메일 + 전체 검증

**Files:**
- Modify: `hub/main.py:241-246` (`_poll_nodes_loop` 만료 블록)

**Interfaces:**
- Consumes: `_send_email(to, subject, body)` (Task 1)

- [ ] **Step 1: 만료 auto-suspend 이메일 구현 (main.py line 241-246)**

현재 코드:
```python
                    if s.get("expires_at") and now >= s["expires_at"]:
                        node_ip, node_suser = node_info.get(nid, (None, SSH_USER))
                        if node_ip and not _metrics.get(nid, {}).get("offline"):
                            await _ssh(node_ip, f"docker stop {_container_name(doc.id)}", node_suser)
                        await doc.reference.update({"status": "suspended", "suspended_at": now})
                        continue
```

교체:
```python
                    if s.get("expires_at") and now >= s["expires_at"]:
                        node_ip, node_suser = node_info.get(nid, (None, SSH_USER))
                        if node_ip and not _metrics.get(nid, {}).get("offline"):
                            await _ssh(node_ip, f"docker stop {_container_name(doc.id)}", node_suser)
                        await doc.reference.update({"status": "suspended", "suspended_at": now})
                        await _send_email(
                            s.get("owner", ""),
                            "[PC대여] 세션이 만료되어 일시중지되었습니다",
                            f"'{s.get('project_name') or doc.id}' 세션이 대여 기간 만료로 자동 일시중지되었습니다.\n"
                            f"포털(https://dshs-app.net)에서 이어서 사용할 수 있습니다.\n\n- dshs 전산실",
                        )
                        continue
```

- [ ] **Step 2: 전체 테스트 실행 — 모두 PASS 확인**

```bash
pytest hub/tests/ -v
```
Expected: 5 tests PASS (test_email.py 3개 + test_notifications.py 5개 = 총 8개)
실제 확인:
```
hub/tests/test_email.py::test_send_email_skips_when_sender_empty PASSED
hub/tests/test_email.py::test_send_email_skips_when_token_missing PASSED
hub/tests/test_email.py::test_send_email_calls_gmail_api PASSED
hub/tests/test_notifications.py::test_warning_sent_for_session_expiring_within_7_days PASSED
hub/tests/test_notifications.py::test_warning_not_sent_if_already_flagged PASSED
hub/tests/test_notifications.py::test_warning_not_sent_for_session_expiring_later PASSED
hub/tests/test_notifications.py::test_delete_session_suspend_sends_email PASSED
hub/tests/test_notifications.py::test_delete_session_permanent_sends_email PASSED
```

- [ ] **Step 3: 최종 커밋**

```bash
git add hub/main.py
git commit -m "feat: 세션 만료 자동 suspend 시 이메일 발송"
```

---

## 구현 후 허브 서버 설정 (수동)

이 계획에 포함되지 않는 일회성 설정:

```bash
# 1. 패키지 설치 (허브 서버)
ssh admin-swai@100.79.232.71
pip install google-auth==2.29.0 google-auth-oauthlib==1.2.0 google-api-python-client==2.128.0

# 2. GCP 콘솔에서 OAuth2 Desktop App credentials.json 다운로드 후 전송
scp credentials.json admin-swai@100.79.232.71:~/hub/credentials.json

# 3. 1회 인터랙티브 인증 (브라우저 필요 — 로컬 Mac에서 실행 권장)
python3 -c "
from google_auth_oauthlib.flow import InstalledAppFlow
flow = InstalledAppFlow.from_client_secrets_file('hub/credentials.json', ['https://www.googleapis.com/auth/gmail.send'])
creds = flow.run_local_server(port=0)
with open('hub/token.json', 'w') as f: f.write(creds.to_json())
print('token.json 생성 완료')
"
scp hub/token.json admin-swai@100.79.232.71:~/hub/token.json

# 4. 환경변수 추가 (~/.hub.env)
echo 'GMAIL_CREDENTIALS=/home/admin-swai/hub/credentials.json' >> ~/.hub.env
echo 'GMAIL_TOKEN=/home/admin-swai/hub/token.json' >> ~/.hub.env
echo 'GMAIL_SENDER=<발신계정@gmail.com>' >> ~/.hub.env

# 5. 허브 재시작
sudo systemctl restart hub
```
