import asyncio
import base64
import tempfile
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import hub.main as m


def test_send_email_skips_when_sender_empty():
    with patch.object(m, "GMAIL_SENDER", ""):
        result = asyncio.run(m._send_email("user@test.com", "subject", "body"))
    assert result.state == "skipped"


def test_send_email_skips_when_token_missing():
    with tempfile.TemporaryDirectory() as tmpdir:
        missing = Path(tmpdir) / "nonexistent.json"
        with (
            patch.object(m, "GMAIL_SENDER", "s@test.com"),
            patch.object(m, "GMAIL_TOKEN", str(missing)),
        ):
            result = asyncio.run(m._send_email("user@test.com", "subject", "body"))
    assert result.state == "skipped"


def test_send_email_calls_gmail_api():
    mock_service = MagicMock()
    mock_service.users.return_value.messages.return_value.send.return_value.execute.return_value = {"id": "1"}

    with (
        patch.object(m, "GMAIL_SENDER", "s@test.com"),
        patch("hub.main._build_gmail_service", return_value=mock_service),
    ):
        result = asyncio.run(m._send_email("recipient@test.com", "Hello", "Body", "<b>Body</b>"))

    send_fn = mock_service.users.return_value.messages.return_value.send
    assert result.state == "sent"
    assert send_fn.called
    kwargs = send_fn.call_args[1]
    assert kwargs["userId"] == "me"
    assert "raw" in kwargs["body"]
    message = BytesParser(policy=policy.default).parsebytes(
        base64.urlsafe_b64decode(kwargs["body"]["raw"])
    )
    assert message.get_content_type() == "multipart/alternative"
    assert [part.get_content_type() for part in message.iter_parts()] == ["text/plain", "text/html"]
    assert m.EMAIL_BRAND in str(message["From"])
    assert message["Auto-Submitted"] == "auto-generated"


def test_send_email_rejects_invalid_recipient():
    result = asyncio.run(m._send_email("not-an-email", "subject", "body"))
    assert result.state == "failed"
    assert result.detail == "invalid-sender-or-recipient"


def test_build_session_email_contains_portal_and_html():
    content = m._build_session_email("warning", "session-1", "테스트 프로젝트", 1760000000)
    assert "7일" in content.subject
    assert m.PORTAL_URL in content.text
    assert "테스트 프로젝트" in content.text
    assert "<html lang='ko'>" in content.html
    assert "포털에서 기간 확인하기" in content.html
    assert m._email_display_brand() in content.html
    assert ">PC Rental<" not in content.html


def test_all_session_email_events_have_branded_html_and_plain_fallback():
    kinds = [
        "created",
        "resumed",
        "warning",
        "auto_suspend",
        "suspend",
        "admin_suspend",
        "unexpected_stop",
        "delete",
    ]
    for kind in kinds:
        content = m._build_session_email(
            kind,
            "session-1",
            "프로젝트 <script>",
            1760000000,
            reason="확인 필요",
            actor="member@school.kr",
        )
        assert content.subject.startswith("[PC대여]")
        assert m.PORTAL_URL in content.text
        assert "프로젝트 <script>" in content.text
        assert "프로젝트 &lt;script&gt;" in content.html
        assert "<script>" not in content.html
        assert "본 메일은" in content.html
        assert "처리한 사람" in content.html
        assert "member@school.kr" in content.html
        assert "KST" in content.text
        assert len(content.html.encode("utf-8")) < 100_000


def test_session_recipients_include_owner_and_deduplicated_team_members():
    recipients = m._session_email_recipients(
        {
            "owner": "OWNER@school.kr",
            "team_members": ["owner@school.kr", "member@school.kr", "invalid", ""],
        }
    )
    assert recipients == ["owner@school.kr", "member@school.kr"]


def test_send_session_email_sends_each_recipient_individually():
    mock_send = AsyncMock(return_value=m.EmailSendResult("sent", "message-id"))
    session = {
        "owner": "owner@school.kr",
        "team_members": ["member@school.kr"],
        "project_name": "협업 프로젝트",
    }
    with patch("hub.main._send_email", mock_send):
        result = asyncio.run(m._send_session_email("suspend", "abc", session))

    assert result.ok is True
    assert result.successful_recipients == ["owner@school.kr", "member@school.kr"]
    assert [call.args[0] for call in mock_send.await_args_list] == [
        "owner@school.kr",
        "member@school.kr",
    ]


def test_email_runtime_status_reports_missing_token_file():
    with patch.object(m, "GMAIL_SENDER", "sender@test.com"), patch.object(m, "GMAIL_TOKEN", "/tmp/does-not-exist.json"):
        status = m._email_runtime_status()
    assert status["can_send"] is False
    assert status["token_configured"] is True
    assert status["token_exists"] is False
    assert status["warnings"]
