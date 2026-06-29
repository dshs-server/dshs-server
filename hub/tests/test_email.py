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
