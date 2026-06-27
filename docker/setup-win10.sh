#!/bin/bash
# 패널 레이아웃만 적용 (테마/아이콘/배경은 gschema override가 처리)
DONE_FILE="$HOME/.win10-panel-applied"
if [ -f "$DONE_FILE" ]; then
    exit 0
fi

sleep 5

if [ -f /etc/kasm/mate-panel.conf ]; then
    dconf load /org/mate/panel/ < /etc/kasm/mate-panel.conf
    mate-panel --replace &>/dev/null &
fi

touch "$DONE_FILE"
