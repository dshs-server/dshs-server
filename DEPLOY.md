# PC 대여 시스템 배포 가이드

## 현재 상태 (2026-06-07 기준)
- ✅ 백엔드 (FastAPI) — 서버에서 실행 중
- ✅ cloudflared 백엔드 터널 — 실행 중
- ✅ 프론트엔드 (Next.js) — Vercel 배포 완료

---

## 1. 서버 백엔드 시작/재시작

서버가 재부팅되면 백엔드와 cloudflared를 다시 시작해야 합니다.
**반드시 `~/start_backend.sh`를 사용할 것** — 직접 uvicorn을 실행하면 `API_KEY`가 기본값으로 설정되어 프론트엔드 인증이 실패합니다.

```bash
ssh student3@100.115.25.22
# 비밀번호: BOS123!@#

bash ~/start_backend.sh
```

출력 예시:
```
FastAPI OK
=========================================
BACKEND_URL=https://xxxx.trycloudflare.com
Vercel 환경변수에 위 URL을 설정하세요.
=========================================
```

---

## 2. Vercel 환경변수 설정

Vercel 대시보드 → 프로젝트 → Settings → Environment Variables 에 아래 추가:

| 변수명 | 값 | 비고 |
|--------|-----|------|
| `BACKEND_URL` | `https://xxxx.trycloudflare.com` | start_backend.sh 출력값 |
| `API_KEY` | `pc-rental-secret-2024` | 백엔드 API 키 |
| `ADMIN_USERNAME` | `admin` | 포털 로그인 아이디 |
| `ADMIN_PASSWORD` | `admin1234` | 포털 로그인 비밀번호 |
| `AUTH_SECRET` | `pc-rental-auth-secret-super-random-2024` | 세션 쿠키 서명 키 |

---

## 3. 서버 재시작 후 BACKEND_URL 업데이트

Quick Tunnel은 재시작 시 URL이 바뀝니다.

1. 서버에서 `bash ~/start_backend.sh` 실행
2. 새 BACKEND_URL 복사
3. Vercel 대시보드 → Environment Variables → `BACKEND_URL` 수정
4. "Redeploy" 버튼 클릭

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

## 6. 학교망 접속 주의사항

학교 네트워크 DNS가 `*.trycloudflare.com`을 차단합니다.

- **백엔드 API**: Vercel 서버가 서버측 호출 → 영향 없음 ✅
- **세션 VNC URL**: 사용자 브라우저 직접 접근 → DNS 차단 ❌

**해결 방법**: VPN을 켜고 접속.
내부망 직접 접속(`http://10.72.117.24/`)은 학교 VLAN/ACL로 차단되어 사용 불가.

---

## 시스템 구조

```
[학생 브라우저]
    → Vercel (Next.js 프론트엔드)
        → Next.js API 라우트 (프록시)
            → cloudflared Quick Tunnel (백엔드용)
                → FastAPI 백엔드 (서버 포트 8000)
                    → docker run (Kasm 컨테이너 포트 8080→6901)
                    → cloudflared Quick Tunnel (세션용)
                        → nginx 포트 80 (Authorization 자동 주입)
                            → Kasm KasmVNC 스트리밍
[URL 반환] → 학생에게 표시 (VPN 필요)
```
