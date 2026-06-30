#!/bin/bash
# Hub backend 시작 스크립트
# 실행: bash ~/hub/start.sh

set -e
export PATH=$PATH:$HOME/.local/bin
export API_KEY="${API_KEY:-pc-rental-secret-2024}"
export FIREBASE_CRED="${FIREBASE_CRED:-$HOME/hub/serviceAccountKey.json}"
# SSH_PASSWORD는 ~/.hub.env 에서 로드 (소스코드·git에 비밀번호 없음)
# 선택 보안 감시 설정도 같은 파일에서 변경 가능:
# SECURITY_SCAN_ENABLED=1
# SECURITY_SCAN_LOOKBACK=1200
# SECURITY_EXTENSIONS=exe,msi,bat,cmd,com,scr,pif,vbs,vbe,wsf,wsh,ps1,apk
if [ -f "$HOME/.hub.env" ]; then
  # env 파일의 일반 KEY=value 항목도 uvicorn 자식 프로세스에 전달한다.
  set -a
  source "$HOME/.hub.env"
  set +a
fi
if [ -z "$SSH_PASSWORD" ]; then
  echo "ERROR: SSH_PASSWORD not set. Add SSH_PASSWORD=... to ~/.hub.env"
  exit 1
fi

cd ~/hub
uvicorn main:app --host 0.0.0.0 --port 8001 --workers 1
