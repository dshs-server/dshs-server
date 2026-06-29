#!/bin/bash
# Hub backend 시작 스크립트
# 실행: bash ~/hub/start.sh

set -e
export PATH=$PATH:$HOME/.local/bin
export API_KEY="${API_KEY:-pc-rental-secret-2024}"
export FIREBASE_CRED="${FIREBASE_CRED:-$HOME/hub/serviceAccountKey.json}"
# SSH_PASSWORD는 ~/.hub.env 에서 로드 (소스코드·git에 비밀번호 없음)
if [ -f "$HOME/.hub.env" ]; then
  set -a
  source "$HOME/.hub.env"
  set +a
fi
if [ -z "$SSH_PASSWORD" ]; then
  echo "ERROR: SSH_PASSWORD not set. Add SSH_PASSWORD=... to ~/.hub.env"
  exit 1
fi
if [ -z "$SMTP_PASSWORD" ] && [ "$SMTP_HOST" != "smtp-relay.gmail.com" ]; then
  echo "WARNING: SMTP_PASSWORD is not set; session lifecycle emails will be disabled."
fi

cd ~/hub
uvicorn main:app --host 0.0.0.0 --port 8001 --workers 1
