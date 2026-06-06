# PC 대여 시스템 배포 가이드

## 현재 상태
- ✅ 백엔드 (FastAPI) — 서버에서 실행 중
- ✅ cloudflared 백엔드 터널 — 실행 중
- ✅ 프론트엔드 (Next.js) — 빌드 완료, Vercel 배포 대기 중

---

## 1. 서버 백엔드 시작/재시작

서버가 재부팅되면 백엔드와 cloudflared를 다시 시작해야 합니다:

```bash
ssh student3@100.115.25.22
# 비밀번호: BOS123!@#

bash ~/start_backend.sh
```

출력 예시:
```
BACKEND_URL=https://xxxx.trycloudflare.com
Vercel 환경변수에 위 URL을 설정하세요.
```

---

## 2. Vercel 배포 (최초 1회)

### 방법 A: Vercel CLI 사용

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
vercel deploy --prod
```

### 방법 B: Vercel 웹사이트
1. https://vercel.com 로그인
2. "New Project" → "Import Git Repository"
3. `frontend/` 폴더를 GitHub에 push한 뒤 연결

---

## 3. Vercel 환경변수 설정

Vercel 대시보드 → 프로젝트 → Settings → Environment Variables 에 아래 추가:

| 변수명 | 값 | 비고 |
|--------|-----|------|
| `BACKEND_URL` | `https://xxxx.trycloudflare.com` | start_backend.sh 출력값 |
| `API_KEY` | `pc-rental-secret-2024` | 백엔드 API 키 |
| `ADMIN_USERNAME` | `admin` | 포털 로그인 아이디 |
| `ADMIN_PASSWORD` | `admin1234` | 포털 로그인 비밀번호 |
| `AUTH_SECRET` | `pc-rental-auth-secret-super-random-2024` | 세션 쿠키 서명 키 |

---

## 4. 서버 재시작 후 BACKEND_URL 업데이트

Quick Tunnel은 재시작 시 URL이 바뀝니다.

1. 서버에서 `bash ~/start_backend.sh` 실행
2. 새 BACKEND_URL 복사
3. Vercel 대시보드 → Environment Variables → BACKEND_URL 수정
4. "Redeploy" 버튼 클릭

---

## 5. 로컬 테스트

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
npm run dev
# http://localhost:3000 접속
# 아이디: admin / 비밀번호: admin1234
```

---

## 현재 접속 정보 (2026-06-06 기준)

| 항목 | 값 |
|------|-----|
| 백엔드 URL | https://softball-mating-briefly-presence.trycloudflare.com |
| API 키 | pc-rental-secret-2024 |
| 포털 아이디 | admin |
| 포털 비밀번호 | admin1234 |

---

## 시스템 구조

```
[학생 브라우저]
    → Vercel (Next.js 프론트엔드)
        → Next.js API 라우트 (프록시)
            → cloudflared Quick Tunnel
                → FastAPI 백엔드 (서버 포트 8000)
                    → docker run (Kasm 컨테이너 포트 8080)
                    → cloudflared Quick Tunnel (세션용)
                        → nginx 포트 80 (Authorization 주입)
                            → Kasm 컨테이너 포트 8080
[URL 반환] → 학생에게 표시
```
