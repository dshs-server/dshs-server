# PC 대여 시스템 배포 가이드

## 현재 상태 (2026-06-27 기준)
- ✅ 백엔드 (FastAPI) — 서버에서 실행 중
- ✅ Cloudflare Named Tunnel — `api.dshs-app.net` + `kasm.dshs-app.net` (고정, 재부팅 후에도 유지)
- ✅ 프론트엔드 (Next.js) — Vercel 배포 완료
- ✅ 학교망 DNS 차단 문제 해결 완료 (VPN 불필요)

---

## 1. 서버 백엔드 시작/재시작

서버가 재부팅되면 `backend.service`와 `kasm-tunnel.service`가 자동 시작된다. 수동으로 재시작할 경우:

```bash
ssh admin-swai@100.87.162.103
# 비밀번호: asdwsx12!

# FastAPI 재시작
bash ~/start_backend.sh

# Named Tunnel 재시작
sudo systemctl restart kasm-tunnel

# 상태 확인
sudo systemctl status backend kasm-tunnel nginx
```

**BACKEND_URL은 고정** (`https://api.dshs-app.net`) — Vercel 업데이트 불필요.

---

## 2. Vercel 환경변수 (최초 1회 설정 후 변경 불필요)

| 변수명 | 값 |
|--------|-----|
| `BACKEND_URL` | `https://api.dshs-app.net` |
| `API_KEY` | `pc-rental-secret-2024` |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | `admin1234` |
| `AUTH_SECRET` | `pc-rental-auth-secret-super-random-2024` |

---

## 3. Cloudflare Named Tunnel 정보

| 항목 | 값 |
|------|-----|
| Tunnel ID | `a3e0c5e1-b71c-48f4-991a-5f3ec4810229` |
| 도메인 | `dshs-app.net` |
| 백엔드 URL | `https://api.dshs-app.net` → `localhost:8000` |
| 세션 VNC URL | `https://kasm.dshs-app.net` → `localhost:80` (nginx) |
| Zone ID | `d3b89064edaac87902c2458740a78a55` |
| Account ID | `89d76756960a4356d238c59ba78003c7` |
| 서버 설정 파일 | `~/.cloudflared/config.yml` |
| systemd 서비스 | `kasm-tunnel.service` |

터널 재생성이 필요할 경우 → CLAUDE.md "새 서버 초기 설정 가이드" 참고.

---

## 4. Vercel 배포 (최초 1회 또는 재배포)

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
vercel deploy --prod
```

또는 Vercel 웹사이트:
1. [vercel.com](https://vercel.com) → New Project → `minigu5/dshs-server` 연결
2. Root Directory: `frontend` 설정 (필수)
3. 환경변수 5개 입력 후 Deploy

---

## 5. 로컬 테스트

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
npm run dev
# http://localhost:3000
# 아이디: admin / 비밀번호: admin1234
```

---

## 시스템 구조

```
[학생 브라우저]
    → Vercel (Next.js 프론트엔드)
        → Next.js API 라우트 (프록시)
            → Cloudflare Named Tunnel (api.dshs-app.net)
                → FastAPI 백엔드 (서버 포트 8000)
                    → docker run (Kasm 컨테이너 포트 8080→6901)

[학생 브라우저]
    → Cloudflare Named Tunnel (kasm.dshs-app.net)
        → nginx 포트 80 (Authorization 헤더 자동 주입)
            → Kasm KasmVNC 스트리밍
```

### 서버에서 실행 중인 서비스 (systemd)
| 서비스 | 역할 |
|--------|------|
| `backend.service` | FastAPI uvicorn (포트 8000) |
| `kasm-tunnel.service` | Cloudflare Named Tunnel (api + kasm) |
| `nginx` | Kasm 역방향 프록시 (포트 80 → 8080) |
| `docker` | Kasm 컨테이너 실행 환경 |
