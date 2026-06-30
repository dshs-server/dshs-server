import asyncio
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

if "hub.main" not in sys.modules:
    os.environ.setdefault("SSH_PASSWORD", "test-password")
    os.environ.setdefault("FIREBASE_CRED", "fake-cred.json")
    for module_name in (
        "firebase_admin",
        "firebase_admin.credentials",
        "firebase_admin.firestore_async",
        "asyncssh",
    ):
        sys.modules[module_name] = MagicMock()

import hub.main as m


def _scan_payload(*records: tuple[float, int, str]) -> str:
    raw = "".join(f"{mtime}\t{size}\t{path}\0" for mtime, size, path in records)
    return base64.b64encode(raw.encode()).decode()


class SecurityAlertTests(unittest.TestCase):
    def setUp(self):
        self.original_alerts = list(m._security_alerts)
        m._security_alerts.clear()

    def tearDown(self):
        m._security_alerts.clear()
        m._security_alerts.extend(self.original_alerts)

    def test_parse_security_scan_classifies_double_extension_as_critical(self):
        encoded = _scan_payload((1700000000.5, 1234, "/home/kasm-user/Downloads/report.pdf.exe"))

        files = m._parse_security_scan(encoded, "session-1")

        self.assertEqual(len(files), 1)
        self.assertTrue(files[0]["path"].endswith("report.pdf.exe"))
        self.assertEqual(files[0]["severity"], "critical")
        self.assertIn("이중 확장자", files[0]["reason"])
        self.assertEqual(len(files[0]["fingerprint"]), 64)

    def test_parse_security_scan_ignores_invalid_base64(self):
        self.assertEqual(m._parse_security_scan("not base64!", "session-1"), [])

    def test_scan_creates_one_alert_and_deduplicates_same_file(self):
        encoded = _scan_payload((1700000000.5, 2048, "/home/kasm-user/Desktop/tool.exe"))
        jpeg = base64.b64encode(b"\xff\xd8\xff" + b"jpeg-data").decode()
        ssh = AsyncMock(side_effect=[(encoded, 0), (jpeg, 0), (encoded, 0)])
        session = {
            "id": "abc123",
            "owner": "student@school.kr",
            "project_name": "테스트 프로젝트",
            "node_id": "server-01",
        }
        node = {"id": "server-01", "name": "1호기", "ip": "10.0.0.1", "ssh_user": "tester"}

        with tempfile.TemporaryDirectory() as tmpdir:
            alert_dir = Path(tmpdir) / "alerts"
            with (
                patch("hub.main._ssh", ssh),
                patch.object(m, "SECURITY_ALERT_DIR", str(alert_dir)),
                patch.object(m, "SECURITY_ALERTS_FILE", str(alert_dir / "alerts.json")),
            ):
                first = asyncio.run(m._scan_session_security(session, node))
                second = asyncio.run(m._scan_session_security(session, node))

            self.assertIsNotNone(first)
            assert first is not None
            self.assertTrue(first["files"][0]["path"].endswith("tool.exe"))
            self.assertTrue(first["screenshot"])
            self.assertIsNone(second)
            self.assertEqual(len(m._security_alerts), 1)
            self.assertTrue((alert_dir / first["screenshot"]).read_bytes().startswith(b"\xff\xd8\xff"))
            self.assertEqual(ssh.await_count, 3)

    def test_admin_can_list_and_acknowledge_security_alert(self):
        m._security_alerts.append(
            {
                "id": "alert-1",
                "created_at": 1700000000.0,
                "session_id": "abc",
                "files": [],
                "fingerprints": ["secret-internal-value"],
                "screenshot": "alert-1.jpg",
                "acknowledged": False,
            }
        )
        client = TestClient(m.app)

        listed = client.get("/admin/security-alerts", headers={"x-api-key": m.API_KEY})
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()["unacknowledged"], 1)
        self.assertTrue(listed.json()["alerts"][0]["has_screenshot"])
        self.assertNotIn("fingerprints", listed.json()["alerts"][0])
        self.assertNotIn("screenshot", listed.json()["alerts"][0])

        with patch("hub.main._persist_security_alerts"):
            updated = client.patch(
                "/admin/security-alerts/alert-1",
                headers={"x-api-key": m.API_KEY},
                json={"acknowledged": True},
            )
        self.assertEqual(updated.status_code, 200)
        self.assertTrue(updated.json()["acknowledged"])
        self.assertTrue(m._security_alerts[0]["acknowledged"])

    def test_security_scan_command_quotes_container_name(self):
        command = m._security_scan_command("kasm_session-1")
        self.assertTrue(command.startswith("docker exec "))
        self.assertIn("/home/kasm-user/Downloads", command)
        self.assertIn("-mmin", command)
        self.assertIn("base64 -w0", command)


if __name__ == "__main__":
    unittest.main()
