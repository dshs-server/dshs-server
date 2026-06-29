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
    mock_query = MagicMock()
    mock_query.get = AsyncMock(return_value=docs)
    # _check_and_send_warnings: db.collection().where().get()  — single where
    m.db.collection.return_value.where.return_value = mock_query
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
