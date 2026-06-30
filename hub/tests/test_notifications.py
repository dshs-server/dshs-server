import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import hub.main as m


@pytest.fixture(autouse=True)
def isolate_session_cache():
    original = dict(m._sessions_cache)
    m._sessions_cache.clear()
    with patch("hub.main._persist_sessions_cache"):
        yield
    m._sessions_cache.clear()
    m._sessions_cache.update(original)


def _set_session(sid, owner, expires_at, status="active", warning_sent=False, team_members=None):
    m._sessions_cache[sid] = {
        "owner": owner,
        "status": status,
        "expires_at": expires_at,
        "project_name": "테스트 프로젝트",
        "team_members": team_members or [],
        "warning_email_sent": warning_sent,
    }
    mock_ref = MagicMock()
    mock_ref.update = AsyncMock()
    m.db.collection.return_value.document.return_value = mock_ref
    return mock_ref


def test_warning_sent_for_session_expiring_within_7_days():
    now = time.time()
    ref = _set_session("abc", "student@school.kr", now + 3 * 86400)

    mock_send = AsyncMock(return_value=m.EmailSendResult("sent"))
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_called_once()
    args = mock_send.call_args[0]
    assert args[0] == "student@school.kr"
    assert "7일" in args[1]
    ref.update.assert_called_once_with(
        {
            "warning_email_sent": True,
            "warning_email_sent_to": ["student@school.kr"],
        }
    )


def test_warning_not_flagged_if_email_send_fails():
    now = time.time()
    ref = _set_session("abc", "student@school.kr", now + 3 * 86400)

    mock_send = AsyncMock(return_value=m.EmailSendResult("failed", "boom"))
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_called_once()
    assert m._sessions_cache["abc"]["warning_email_sent"] is False
    assert m._sessions_cache["abc"]["warning_email_sent_to"] == []
    ref.update.assert_called_once()


def test_warning_retries_only_failed_team_member():
    now = time.time()
    ref = _set_session(
        "abc",
        "owner@school.kr",
        now + 3 * 86400,
        team_members=["member@school.kr"],
    )
    first_send = AsyncMock(
        side_effect=[m.EmailSendResult("sent"), m.EmailSendResult("failed", "temporary")]
    )
    with patch("hub.main._send_email", first_send):
        asyncio.run(m._check_and_send_warnings())

    assert m._sessions_cache["abc"]["warning_email_sent"] is False
    assert m._sessions_cache["abc"]["warning_email_sent_to"] == ["owner@school.kr"]

    second_send = AsyncMock(return_value=m.EmailSendResult("sent"))
    with patch("hub.main._send_email", second_send):
        asyncio.run(m._check_and_send_warnings())

    second_send.assert_awaited_once()
    assert second_send.await_args.args[0] == "member@school.kr"
    assert m._sessions_cache["abc"]["warning_email_sent"] is True
    assert m._sessions_cache["abc"]["warning_email_sent_to"] == [
        "member@school.kr",
        "owner@school.kr",
    ]
    assert ref.update.await_count == 2


def test_warning_not_sent_if_already_flagged():
    now = time.time()
    ref = _set_session("abc", "student@school.kr", now + 3 * 86400, warning_sent=True)

    mock_send = AsyncMock()
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_not_called()
    ref.update.assert_not_called()


def test_warning_not_sent_for_session_expiring_later():
    now = time.time()
    _set_session("abc", "student@school.kr", now + 10 * 86400)

    mock_send = AsyncMock()
    with patch("hub.main._send_email", mock_send):
        asyncio.run(m._check_and_send_warnings())

    mock_send.assert_not_called()


def _setup_delete_session_mocks(session_data):
    m._sessions_cache["abc123"] = dict(session_data)
    mock_ref = MagicMock()
    mock_ref.update = AsyncMock()
    mock_ref.delete = AsyncMock()
    m.db.collection.return_value.document.return_value = mock_ref
    return mock_ref


def test_delete_session_suspend_sends_email():
    session_data = {
        "owner": "user@school.kr",
        "status": "active",
        "node_id": "server-01",
        "project_name": "내 프로젝트",
        "port": 8081,
    }
    _setup_delete_session_mocks(session_data)
    mock_node = {"id": "server-01", "ip": "10.0.0.1", "ssh_user": "admin-swai", "kasm_url": "https://kasm.dshs-app.net"}
    mock_send = AsyncMock(return_value=m.EmailSendResult("sent"))

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
    session_data = {
        "owner": "user@school.kr",
        "status": "active",
        "node_id": "server-01",
        "project_name": "내 프로젝트",
        "port": 8081,
    }
    _setup_delete_session_mocks(session_data)
    mock_node = {"id": "server-01", "ip": "10.0.0.1", "ssh_user": "admin-swai", "kasm_url": "https://kasm.dshs-app.net"}
    mock_send = AsyncMock(return_value=m.EmailSendResult("sent"))

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


def test_admin_email_preview_returns_html():
    client = TestClient(m.app)
    resp = client.post(
        "/admin/email/preview",
        headers={"x-api-key": m.API_KEY},
        json={"kind": "warning", "project_name": "미리보기 테스트"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["subject"].startswith("[PC대여]")
    assert "<html lang='ko'>" in data["html"]
    assert data["runtime"]["portal_url"] == m.PORTAL_URL


def test_admin_email_preview_includes_actor():
    client = TestClient(m.app)
    resp = client.post(
        "/admin/email/preview",
        headers={"x-api-key": m.API_KEY},
        json={
            "kind": "suspend",
            "project_name": "협업 프로젝트",
            "actor": "member@school.kr",
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert "member@school.kr" in data["text"]
    assert "처리한 사람" in data["html"]


def test_admin_email_test_returns_send_result():
    mock_send = AsyncMock(return_value=m.EmailSendResult("sent"))
    client = TestClient(m.app)
    with patch("hub.main._send_email", mock_send):
        resp = client.post(
            "/admin/email/test",
            headers={"x-api-key": m.API_KEY},
            json={"kind": "suspend", "to": "tester@school.kr", "project_name": "테스트"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "sent"
    assert data["to"] == "tester@school.kr"
    mock_send.assert_called_once()


def test_admin_terminate_notifies_session_recipients():
    m._sessions_cache["abc123"] = {
        "owner": "user@school.kr",
        "team_members": ["member@school.kr"],
        "status": "active",
        "node_id": "server-01",
        "project_name": "관리자 종료 테스트",
    }
    mock_ref = MagicMock()
    mock_ref.update = AsyncMock()
    m.db.collection.return_value.document.return_value = mock_ref
    mock_node = {"id": "server-01", "ip": "10.0.0.1", "ssh_user": "admin-swai"}
    mock_notify = AsyncMock(return_value=m.EmailBatchResult({}))

    with (
        patch("hub.main._get_node", AsyncMock(return_value=mock_node)),
        patch("hub.main._ssh", AsyncMock(return_value=("", 0))),
        patch("hub.main._send_session_email", mock_notify),
    ):
        client = TestClient(m.app)
        resp = client.post(
            "/admin/terminate",
            headers={"x-api-key": m.API_KEY, "x-user-email": "admin@school.kr"},
        )

    assert resp.status_code == 200
    assert resp.json()["count"] == 1
    mock_notify.assert_awaited_once()
    assert mock_notify.await_args.args[:2] == ("admin_suspend", "abc123")
    assert mock_notify.await_args.kwargs["actor"] == "admin@school.kr"
