# Windows 10 KasmVNC Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KasmVNC 컨테이너(Ubuntu MATE)를 Windows 10처럼 보이게 꾸민 커스텀 Docker 이미지 빌드 및 배포

**Architecture:** `kasmweb/ubuntu-jammy-desktop:1.16.0` 위에 b00merang Windows-10 GTK 테마, 아이콘 팩, 파란 그라디언트 배경, Windows 10 스타일 하단 패널을 설치한 커스텀 이미지를 서버에서 빌드한다. 컨테이너 첫 로그인 시 autostart 스크립트가 `gsettings`/`dconf`로 테마를 적용한다. `backend/main.py`의 이미지 이름만 변경하면 기존 세션 로직은 그대로 동작한다.

**Tech Stack:** Docker, Ubuntu MATE, b00merang-project themes, dconf/gsettings, ImageMagick, FastAPI (backend 수정만)

## Global Constraints

- 베이스 이미지: `kasmweb/ubuntu-jammy-desktop:1.16.0` (변경 금지)
- 새 이미지 이름: `dshs-kasm-win10:latest` (로컬 빌드, Docker Hub 불필요)
- 서버: `admin-swai@100.87.162.103` (비번: `asdwsx12!`)
- kasm_user UID: 1000
- 기존 `backend/main.py` 로직(세션 생성/종료/복원)은 이미지 이름 외 수정 없음

---

### Task 1: docker/ 디렉토리 + Dockerfile

**Files:**
- Create: `docker/Dockerfile`

- [ ] **Step 1: docker 디렉토리 생성**

```bash
mkdir -p docker
```

- [ ] **Step 2: Dockerfile 작성**

`docker/Dockerfile`:

```dockerfile
FROM kasmweb/ubuntu-jammy-desktop:1.16.0

USER root

# 패키지 설치: git, fonts-liberation2, imagemagick (배경 생성용)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git \
    fonts-liberation2 \
    imagemagick \
    && rm -rf /var/lib/apt/lists/*

# Windows 10 GTK 테마 설치
RUN git clone --depth=1 https://github.com/B00merang-Project/Windows-10.git \
        /usr/share/themes/Windows-10 \
    && rm -rf /usr/share/themes/Windows-10/.git

# Windows 10 아이콘 팩 설치
RUN git clone --depth=1 https://github.com/B00merang-Project/Windows-10-Icons.git \
        /usr/share/icons/Windows-10 \
    && rm -rf /usr/share/icons/Windows-10/.git

# Windows 10 스타일 파란 그라디언트 배경 생성
RUN convert -size 1920x1080 \
        gradient:#0078d4-#003f7f \
        /usr/share/backgrounds/windows10.jpg

# 테마 설정 스크립트 등록
COPY setup-win10.sh /usr/local/bin/setup-win10.sh
RUN chmod +x /usr/local/bin/setup-win10.sh

# 패널 설정 파일 (dconf dump 형식)
COPY mate-panel.conf /etc/kasm/mate-panel.conf

# MATE 세션 시작 시 자동 실행 등록
RUN mkdir -p /etc/xdg/autostart && \
    printf '[Desktop Entry]\nType=Application\nName=Windows 10 Theme Setup\nExec=/usr/local/bin/setup-win10.sh\nX-GNOME-Autostart-enabled=true\n' \
    > /etc/xdg/autostart/win10-setup.desktop

USER 1000
```

- [ ] **Step 3: 파일 존재 확인**

```bash
ls docker/Dockerfile
```

Expected: `docker/Dockerfile`

---

### Task 2: setup-win10.sh + mate-panel.conf

**Files:**
- Create: `docker/setup-win10.sh`
- Create: `docker/mate-panel.conf`

- [ ] **Step 1: setup-win10.sh 작성**

`docker/setup-win10.sh`:

```bash
#!/bin/bash
# 최초 1회만 실행
DONE_FILE="$HOME/.win10-theme-applied"
if [ -f "$DONE_FILE" ]; then
    exit 0
fi

# dbus 세션 대기 (MATE 세션 준비 전 실행 방지)
sleep 3

# GTK / 아이콘 / 커서 테마
gsettings set org.mate.interface gtk-theme 'Windows-10'
gsettings set org.mate.interface icon-theme 'Windows-10'

# 폰트 (Liberation = Segoe UI 대체)
gsettings set org.mate.interface font-name 'Liberation Sans 10'
gsettings set org.mate.interface document-font-name 'Liberation Sans 11'
gsettings set org.mate.interface monospace-font-name 'Liberation Mono 10'

# 창 장식 테마
gsettings set org.mate.Marco.general theme 'Windows-10'
gsettings set org.mate.Marco.general titlebar-font 'Liberation Sans Bold 10'

# 배경화면
gsettings set org.mate.background picture-filename '/usr/share/backgrounds/windows10.jpg'
gsettings set org.mate.background picture-options 'zoom'
gsettings set org.mate.background color-shading-type 'solid'

# 패널 레이아웃 적용 (Windows 10 하단 taskbar)
if [ -f /etc/kasm/mate-panel.conf ]; then
    dconf load /org/mate/panel/ < /etc/kasm/mate-panel.conf
    mate-panel --replace &
fi

touch "$DONE_FILE"
```

- [ ] **Step 2: mate-panel.conf 작성 (Windows 10 하단 taskbar 레이아웃)**

`docker/mate-panel.conf`:

```ini
[/]
object-id-list=['object-0', 'object-1', 'object-2', 'object-3']
toplevel-id-list=['bottom']

[toplevels/bottom]
auto-hide=false
enable-buttons=false
enable-arrows=true
expand=true
orientation='bottom'
screen=0
size=40
background-type='color'
background-color='rgba(0,0,0,0.85)'

[objects/object-0]
object-type='applet'
applet-iid='PanelInternalFactory::MenuBar'
toplevel-id='bottom'
panel-right-stick=false
position=0
locked-down=false

[objects/object-1]
object-type='applet'
applet-iid='WnckletFactory::WindowListApplet'
toplevel-id='bottom'
panel-right-stick=false
position=60
locked-down=false

[objects/object-2]
object-type='applet'
applet-iid='NotificationAreaAppletFactory::NotificationArea'
toplevel-id='bottom'
panel-right-stick=true
position=1
locked-down=false

[objects/object-3]
object-type='applet'
applet-iid='ClockAppletFactory::ClockApplet'
toplevel-id='bottom'
panel-right-stick=true
position=0
locked-down=false
```

- [ ] **Step 3: 파일 권한 확인**

```bash
ls -la docker/setup-win10.sh docker/mate-panel.conf
```

Expected: 두 파일 모두 존재

---

### Task 3: build.sh 작성

**Files:**
- Create: `docker/build.sh`

- [ ] **Step 1: build.sh 작성**

`docker/build.sh`:

```bash
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/2] Building dshs-kasm-win10:latest ..."
docker build -t dshs-kasm-win10:latest .

echo "[2/2] Done. Test run:"
echo "  docker run --rm -d --name test-win10 -p 8088:6901 -e VNC_PW=test1234 dshs-kasm-win10:latest"
echo "  브라우저에서 http://localhost:8088 접속 → kasm_user / test1234"
echo "  확인 후: docker rm -f test-win10"
```

- [ ] **Step 2: 실행 권한 부여 (로컬에서만)**

```bash
chmod +x docker/build.sh
```

---

### Task 4: backend/main.py — 이미지 이름 변경

**Files:**
- Modify: `backend/main.py` (line 20, line 221)

- [ ] **Step 1: KASM_IMAGE 상수 변경 (line 20)**

현재:
```python
KASM_IMAGE = "kasmweb/ubuntu-jammy-desktop"
```

변경:
```python
KASM_IMAGE = "dshs-kasm-win10"
```

- [ ] **Step 2: docker run 하드코딩 이미지 변경 (line 221)**

현재:
```python
            "kasmweb/ubuntu-jammy-desktop:1.16.0",
```

변경:
```python
            f"{KASM_IMAGE}:latest",
```

- [ ] **Step 3: `_cleanup_stopped_containers`의 ancestor 필터 확인**

`main.py` 28, 36번째 줄:
```python
"--filter", f"ancestor={KASM_IMAGE}:1.16.0",
```

이 두 곳도 변경:
```python
"--filter", f"ancestor={KASM_IMAGE}:latest",
```

- [ ] **Step 4: 변경 확인**

```bash
grep -n "KASM_IMAGE\|kasm-win10\|1\.16\.0\|ubuntu-jammy" backend/main.py
```

Expected: `ubuntu-jammy` 없음, `dshs-kasm-win10` + `latest` 만 존재

---

### Task 5: 서버 배포 및 빌드

**Files:** 없음 (배포 작업)

- [ ] **Step 1: 서버에 docker/ 디렉토리 전송**

로컬 Mac에서:
```bash
scp -r docker/ admin-swai@100.87.162.103:~/docker/
```

비밀번호: `asdwsx12!`

- [ ] **Step 2: 서버에서 이미지 빌드**

```bash
ssh admin-swai@100.87.162.103
# 비밀번호: asdwsx12!

cd ~/docker
bash build.sh
```

빌드 시간: 약 5~10분 (b00merang git clone + 패키지 설치)
Expected: `Successfully built ...` + `Successfully tagged dshs-kasm-win10:latest`

- [ ] **Step 3: 테스트 컨테이너 실행 및 시각 확인**

서버에서:
```bash
docker run --rm -d --name test-win10 -p 8088:6901 -e VNC_PW=test1234 dshs-kasm-win10:latest
```

로컬 Mac에서 Tailscale으로:
```
http://100.87.162.103:8088
```
로그인: `kasm_user` / `test1234`

**확인 항목:**
- [ ] 배경화면이 파란 그라디언트
- [ ] 하단 패널만 존재 (taskbar 스타일)
- [ ] GTK 테마가 Windows 10 스타일 (창 테두리, 버튼)
- [ ] 아이콘이 Windows 10 스타일
- [ ] 폰트가 Liberation Sans

- [ ] **Step 4: 테스트 컨테이너 제거**

```bash
docker rm -f test-win10
```

- [ ] **Step 5: backend 파일 서버 배포**

로컬 Mac에서:
```bash
scp backend/main.py admin-swai@100.87.162.103:~/backend/main.py
```

- [ ] **Step 6: 백엔드 재시작**

```bash
ssh admin-swai@100.87.162.103
sudo systemctl restart backend
```

또는:
```bash
bash ~/start_backend.sh
```

- [ ] **Step 7: 포털에서 실제 세션 생성 테스트**

`https://` 포털 접속 → PC 대여하기 → 세션 준비 후 데스크톱 열기 → Windows 10 테마 확인

---

## 알려진 제한사항

- `mate-panel --replace` 호출 시 패널이 재시작되면서 잠깐 깜빡일 수 있음 (1회 한정)
- `dconf load`로 패널 레이아웃이 적용 안 되는 경우: MATE 패널 우클릭 → "Properties"로 수동 조정
- 배경화면은 Windows 10 블루 그라디언트 (저작권 없는 자체 생성); 실제 MS 배경화면 원하면 Step 2에서 URL로 대체 가능
- `--gpus all` 옵션은 새 이미지에서도 그대로 동작 (이미지 변경과 무관)
