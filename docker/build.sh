#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/2] Building dshs-kasm-win10:latest ..."
docker build -t dshs-kasm-win10:latest .

echo "[2/2] Done."
echo "Test: docker run --rm -d --name test-win10 -p 8088:6901 -e VNC_PW=test1234 dshs-kasm-win10:latest"
echo "      http://localhost:8088  (kasm_user / test1234)"
echo "Stop: docker rm -f test-win10"
