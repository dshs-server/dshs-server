#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT=8000
BACKEND_CF_LOG="/tmp/backend_cf.log"
BACKEND_CF_PID="/tmp/backend_cf.pid"

# Kill existing backend processes
pkill -f "uvicorn main:app" 2>/dev/null || true
if [ -f "$BACKEND_CF_PID" ]; then
    kill "$(cat "$BACKEND_CF_PID")" 2>/dev/null || true
    rm -f "$BACKEND_CF_PID"
fi

# Install Python dependencies if needed
pip3 install -q -r "$SCRIPT_DIR/requirements.txt"

# Export API key (change this before production!)
export API_KEY="${API_KEY:-dev-secret-change-me}"

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

# Start cloudflared tunnel for backend API
echo ""
echo "Starting cloudflared tunnel for backend API..."
rm -f "$BACKEND_CF_LOG"
nohup cloudflared tunnel --url "http://localhost:$BACKEND_PORT" > "$BACKEND_CF_LOG" 2>&1 &
CF_PID=$!
echo "$CF_PID" > "$BACKEND_CF_PID"

# Wait for tunnel URL to appear (up to 30 seconds)
BACKEND_URL=""
for i in $(seq 1 30); do
    sleep 1
    BACKEND_URL=$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$BACKEND_CF_LOG" 2>/dev/null | head -1)
    if [ -n "$BACKEND_URL" ]; then
        break
    fi
    echo "  waiting for tunnel URL... ($i/30)"
done

if [ -z "$BACKEND_URL" ]; then
    echo "ERROR: Could not get cloudflare tunnel URL. Check $BACKEND_CF_LOG"
    exit 1
fi

echo ""
echo "========================================================"
echo "  Backend is running!"
echo ""
echo "  API_KEY (현재값): $API_KEY"
echo ""
echo "  Vercel 환경변수에 아래 값을 설정하세요:"
echo ""
echo "  BACKEND_URL=$BACKEND_URL"
echo "  API_KEY=$API_KEY"
echo "========================================================"
echo ""
echo "  ※ 서버 재시작 시 BACKEND_URL이 변경됩니다."
echo "     변경 시 Vercel 환경변수를 업데이트하고 redeploy하세요."
echo ""
