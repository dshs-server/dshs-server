#!/bin/bash
sleep 3

# ibus 데몬이 없으면 시작
if ! pgrep -x ibus-daemon > /dev/null; then
    ibus-daemon --xim --daemonize --replace 2>/dev/null
    sleep 2
fi

# Hangul 엔진 등록 + Shift+Space 토글
dconf write /desktop/ibus/general/preload-engines "['xkb:us::eng', 'hangul']"
dconf write /desktop/ibus/general/use-global-engine true
dconf write /desktop/ibus/general/hotkey/trigger "['<Shift>space', 'Hangul']"
