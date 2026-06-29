"""SMTP email notifications for session lifecycle events."""

import asyncio
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage

logger = logging.getLogger(__name__)

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.sendgrid.net").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "apikey").strip()
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER).strip()
SMTP_USE_TLS = os.environ.get("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes")
SMTP_USE_SSL = os.environ.get("SMTP_USE_SSL", "false").lower() in ("1", "true", "yes")


def email_configured() -> bool:
    """Return whether enough SMTP settings exist to send mail."""
    return bool(SMTP_HOST and SMTP_FROM and (not SMTP_USER or SMTP_PASSWORD))


def _send_email_sync(recipients: list[str], subject: str, body: str) -> None:
    message = EmailMessage()
    message["From"] = SMTP_FROM
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.set_content(body)

    context = ssl.create_default_context()
    if SMTP_USE_SSL:
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            SMTP_HOST, SMTP_PORT, timeout=20, context=context
        )
    else:
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)

    with server:
        server.ehlo()
        if SMTP_USE_TLS and not SMTP_USE_SSL:
            server.starttls(context=context)
            server.ehlo()
        if SMTP_USER:
            server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(message)


async def send_email(recipients: list[str], subject: str, body: str) -> bool:
    """Send an email without blocking the FastAPI event loop."""
    recipients = sorted({email.strip().lower() for email in recipients if email.strip()})
    if not recipients or not email_configured():
        return False
    try:
        await asyncio.to_thread(_send_email_sync, recipients, subject, body)
        return True
    except Exception:
        logger.exception("Failed to send session notification email")
        return False
