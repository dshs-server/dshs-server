#!/usr/bin/env bash
# 새 노드 1대 배포 스크립트
# 사용법: ./deploy-node.sh <server-XX> <NODE_IP> <SSH_USER> <SSH_PASSWORD>
# 예시:   ./deploy-node.sh server-02 10.72.117.24 ai-admin 'mypassword'
#
# 사전 조건:
#   - /tmp/kasm-XX-<tunnel-id>.json 파일이 존재해야 함 (터널 생성 시 생성됨)
#   - 노드에 Docker, nginx, cloudflared 설치 완료
#   - tunnel-mapping.json 파일 존재

set -euo pipefail

NODE_ID="${1:?사용법: $0 <server-XX> <NODE_IP> <SSH_USER> <SSH_PASSWORD>}"
NODE_IP="${2:?NODE_IP 필요}"
SSH_USER="${3:-ai-admin}"
SSH_PASS="${4:?SSH_PASSWORD 필요}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NUM="${NODE_ID##server-}"  # "02" 추출

# tunnel-mapping.json에서 터널 ID 읽기
TUNNEL_ID=$(python3 -c "
import json
with open('$SCRIPT_DIR/tunnel-mapping.json') as f:
    d = json.load(f)
print(d['$NODE_ID']['tunnel_id'])
")
KASM_URL=$(python3 -c "
import json
with open('$SCRIPT_DIR/tunnel-mapping.json') as f:
    d = json.load(f)
print(d['$NODE_ID']['kasm_url'])
")
DOMAIN="${KASM_URL#https://}"

CRED_FILE="/tmp/kasm-${NUM}-${TUNNEL_ID}.json"
if [ ! -f "$CRED_FILE" ]; then
  echo "ERROR: credentials 파일 없음: $CRED_FILE"
  echo "/tmp에 저장된 파일 목록:"
  ls /tmp/kasm-*.json 2>/dev/null || echo "(없음)"
  exit 1
fi

echo "=== 배포 시작: $NODE_ID ($NODE_IP) ==="
echo "  터널: $TUNNEL_ID"
echo "  도메인: $DOMAIN"

SSH="sshpass -p $SSH_PASS ssh -o StrictHostKeyChecking=no $SSH_USER@$NODE_IP"
SCP="sshpass -p $SSH_PASS scp -o StrictHostKeyChecking=no"

# 1. credentials JSON 전송
echo "[1/3] credentials 전송..."
$SSH "mkdir -p ~/.cloudflared"
$SCP "$CRED_FILE" "$SSH_USER@$NODE_IP:~/.cloudflared/${TUNNEL_ID}.json"

# 2. config.yml 생성
echo "[2/3] config.yml 작성..."
$SSH "cat > ~/.cloudflared/config.yml << 'CFEOF'
tunnel: ${TUNNEL_ID}
credentials-file: /home/${SSH_USER}/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:80
  - service: http_status:404
CFEOF"

# 3. systemd 서비스 등록 + 시작
echo "[3/3] systemd 서비스 설정..."
$SSH "sudo tee /etc/systemd/system/kasm-tunnel.service << 'SVCEOF'
[Unit]
Description=Cloudflare Named Tunnel (kasm)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SSH_USER}
ExecStart=/usr/bin/cloudflared tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
sudo systemctl daemon-reload
sudo systemctl enable --now kasm-tunnel
sleep 3
sudo systemctl status kasm-tunnel --no-pager"

echo ""
echo "=== $NODE_ID 배포 완료 ==="
echo "  VNC URL: $KASM_URL"
echo ""
echo "허브 등록 명령 (내부망 IP 확인 후 실행):"
INTERNAL_IP=$($SSH "ip -4 addr show | grep '10\.72\.' | awk '{print \$2}' | cut -d/ -f1 | head -1" 2>/dev/null || echo "<INTERNAL_IP>")
echo ""
echo "curl -s -X POST 'https://hub.dshs-app.net/admin/nodes?node_id=$NODE_ID' \\"
echo "  -H 'x-api-key: pc-rental-secret-2024' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{"
echo "    \"name\": \"${NUM}호기\","
echo "    \"ip\": \"$INTERNAL_IP\","
echo "    \"ssh_user\": \"$SSH_USER\","
echo "    \"kasm_url\": \"$KASM_URL\","
echo "    \"cpu\": \"Intel Core i7\","
echo "    \"cpu_cores\": 8,"
echo "    \"gpu\": \"NVIDIA GTX 1660\","
echo "    \"gpu_type\": \"nvidia\","
echo "    \"ram_gb\": 32,"
echo "    \"storage_gb\": 500"
echo "  }'"
