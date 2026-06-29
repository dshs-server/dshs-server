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
