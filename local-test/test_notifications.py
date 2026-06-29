"""No-network tests for hub SMTP notification wiring."""

import asyncio
import importlib.util
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "hub" / "notifications.py"
SPEC = importlib.util.spec_from_file_location("hub_notifications_test", MODULE_PATH)
assert SPEC and SPEC.loader
notifications = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notifications)


class FakeSMTP:
    last = None

    def __init__(self, *args, **kwargs):
        self.started_tls = False
        self.login_args = None
        self.message = None
        FakeSMTP.last = self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def ehlo(self):
        return None

    def starttls(self, **_kwargs):
        self.started_tls = True

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, message):
        self.message = message


def run() -> None:
    notifications.SMTP_HOST = "smtp.example.com"
    notifications.SMTP_PORT = 587
    notifications.SMTP_USER = "ai_admin@ts.hs.kr"
    notifications.SMTP_PASSWORD = "not-a-real-password"
    notifications.SMTP_FROM = "ai_admin@ts.hs.kr"
    notifications.SMTP_USE_TLS = True
    notifications.SMTP_USE_SSL = False
    notifications.SMTP_PASSWORD = ""
    assert notifications.email_configured() is False
    notifications.SMTP_PASSWORD = "not-a-real-password"
    assert notifications.email_configured() is True

    with patch.object(notifications.smtplib, "SMTP", FakeSMTP):
        sent = asyncio.run(
            notifications.send_email(
                ["student@ts.hs.kr"], "세션 종료 경고", "테스트 본문"
            )
        )

    fake = FakeSMTP.last
    assert sent is True
    assert fake is not None and fake.started_tls is True
    assert fake.login_args == ("ai_admin@ts.hs.kr", "not-a-real-password")
    assert fake.message["From"] == "ai_admin@ts.hs.kr"
    assert fake.message["To"] == "student@ts.hs.kr"
    assert fake.message["Subject"] == "세션 종료 경고"
    print("[PASS] SMTP TLS/login/message wiring (network disabled)")


if __name__ == "__main__":
    run()
