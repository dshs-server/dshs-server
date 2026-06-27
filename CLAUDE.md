# CLAUDE.md — PC 대여 포털 (dshs-server)

## 프로젝트 개요

학교 전산실 워크스테이션을 학생에게 브라우저로 대여해주는 시스템.
Docker + KasmVNC로 Ubuntu MATE 데스크톱을 스트리밍하고, Cloudflare Quick Tunnel로 외부에서 접속 가능하게 한다.

**GitHub**: https://github.com/dshs-server/dshs-server

---

## 디렉토리 구조

```
/
├── frontend/          # Next.js 14 프론트엔드 (Vercel 배포)
│   ├── app/
│   │   ├── api/
│   │   │   ├── login/route.ts       # 로그인 API
│   │   │   ├── logout/route.ts      # 로그아웃 API
│   │   │   └── session/
│   │   │       ├── route.ts         # GET(활성 세션 조회) / POST(세션 생성)
│   │   │       └── [id]/route.ts    # GET(상태 폴링) / DELETE(세션 종료)
│   │   ├── dashboard/page.tsx       # 대여 대시보드 (메인 UI)
│   │   ├── login/page.tsx           # 로그인 페이지
│   │   └── layout.tsx
│   ├── lib/auth.ts                  # 쿠키 기반 인증 유틸
│   └── middleware.ts                # 미인증 접근 차단
├── backend/           # FastAPI 백엔드 (서버컴 직접 실행)
│   ├── main.py        # API 서버 (세션 생성/조회/종료)
│   ├── requirements.txt
│   └── start.sh       # 백엔드 + cloudflared 자동 시작 스크립트
├── DEPLOY.md          # 배포 가이드 (환경변수, 재시작 방법)
├── vercel.json        # Vercel 설정 (Root Directory는 대시보드에서 frontend로 설정)
└── computing_rental_system_unified.md  # 시스템 전체 설계 문서
```

---

## 아키텍처

```
학생 브라우저
  → Vercel (Next.js 프론트)
    → Next.js API 라우트 (백엔드 프록시 역할)
      → Cloudflare Named Tunnel (api.dshs-app.net, 고정)
        → FastAPI 백엔드 (서버컴 port 8000)
          → docker run (Kasm 컨테이너 port 8080 → 6901)

학생 브라우저
  → Cloudflare Named Tunnel (kasm.dshs-app.net, 고정)
    → nginx port 80 (Authorization 자동 주입)
      → Kasm KasmVNC 스트리밍 (port 8080)
```

Named Tunnel 정보:
- Tunnel ID: `a3e0c5e1-b71c-48f4-991a-5f3ec4810229`
- 도메인: `dshs-app.net` (Cloudflare 관리, 원주인 API 토큰 사용)
- Cloudflare Zone ID: `d3b89064edaac87902c2458740a78a55`
- Cloudflare Account ID: `89d76756960a4356d238c59ba78003c7`
- 서버 credentials: `~/.cloudflared/<tunnel-id>.json`
- 서버 config: `~/.cloudflared/config.yml`
- systemd 서비스: `kasm-tunnel.service` (부팅 시 자동 시작)

---

## 개발 환경 실행

### 프론트엔드 (로컬)
```bash
cd frontend
npm run dev
# http://localhost:3000
# 아이디: admin / 비밀번호: admin1234 (개발 환경)
```

### 백엔드 (서버컴 — Tailscale SSH)
```bash
ssh admin-swai@100.87.162.103  # 비밀번호: asdwsx12!
bash ~/start_backend.sh
# URL 고정 (https://api.dshs-app.net) — Vercel 업데이트 불필요
```

---

## 환경변수

### Vercel (프론트엔드)
| 변수명 | 값 / 설명 |
|--------|------|
| `BACKEND_URL` | `https://api.dshs-app.net` (**고정** — 변경 불필요) |
| `API_KEY` | 백엔드 인증 키 (기본: `pc-rental-secret-2024`) |
| `ADMIN_USERNAME` | 포털 로그인 아이디 |
| `ADMIN_PASSWORD` | 포털 로그인 비밀번호 |
| `AUTH_SECRET` | 세션 쿠키 서명 키 |

### 백엔드 (서버컴 환경변수)
| 변수명 | 설명 |
|--------|------|
| `API_KEY` | Vercel의 `API_KEY`와 동일하게 설정 |

---

## 주요 API

### 백엔드 (FastAPI)
| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/health` | 헬스체크 |
| GET | `/session` | 현재 활성·일시중지 세션 조회 (`none` / `suspended` / `starting` / `ready`) |
| POST | `/session` | 새 세션 생성 (컨테이너 + cloudflared 시작) |
| POST | `/session?resume=true` | 일시 중지된 컨테이너 재시작 (데이터 보존) |
| GET | `/session/{id}` | 세션 상태 폴링 (url 발급 여부, 재시작 중 여부) |
| DELETE | `/session/{id}` | 세션 일시 중지 (`docker stop` — 컨테이너 보존, 데이터 유지) |
| POST | `/admin/cleanup` | 중단된 Kasm 컨테이너 즉시 정리 |

모든 요청에 `x-api-key` 헤더 필요.

---

## Vercel 배포 설정

- **Root Directory**: Vercel 대시보드 → Settings → General → `frontend`로 설정 (필수)
- `vercel.json`은 빈 파일 유지 (`{}`)
- 서버 재시작 시 `BACKEND_URL`이 변경되므로 Vercel 환경변수 업데이트 + Redeploy 필요

---

## 노드 서버 정보

### 현재 운영 서버 (2호기 — 2026-06-27 교체)

| 항목 | 값 |
|------|-----|
| Tailscale IP | `100.87.162.103` |
| SSH 유저 | `admin-swai` |
| SSH 비밀번호 | `asdwsx12!` |
| GPU | NVIDIA GeForce GTX 1660 |
| OS | Ubuntu 24.04.4 LTS (Noble Numbat) |
| 컨테이너 이미지 | `kasmweb/ubuntu-jammy-desktop:1.16.0` |

### 구 서버 (1호기 — 폐기)

| 항목 | 값 |
|------|-----|
| Tailscale IP | `100.115.25.22` |
| SSH 유저 | `student3` / 비밀번호: `BOS123!@#` |
| GPU | NVIDIA RTX 3080 |

---

## 새 서버 초기 설정 가이드 (Ubuntu 24.04 기준)

새 서버에 백엔드를 처음 설치할 때 순서대로 실행한다.

### 1. SSH 서버 설치 (물리 접속 필요)

```bash
sudo apt update && sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

### 2. 원격에서 나머지 전체 설치

```bash
# Docker 설치
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
sudo systemctl enable --now docker

# cloudflared 설치
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# Python 패키지 설치 (Ubuntu 24.04는 --break-system-packages 필요)
pip3 install --break-system-packages fastapi==0.111.0 uvicorn==0.30.1
echo 'export PATH=$PATH:$HOME/.local/bin' >> ~/.bashrc

# nginx 설치 (apache2가 있으면 먼저 중지)
sudo systemctl stop apache2 && sudo systemctl disable apache2  # 있을 경우만
sudo apt-get install -y nginx

# nginx Kasm 프록시 설정 (kasm_user:test1234 → Base64: a2FzbV91c2VyOnRlc3QxMjM0)
sudo tee /etc/nginx/sites-available/kasm << 'EOF'
server {
    listen 80;
    location / {
        proxy_pass https://localhost:8080;
        proxy_set_header Authorization "Basic a2FzbV91c2VyOnRlc3QxMjM0";
        proxy_set_header Host $host;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/kasm /etc/nginx/sites-enabled/kasm
sudo rm -f /etc/nginx/sites-enabled/default
sudo systemctl enable --now nginx
```

### 3. NVIDIA GPU가 있는 경우 — nvidia-container-toolkit 설치

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### 4. GDM Wayland 비활성화 (NVIDIA GPU 서버 필수)

NVIDIA GPU + GDM(GNOME) 환경에서 X11 세션과 GDM Wayland greeter가 DRM master를 두고 충돌하면
물리 화면·키보드·마우스가 먹통이 된다. 신규 서버 세팅 시 반드시 적용.

```bash
sudo sed -i 's/#WaylandEnable=false/WaylandEnable=false/' /etc/gdm3/custom.conf
sudo systemctl restart gdm3
```

확인:
```bash
# dmesg에 아래 에러가 없으면 정상
# "Failed to grab modeset ownership"
# "Failed to apply atomic modeset. Error code: -22"
grep WaylandEnable /etc/gdm3/custom.conf   # WaylandEnable=false 출력돼야 함
```

### 5. 백엔드 파일 배포

```bash
# 로컬 Mac에서 실행
scp backend/main.py backend/requirements.txt backend/start.sh USER@SERVER_IP:~/backend/
```

### 6. systemd 서비스 등록 (자동 시작)

```bash
sudo tee /etc/systemd/system/backend.service << 'EOF'
[Unit]
Description=PC Rental Backend
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=none
User=USER
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/USER/.local/bin
Environment=API_KEY=pc-rental-secret-2024
WorkingDirectory=/home/USER/backend
ExecStart=/bin/bash /home/USER/backend/start.sh
ExecStop=/bin/bash -c "pkill -f 'uvicorn main:app' 2>/dev/null || true"

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now backend
```

`USER`를 실제 유저명으로 교체. 서비스 시작 후 약 40초 기다리면 BACKEND_URL이 로그에 출력됨:

```bash
grep -o "https://.*\.trycloudflare\.com" /tmp/backend_cf.log
```

### 7. start_backend.sh 홈에 등록 (수동 재시작용)

```bash
cat > ~/start_backend.sh << 'EOF'
#!/bin/bash
export PATH=$PATH:$HOME/.local/bin
exec bash ~/backend/start.sh "$@"
EOF
chmod +x ~/start_backend.sh
```

---

## 세션 동작 방식

로그인 후 대시보드 진입 시 활성·일시중지 세션을 자동으로 감지한다.

### 세션 상태 흐름

```
none  →  (PC 대여하기)  →  starting  →  ready
                                          ↓
                                    (세션 종료)
                                          ↓
                                      suspended
                                       ↙     ↘
                             (이어서 사용하기)  (새로 시작하기)
                                   ↓                ↓
                                starting          starting
```

### 세션 일시 중지 및 재개 (Suspend / Resume)

`DELETE /session/{id}` 호출 시 `docker rm -f` 대신 `docker stop`으로 컨테이너를 중지한다. 컨테이너 파일시스템·설치 패키지가 보존된다.

- `GET /session` → `docker inspect`로 `exited` 상태 감지 → `{"status": "suspended"}` 반환
- 대시보드: "이어서 사용하기" / "새로 시작하기" 선택 UI 표시
- **이어서 사용하기**: `POST /session?resume=true` → `docker start` + cloudflared 재시작
- **새로 시작하기**: `POST /session` → 기존 컨테이너 `docker rm -f` 후 새 컨테이너 생성

`_cleanup_stopped_containers()` (서버 재시작 시 실행)는 `active_session` 컨테이너를 건드리지 않아 일시 중지 상태가 보존된다.

### 런타임 복원
`session_store` (인메모리 dict)에 세션 정보 보관. `GET /session` 호출 시 dict를 확인하고, `restarting` 플래그와 Docker inspect로 컨테이너 실행 여부를 재검증한다.

### 백엔드 재시작 후 복원
`lifespan` 훅에서 두 단계로 복원:
1. `_cleanup_stopped_containers()` — exited/dead 상태 Kasm 컨테이너 제거 (`active_session` 제외)
2. `_restore_session_from_container()` — `active_session` 컨테이너가 running/restarting이면 cloudflared URL을 읽어 session_store 재구성

### 컨테이너 내부 종료/재부팅 자동 복구
Kasm 컨테이너는 `--restart unless-stopped` 정책으로 실행된다. 사용자가 데스크톱 안에서 `shutdown -h now`나 재시작 명령을 실행하면 Docker가 자동으로 컨테이너를 재기동한다.

백엔드의 `_monitor_and_restart()` 백그라운드 태스크(10초 주기)가:
- 컨테이너가 **재시작 중** (`Restarting`)이면 `session_store.restarting = True` → `starting` 반환
- 컨테이너가 **재기동 완료**되면 cloudflared 로그에서 URL 복원 → `ready` 반환
- **cloudflared가 종료**된 경우 자동으로 재시작 + 새 URL 발급 대기

### 보안 구조
사용자 브라우저는 백엔드에 직접 접근 불가. Next.js API 라우트가 프록시 역할을 하며, 백엔드 호출 시 `x-api-key` 헤더를 주입한다. API 키는 Vercel 환경변수에만 저장되어 브라우저에 노출되지 않는다.

---

## 백엔드 재시작 주의사항

백엔드를 재시작할 때는 반드시 `start_backend.sh`를 사용해야 `API_KEY` 환경변수가 올바르게 설정된다. 직접 uvicorn을 실행하면 기본값(`dev-secret-change-me`)이 사용되어 프론트엔드 인증이 실패한다.

```bash
ssh admin-swai@100.87.162.103  # asdwsx12!
bash ~/start_backend.sh
# URL 고정 (https://api.dshs-app.net) — Vercel Redeploy 불필요
```

서버 부팅 시 자동 시작되는 서비스:
- `backend.service` — FastAPI uvicorn
- `kasm-tunnel.service` — Cloudflare Named Tunnel (api + kasm 도메인)
- `nginx` — Kasm 프록시 (port 80 → 8080, Authorization 헤더 주입)

수동 재시작:
```bash
sudo systemctl restart backend       # FastAPI만
sudo systemctl restart kasm-tunnel   # 터널만
bash ~/start_backend.sh              # FastAPI 수동 재시작 (터널은 별도)
```

---

## 학교망 접속 관련 이슈

~~학교 네트워크 DNS가 `*.trycloudflare.com`을 차단한다.~~

**해결 완료 (2026-06-27)**: Cloudflare Named Tunnel + 고정 도메인 `dshs-app.net` 도입.
- `https://api.dshs-app.net` — 백엔드 API (Vercel → 서버)
- `https://kasm.dshs-app.net` — VNC 세션 (학생 브라우저 직접 접근)

Quick Tunnel(`*.trycloudflare.com`) 완전 제거. VPN 불필요.

---

## 알려진 이슈 및 미결 사항

- 세션 정보가 인메모리 dict — 서버 재시작 시 `_restore_session_from_container()`로 복원되나 DB 연동 미완료
- 실제 VNC 접속 여부(사용자가 브라우저로 접속 중인지)는 확인하지 않음 — 컨테이너 실행 여부만 체크
- 스케줄러(자동 세션 회수) 미구현
- 나머지 노드 세팅 미완료
- ~~학교망 DNS 차단~~ → Named Tunnel으로 해결 완료
- ~~Quick Tunnel 재시작 시 URL 변경~~ → Named Tunnel으로 해결 완료
