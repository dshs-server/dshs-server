#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT=8000

# Kill existing backend processes
pkill -f "uvicorn main:app" 2>/dev/null || true

# Install Python dependencies if needed
pip3 install --break-system-packages -q -r "$SCRIPT_DIR/requirements.txt"

# Export API key — Vercel의 API_KEY 환경변수와 반드시 동일해야 함
export API_KEY="${API_KEY:-pc-rental-secret-2024}"

echo "Starting FastAPI backend on port $BACKEND_PORT ..."
cd "$SCRIPT_DIR"
nohup python3 -m uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT" > /tmp/backend.log 2>&1 &
UVICORN_PID=$!
echo "FastAPI PID: $UVICORN_PID"

# Wait for FastAPI to be ready
for i in $(seq 1 15); do
    sleep 1
    if curl -sf "http://localhost:$BACKEND_PORT/health" > /dev/null 2>&1; then
        echo "FastAPI is up!"
        break
    fi
    echo "  waiting... ($i/15)"
done

echo ""
echo "========================================================"
echo "  Backend is running!"
echo ""
echo "  API_KEY (현재값): $API_KEY"
echo ""
echo "  Backend URL (고정): https://api.dshs-app.net"
echo "  Vercel BACKEND_URL을 위 값으로 설정하세요 (변경 불필요)"
echo "========================================================"
echo ""
