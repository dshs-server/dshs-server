# DSHS 전산실 PC 대여 시스템 — 관리자 매뉴얼

> **버전**: 2.0 | **최종 수정**: 2026-07-01  
> **작성 대상**: 시스템 담당 관리자 (차기 관리자 포함)

---

## 1. 시스템 아키텍처 개요

```
학생 브라우저
  → Vercel (Next.js 14 프론트엔드)
    → Next.js API 라우트 (허브 프록시)
      → Cloudflare Named Tunnel (hub.dshs-app.net)
        → 허브 FastAPI (admin-swai-00, port 8001)
          → SSH/asyncssh (Tailscale 내부망)
            → 각 노드: docker run/stop/start

학생 브라우저
  → Cloudflare Named Tunnel (kasm-NN.dshs-app.net)
    → nginx port 80 (Authorization 헤더 자동 주입)
      → KasmVNC (port 8080, Windows 10 환경)
```

**핵심 원칙**:
- 학생 브라우저는 허브에 직접 접근 불가 (Next.js가 프록시)
- API 키는 Vercel 환경변수에만 저장, 브라우저에 노출 안 됨
- 모든 외부 접속은 Cloudflare Named Tunnel (고정 도메인)

---

## 2. 서버 목록 및 접속 정보

### 2-1. 허브 서버 (admin-swai-00)

| 항목 | 값 |
|---|---|
| 역할 | 중앙 관리 허브 (세션 생성/삭제/모니터링) |
| Tailscale IP | `100.79.232.71` |
| 내부망 IP | `10.72.117.22` |
| SSH 유저 | `admin-swai` |
| SSH 비밀번호 | `asdwsx12!` |
| 외부 도메인 | `hub.dshs-app.net` |
| 백엔드 포트 | `8001` |

```bash
# 허브 서버 접속
ssh admin-swai@100.79.232.71
# 비밀번호: asdwsx12!
```

### 2-2. 노드 서버 목록

SSH 유저: `admin-swai` (server-03은 `ai-admin`) / 비밀번호: `asdwsx12!`

| node_id | Tailscale IP | 내부망 IP | kasm_url | GPU | 상태 |
|---|---|---|---|---|---|
| server-01 | 100.87.162.103 | 10.72.117.23 | kasm.dshs-app.net | GTX 1660 | ✅ |
| server-02 | 100.110.8.35 | 10.72.117.36 | kasm-02.dshs-app.net | GTX 1660 | ✅ |
| server-03 | 100.109.183.52 | - | kasm-03.dshs-app.net | GTX 1660 | ❌ 오프라인 |
| server-04 | 100.123.77.8 | - | kasm-04.dshs-app.net | GTX 1660 | ❌ ACL 차단 |
| server-05 | 100.104.101.114 | 10.72.117.25 | kasm-05.dshs-app.net | GTX 1660 | ✅ |
| server-06 | 100.110.173.21 | 10.72.117.34 | kasm-06.dshs-app.net | GTX 1660 | ✅ |
| server-07 | 100.120.112.29 | 10.72.117.26 | kasm-07.dshs-app.net | GTX 1660 | ✅ |
| server-08 | 100.75.29.127 | 10.72.117.27 | kasm-08.dshs-app.net | GTX 1660 | ✅ |
| server-09 | 100.126.177.87 | 10.72.117.33 | kasm-09.dshs-app.net | GTX 1660 | ✅ |
| server-10 | 100.118.120.78 | 10.72.117.32 | kasm-10.dshs-app.net | GTX 1660 | ✅ |
| server-11 | 100.64.67.55 | 10.72.117.29 | kasm-11.dshs-app.net | GTX 1660 | ✅ |
| server-12 | 100.77.233.89 | 10.72.117.28 | kasm-12.dshs-app.net | GTX 1660 | ✅ |
| server-13 | 100.102.195.21 | 10.72.117.31 | kasm-13.dshs-app.net | RTX 3070 LHR | ⚠️ 컴퓨터 고장 |
| server-14 | 100.116.9.36 | 10.72.117.30 | kasm-14.dshs-app.net | GTX 1660 | ✅ |
| server-15 | 100.69.43.53 | 10.72.117.21 | kasm-15.dshs-app.net | GTX 1660 | ✅ |
| server-16 | 100.104.194.37 | 10.72.117.40 | kasm-16.dshs-app.net | RTX 3080 | ✅ |
| server-17 | 100.88.82.15 | 10.72.117.41 | kasm-17.dshs-app.net | RTX 2080 Ti×2 | ✅ |

> **server-03**: 오프라인 — 물리 접근 필요  
> **server-04**: Tailscale SSH ACL 차단 (`tailscale set --ssh=false` 후 재시도 필요)  
> **server-13**: SSH 비밀번호 불명, 접근 보류

---

## 3. 허브 서버 관리

### 3-1. 서비스 상태 확인 및 재시작

```bash
ssh admin-swai@100.79.232.71  # 비밀번호: asdwsx12!

# 상태 확인
sudo systemctl status hub hub-tunnel

# 재시작
sudo systemctl restart hub          # FastAPI 백엔드 재시작
sudo systemctl restart hub-tunnel   # Cloudflare 터널 재시작

# 로그 확인
sudo journalctl -u hub -f           # 실시간 로그
sudo journalctl -u hub -n 200       # 최근 200줄
```

> `hub.dshs-app.net` 도메인은 Named Tunnel 고정 — 재시작 후 Vercel 재배포 불필요

### 3-2. 파일 위치 (허브 서버 내)

| 파일 | 경로 |
|---|---|
| 백엔드 코드 | `~/hub/main.py` |
| Firebase 서비스 키 | `~/hub/serviceAccountKey.json` |
| 환경변수 | `~/.hub.env` |
| cloudflared config | `~/.cloudflared/config.yml` |
| 터널 credentials | `~/.cloudflared/531d56d6-fce0-4eec-b71b-fe09d93d428b.json` |

### 3-3. 환경변수 (`~/.hub.env`)

```bash
API_KEY=pc-rental-secret-2024
FIREBASE_CRED=/home/admin-swai/hub/serviceAccountKey.json
SSH_PASSWORD=asdwsx12!
RECOVERY_INTERVAL=60    # 서비스 자동 복구 체크 간격(초)
```

### 3-4. 허브 코드 수정 후 재시작

```bash
# 허브 서버에서
nano ~/hub/main.py        # 코드 수정
sudo systemctl restart hub
sudo journalctl -u hub -f  # 에러 없으면 정상
```

---

## 4. API 사용법 (관리자 CLI)

모든 요청에 `x-api-key: pc-rental-secret-2024` 헤더 필요.

### 4-1. 상태 확인

```bash
# 헬스체크
curl -s https://hub.dshs-app.net/health

# 전체 노드 목록 + 상태
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/nodes | python3 -m json.tool

# 실시간 메트릭 (10초 캐시)
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/admin/nodes | python3 -m json.tool

# 전체 활성 세션 요약
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/admin/status | python3 -m json.tool

# 전 노드 서비스 상태 (nginx·kasm-tunnel·tailscaled)
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/admin/service-health | python3 -m json.tool
```

### 4-2. 세션 강제 종료

```bash
curl -s -X POST "https://hub.dshs-app.net/admin/terminate" \
  -H "x-api-key: pc-rental-secret-2024" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "세션ID"}'
```

### 4-3. 중단된 컨테이너 정리

```bash
curl -s -X POST "https://hub.dshs-app.net/admin/cleanup" \
  -H "x-api-key: pc-rental-secret-2024"
```

### 4-4. 공지사항 등록

```bash
# 공지 등록
curl -s -X POST "https://hub.dshs-app.net/notice" \
  -H "x-api-key: pc-rental-secret-2024" \
  -H "Content-Type: application/json" \
  -d '{"message": "공지 내용", "expires_at": "2026-12-31T23:59:59"}'

# 공지 조회
curl -s https://hub.dshs-app.net/notice
```

### 4-5. 전체 API 엔드포인트 목록

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 헬스체크 |
| GET | `/nodes` | 노드 목록 + 스펙 + 세션 상태 |
| GET | `/session` | 내 활성·일시중지 세션 조회 |
| GET | `/session/{id}` | 세션 상태 폴링 |
| POST | `/session` | 새 세션 생성 |
| POST | `/session?resume=true&session_id=` | 일시중지 세션 재개 |
| DELETE | `/session/{id}` | 일시 중지 (docker stop) |
| DELETE | `/session/{id}?permanent=true` | 영구 삭제 (docker rm -f) |
| GET | `/admin/nodes` | 실시간 메트릭 (10초 캐시) |
| POST | `/admin/nodes?node_id=` | 노드 등록 |
| DELETE | `/admin/nodes/{id}` | 노드 제거 |
| GET | `/admin/users` | 사용자 목록 |
| PATCH | `/admin/users/{email}` | max_sessions 변경 |
| GET | `/admin/status` | 전체 활성 세션 요약 |
| POST | `/admin/terminate` | 세션 강제 중지 |
| POST | `/admin/cleanup` | 중단 컨테이너 정리 |
| GET | `/admin/service-health` | 전 노드 서비스 상태 |
| GET/POST | `/notice` | 공지사항 조회/등록 |

---

## 5. 노드 서버 관리

### 5-1. 개별 노드 접속

```bash
# 예: server-01
ssh admin-swai@100.87.162.103   # 비밀번호: asdwsx12!

# server-03만 유저명 다름
ssh ai-admin@100.109.183.52
```

### 5-2. 노드 서비스 재시작

```bash
# 노드에 접속 후
sudo systemctl restart nginx          # nginx 재시작
sudo systemctl restart kasm-tunnel    # Cloudflare 터널 재시작
sudo systemctl status nginx kasm-tunnel
```

### 5-3. 노드에서 실행 중인 컨테이너 확인

```bash
# 노드 접속 후
docker ps                             # 실행 중 컨테이너
docker ps -a                          # 정지 포함 전체
docker stats --no-stream              # 리소스 사용량
```

### 5-4. 세션 컨테이너 수동 조작

```bash
# 컨테이너 강제 종료
docker stop kasm_<세션ID>
docker rm -f kasm_<세션ID>

# 로그 확인
docker logs kasm_<세션ID> --tail 50
```

### 5-5. 자동 서비스 복구

허브의 `_poll_nodes_loop()`가 **10초마다** 각 노드에서 nginx·kasm-tunnel·tailscaled 상태 수집.  
`RECOVERY_INTERVAL`(기본 60초)마다 다운된 서비스 감지 시 `sudo systemctl restart` 자동 실행.

> **주의**: Tailscale이 다운되면 허브→노드 SSH 자체가 불가 → 원격 복구 불가능.  
> 반드시 3개 서비스 모두 `enabled` 상태 유지:
> ```bash
> systemctl is-enabled tailscaled nginx kasm-tunnel
> ```

---

## 6. 노드 등록 / 제거

### 6-1. 노드 등록

```bash
curl -s -X POST "https://hub.dshs-app.net/admin/nodes?node_id=server-XX" \
  -H "x-api-key: pc-rental-secret-2024" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "XX호기",
    "ip": "10.72.117.XX",
    "ssh_user": "admin-swai",
    "kasm_url": "https://kasm-XX.dshs-app.net",
    "cpu": "Intel Core i7-9700",
    "cpu_cores": 8,
    "gpu": "NVIDIA GTX 1660",
    "gpu_type": "nvidia",
    "ram_gb": 32,
    "storage_gb": 468
  }'

# 등록 확인
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/nodes | python3 -m json.tool
```

### 6-2. 노드 제거

```bash
curl -s -X DELETE "https://hub.dshs-app.net/admin/nodes/server-XX" \
  -H "x-api-key: pc-rental-secret-2024"
```

---

## 7. 새 노드 서버 초기 설정 절차

새 PC를 시스템에 추가할 때 아래 순서대로 진행합니다.

### Step 1: 물리 접근 — SSH 서버 설치

물리적으로 PC에 접근하여:
```bash
sudo apt update && sudo apt install -y openssh-server
sudo systemctl enable --now ssh
```

### Step 2: 불필요한 유저 삭제

`admin-swai` 하나만 남기고 나머지 uid≥1000 유저 삭제:
```bash
getent passwd | awk -F: '$3 >= 1000 && $1 != "admin-swai" {print $1}' | \
  xargs -r -I{} sudo userdel -r {} 2>/dev/null || true

# 확인 (admin-swai 하나만 출력돼야 함)
getent passwd | awk -F: '$3 >= 1000 {print $1}'
```

### Step 3: 기본 패키지 설치

```bash
# Docker 설치
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
sudo systemctl enable --now docker

# cloudflared 설치
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# nginx 설치 및 Kasm 프록시 설정
sudo systemctl stop apache2 2>/dev/null; sudo systemctl disable apache2 2>/dev/null || true
sudo apt-get install -y nginx

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

> Authorization 헤더 `a2FzbV91c2VyOnRlc3QxMjM0` = `kasm_user:test1234` Base64 인코딩

### Step 4: NVIDIA GPU 드라이버 도구 설치

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Step 5: GDM Wayland 비활성화 (NVIDIA 필수)

NVIDIA GPU 환경에서 Wayland greeter가 DRM master 충돌 → 물리 화면/키보드 먹통 방지:
```bash
sudo sed -i 's/#WaylandEnable=false/WaylandEnable=false/' /etc/gdm3/custom.conf
sudo systemctl restart gdm3

# 확인 — "WaylandEnable=false" 출력돼야 함
grep WaylandEnable /etc/gdm3/custom.conf
```

### Step 6: Docker 이미지 전송

`dshs-kasm-win10:latest` (12.9GB)를 기존 노드에서 파이프 전송:
```bash
# server-01(100.87.162.103)에서 실행 (약 30~40분 소요)
docker save dshs-kasm-win10:latest | \
  sshpass -p 'asdwsx12!' ssh admin-swai@<새노드IP> docker load
```

### Step 7: Cloudflare Named Tunnel 설정

Cloudflare 대시보드에서 Connector Token 발급:  
Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared → 토큰 복사

```bash
sudo tee /etc/systemd/system/kasm-tunnel.service << 'EOF'
[Unit]
Description=Cloudflare Named Tunnel (kasm)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin-swai
ExecStart=/usr/bin/cloudflared tunnel run --token <TUNNEL_TOKEN>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now kasm-tunnel

# 확인
sudo systemctl status kasm-tunnel
```

### Step 8: 내부망 IP 확인 및 허브 등록

```bash
# 새 노드에서 내부망 IP 확인 (10.72.x.x 대역)
ip -4 addr show | grep '10\.72\.' | awk '{print $2}' | cut -d/ -f1

# Mac 또는 허브 서버에서 등록
curl -s -X POST "https://hub.dshs-app.net/admin/nodes?node_id=server-XX" \
  -H "x-api-key: pc-rental-secret-2024" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "XX호기",
    "ip": "<위에서 확인한 IP>",
    "ssh_user": "admin-swai",
    "kasm_url": "https://kasm-XX.dshs-app.net",
    "cpu": "Intel Core i7-9700",
    "cpu_cores": 8,
    "gpu": "NVIDIA GTX 1660",
    "gpu_type": "nvidia",
    "ram_gb": 32,
    "storage_gb": 468
  }'
```

---

## 8. Vercel (프론트엔드) 관리

### 8-1. 환경변수

| 변수명 | 값 | 설명 |
|---|---|---|
| `BACKEND_URL` | `https://hub.dshs-app.net` | **고정** — 절대 변경 불필요 |
| `API_KEY` | `pc-rental-secret-2024` | 허브 인증 키 |
| `ADMIN_USERNAME` | (설정값) | 포털 로그인 ID |
| `ADMIN_PASSWORD` | (설정값) | 포털 로그인 PW |
| `AUTH_SECRET` | (설정값) | 세션 쿠키 서명 키 |

### 8-2. 프론트엔드 코드 수정 후 배포

```bash
# 로컬에서
cd frontend
npm run dev       # 로컬 테스트 (http://localhost:3000)

# Git push → Vercel 자동 배포
git push origin main
```

- Vercel 대시보드: https://vercel.com
- Root Directory 설정: `frontend` (대시보드 → Settings → General)
- GitHub: https://github.com/dshs-server/dshs-server

---

## 9. Firebase Firestore 관리

- **프로젝트 ID**: `dshs-server`
- **리전**: `asia-northeast3` (서울)
- **콘솔**: https://console.firebase.google.com/project/dshs-server

### 컬렉션 구조

| 컬렉션 | 내용 |
|---|---|
| `nodes` | 등록된 노드 정보 (IP, 스펙, kasm_url 등) |
| `sessions` | 활성/중지 세션 정보 |
| `users` | 사용자 목록 + max_sessions 설정 |
| `config` | 시스템 설정값 |

### 서비스 계정 키

- 위치 (허브 서버): `/home/admin-swai/hub/serviceAccountKey.json`
- 키 분실 시: Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 키 생성 후 허브 서버에 업로드

---

## 10. Cloudflare 관리

- **도메인**: `dshs-app.net`
- **Account ID**: `89d76756960a4356d238c59ba78003c7`
- **Zone ID**: `d3b89064edaac87902c2458740a78a55`

### 터널 토큰 조회

```bash
CF_API_TOKEN="<Cloudflare API 토큰 — 관리자에게 별도 문의>"
curl -s -X GET \
  "https://api.cloudflare.com/client/v4/accounts/89d76756960a4356d238c59ba78003c7/cfd_tunnel/<TUNNEL_ID>/token" \
  -H "Authorization: Bearer $CF_API_TOKEN"
```

### DNS 구조

| 도메인 | 대상 |
|---|---|
| `hub.dshs-app.net` | 허브 서버 (admin-swai-00) |
| `kasm.dshs-app.net` | server-01 |
| `kasm-02.dshs-app.net` ~ `kasm-17.dshs-app.net` | server-02 ~ server-17 |

---

## 11. Docker 이미지 관리 (dshs-kasm-win10)

### 이미지 정보

- 기반: `kasmweb/ubuntu-jammy-desktop:1.16.0`
- 커스텀: Windows 10 GTK 테마, 한국어 입력(ibus-hangul), 불필요 앱 제거
- 크기: 약 12.9GB
- Kasm 기본 계정: `kasm_user` / `test1234` (nginx가 Authorization 헤더로 자동 주입)

### 커스텀 적용 내용

| 항목 | 내용 |
|---|---|
| 테마 | Windows 10 GTK 테마 + 아이콘 (b00merang-project) |
| 배경화면 | 파란 그라디언트 (#0078d4 → #003f7f) |
| 패널 | 하단 배치 (Windows 스타일) |
| 시작 메뉴 | Whisker Menu |
| 한국어 | ibus-hangul, Shift+Space 토글, LC_ALL=ko_KR.UTF-8 |
| 제거된 앱 | GIMP, OBS, Signal, Slack, Telegram, Thunderbird, Zoom 등 |
| 데스크탑 아이콘 | Chrome, Firefox, VS Code만 유지 |

### 이미지 재빌드 (변경 필요 시)

```bash
# 로컬 Mac에서 파일 전송
scp docker/* admin-swai@100.87.162.103:~/docker/

# server-01에서 빌드 (~2분, 캐시 있을 때)
ssh admin-swai@100.87.162.103
cd ~/docker && bash build.sh

# 다른 노드에 배포
docker save dshs-kasm-win10:latest | \
  sshpass -p 'asdwsx12!' ssh admin-swai@<노드IP> docker load
```

### Dockerfile 위치 (로컬)

```
docker/
├── Dockerfile         # 빌드 정의
├── build.sh           # 빌드 스크립트
└── setup-ibus.sh      # 세션 시작 시 한국어 입력기 자동 설정
```

---

## 12. 세션 자원 정책

- **노드당 최대 2 active 세션**
- 두 세션 합산 CPU+RAM → **노드 전체의 90% 이하** (Docker 커널 레벨 하드 제한)
- GPU: `--gpus all` 공유, 하드 제한 없음

### 등분 방식 예시 (10코어/32GB 노드)

| 세션 수 | CPU 한도 | RAM 한도 |
|---|---|---|
| 1개 | `--cpus 9.0` | `--memory 28.8g` |
| 2개 | `--cpus 4.5` | `--memory 14.4g` |

세션 추가/삭제 시 기존 컨테이너도 `docker update`로 자동 조정됨.

---

## 13. 트러블슈팅

### 특정 노드에 세션이 안 만들어질 때

```bash
# 1. 노드 상태 확인
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/admin/nodes | python3 -m json.tool

# 2. 해당 노드 SSH 접근 확인
ssh admin-swai@<노드 Tailscale IP>

# 3. Docker/서비스 상태 확인
docker ps -a
sudo systemctl status docker nginx kasm-tunnel

# 4. 서비스 재시작
sudo systemctl restart nginx kasm-tunnel
```

### 허브 API 응답 없을 때

```bash
# 1. 헬스체크
curl -s https://hub.dshs-app.net/health

# 2. 허브 서버 접속 후 상태 확인
ssh admin-swai@100.79.232.71
sudo systemctl status hub hub-tunnel

# 3. 재시작
sudo systemctl restart hub hub-tunnel

# 4. 로그 확인
sudo journalctl -u hub -n 100
```

### 학생 세션 먹통 신고 시

```bash
# 1. 전체 세션 현황
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/admin/status

# 2. 해당 노드에서 컨테이너 확인
ssh admin-swai@<노드IP>
docker ps | grep kasm_<세션ID>
docker logs kasm_<세션ID> --tail 30

# 3. 컨테이너 재시작
docker restart kasm_<세션ID>

# 4. 안 되면 허브에서 강제 종료
curl -s -X POST "https://hub.dshs-app.net/admin/terminate" \
  -H "x-api-key: pc-rental-secret-2024" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<세션ID>"}'
```

### Tailscale 다운 시

Tailscale 다운 → 허브→노드 SSH 불가 → **원격 복구 불가능**.

```bash
# 노드에 물리 접근 또는 내부망(10.72.x.x)으로 직접 SSH 후
sudo systemctl restart tailscaled
```

### 전체 서비스 상태 일괄 확인

```bash
curl -s -H "x-api-key: pc-rental-secret-2024" \
  https://hub.dshs-app.net/admin/service-health | python3 -m json.tool
# 각 노드의 nginx / kasm-tunnel / tailscaled 상태 표시
```

---

## 14. 미해결 이슈 (인수인계 사항)

| 항목 | 상태 | 필요 조치 |
|---|---|---|
| server-03 오프라인 | ❌ | 물리 접근 → Tailscale 재연결 |
| server-04 Tailscale ACL 차단 | ❌ | 물리 접근 → `tailscale set --ssh=false` 후 재시도 |
| server-13 SSH 비밀번호 불명 | ⚠️ | 물리 접근 → 비밀번호 확인 또는 재설정 |
| 스케줄러(자동 세션 회수) | ⚠️ | 장시간 방치 세션 자동 종료 기능 미구현 |
| server-06,08,11,12,14 GPU 미활성 | ⚠️ | NVML 불일치 — 재부팅 후 GPU 모드 활성화 필요 |

---

## 15. 정기 점검 체크리스트

### 매주

- [ ] `curl -s https://hub.dshs-app.net/health` — 허브 응답 확인
- [ ] `admin/service-health` API로 전 노드 서비스 상태 확인
- [ ] `admin/status` API로 고착된 세션(며칠 이상) 없는지 확인
- [ ] 신규 이슈 확인 (GitHub Issues)

### 매월

- [ ] Cloudflare 터널 연결 상태 전체 점검
- [ ] Firebase Firestore 용량 확인 (콘솔 → 프로젝트 설정)
- [ ] 서버별 디스크 용량 확인: `df -h` (각 노드 SSH 후)
- [ ] server-03, server-04 복구 재시도
- [ ] Docker 이미지 버전 확인: `docker images dshs-kasm-win10`

---

## 16. 주요 계정 정보 요약

| 서비스 | 계정 / 키 | 비고 |
|---|---|---|
| 모든 노드 SSH | `admin-swai` / `asdwsx12!` | server-03만 `ai-admin` |
| 허브 API 키 | `pc-rental-secret-2024` | x-api-key 헤더 |
| Cloudflare API 토큰 | `<별도 보관>` | 터널 토큰 조회용, 관리자에게 문의 |
| Kasm 기본 계정 | `kasm_user` / `test1234` | nginx가 자동 주입 (학생 노출 안 됨) |
| Firebase | dshs-server 프로젝트 | 서비스 키 허브 서버에 있음 |

---

## 17. 코드 구조 (빠른 참조)

```
/
├── frontend/          # Next.js 14 (Vercel 배포)
│   ├── app/
│   │   ├── api/login/route.ts       # 로그인
│   │   ├── api/logout/route.ts      # 로그아웃
│   │   └── api/session/             # 세션 CRUD
│   ├── lib/auth.ts                  # 쿠키 기반 인증
│   └── middleware.ts                # 미인증 차단
├── hub/
│   └── main.py        # 허브 FastAPI (멀티노드 오케스트레이터)
├── docker/
│   ├── Dockerfile     # dshs-kasm-win10 빌드
│   ├── build.sh
│   └── setup-ibus.sh  # 한국어 입력기 자동 설정
├── CLAUDE.md          # 시스템 전체 설계 문서 (AI 작업용)
└── DEPLOY.md          # 배포 가이드
```
