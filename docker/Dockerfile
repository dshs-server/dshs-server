FROM kasmweb/ubuntu-jammy-desktop:1.16.0

USER root

# 불필요한 앱 제거
RUN apt-get remove --purge -y \
    gimp gimp-data libgimp2.0 \
    nextcloud-desktop nextcloud-desktop-common nextcloud-desktop-doc nextcloud-desktop-l10n libnextcloudsync0 \
    obs-studio obs-v4l2sink \
    onlyoffice-desktopeditors \
    remmina remmina-common remmina-plugin-rdp remmina-plugin-secret remmina-plugin-spice remmina-plugin-vnc \
    signal-desktop \
    slack-desktop \
    sublime-text \
    thunderbird \
    zoom \
    2>/dev/null || true && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git \
    fonts-liberation2 \
    fonts-noto-cjk \
    imagemagick \
    xfce4-whiskermenu-plugin \
    ibus \
    ibus-hangul \
    language-pack-ko \
    && rm -rf /var/lib/apt/lists/*

# 한국어 locale 생성 + 기본 언어 설정
RUN locale-gen ko_KR.UTF-8
ENV LANG=ko_KR.UTF-8
ENV LANGUAGE=ko_KR.UTF-8
ENV LC_ALL=ko_KR.UTF-8

RUN git clone --depth=1 https://github.com/B00merang-Project/Windows-10.git \
        /usr/share/themes/Windows-10 \
    && rm -rf /usr/share/themes/Windows-10/.git

RUN git clone --depth=1 https://github.com/B00merang-Project/Windows-10-Icons.git \
        /usr/share/icons/Windows-10 \
    && rm -rf /usr/share/icons/Windows-10/.git

RUN convert -size 1920x1080 \
        gradient:#0078d4-#003f7f \
        /usr/share/backgrounds/windows10.jpg

# XFCE config: kasm-default-profile XML 직접 수정
ENV XFCE_DIR=/home/kasm-default-profile/.config/xfce4/xfconf/xfce-perchannel-xml

# GTK 테마 + 아이콘 + 폰트
RUN sed -i \
    's/ThemeName" type="empty"/ThemeName" type="string" value="Windows-10"/' \
    $XFCE_DIR/xsettings.xml && \
    sed -i \
    's/IconThemeName" type="string" value="ubuntu-mono-dark"/IconThemeName" type="string" value="Windows-10"/' \
    $XFCE_DIR/xsettings.xml && \
    sed -i \
    's/FontName" type="empty"/FontName" type="string" value="Liberation Sans 10"/' \
    $XFCE_DIR/xsettings.xml

# 창 장식 테마 + 폰트
RUN sed -i \
    's/theme" type="string" value="Default"/theme" type="string" value="Windows-10"/' \
    $XFCE_DIR/xfwm4.xml && \
    sed -i \
    's/title_font" type="string" value="Sans Bold 9"/title_font" type="string" value="Liberation Sans Bold 10"/' \
    $XFCE_DIR/xfwm4.xml

# 배경화면 (모든 monitor/workspace)
RUN sed -i 's|bg_default.png|windows10.jpg|g' $XFCE_DIR/xfce4-desktop.xml

# 패널 하단으로 이동 (p=6=top → p=8=bottom)
RUN sed -i 's/p=6;x=0;y=0/p=8;x=0;y=0/' $XFCE_DIR/xfce4-panel.xml

# Whisker Menu로 교체
RUN sed -i 's/value="applicationsmenu"/value="whiskermenu"/' $XFCE_DIR/xfce4-panel.xml

# GTK3 IM 모듈 설정 (환경변수 없이도 ibus 사용)
RUN mkdir -p /home/kasm-default-profile/.config/gtk-3.0 && \
    printf '[Settings]\ngtk-im-module=ibus\n' \
    > /home/kasm-default-profile/.config/gtk-3.0/settings.ini

# GTK2 IM 모듈 설정
RUN printf 'gtk-im-module="ibus"\n' \
    > /home/kasm-default-profile/.gtkrc-2.0

# ibus 자동시작 + Hangul 엔진 설정
COPY setup-ibus.sh /usr/local/bin/setup-ibus.sh
RUN chmod +x /usr/local/bin/setup-ibus.sh
RUN printf '[Desktop Entry]\nType=Application\nName=IBus Korean Setup\nExec=/usr/local/bin/setup-ibus.sh\nX-GNOME-Autostart-enabled=true\n' \
    > /etc/xdg/autostart/ibus-setup.desktop

# 데스크탑 아이콘: Chrome/Firefox/VSCode만 유지
RUN cd /home/kasm-default-profile/Desktop && \
    find . -maxdepth 1 -name "*.desktop" \
        ! -name "google-chrome.desktop" \
        ! -name "firefox.desktop" \
        ! -name "code.desktop" \
        -delete

RUN echo 'kasm-user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kasm-user && \
    chmod 440 /etc/sudoers.d/kasm-user

# Desktop 디렉토리를 kasm-user 소유로 미리 생성.
# bind-mount(-v .../Desktop/받은파일) 시 Docker가 부모인 Desktop을 root:root로 자동 생성하면
# 컨테이너 startup 스크립트가 Desktop/Uploads 심볼릭 링크 생성에 실패(Permission denied)하고
# ExitCode=1 재시작 루프에 빠진다. 이미지에 Desktop이 1000:1000으로 존재하면 Docker가 새로
# 만들지 않으므로 권한이 유지된다.
RUN mkdir -p /home/kasm-user/Desktop && \
    chown 1000:1000 /home/kasm-user/Desktop

# ttyd 설치 (브라우저 터미널, port 7681)
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
        -o /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

# supervisord로 ttyd 자동 시작
RUN printf '[program:ttyd]\ncommand=/usr/local/bin/ttyd -W -p 7681 bash\nautostart=true\nautorestart=true\nuser=kasm-user\nstdout_logfile=/var/log/ttyd.log\nstderr_logfile=/var/log/ttyd.log\n' \
    > /etc/supervisor/conf.d/ttyd.conf

USER 1000
