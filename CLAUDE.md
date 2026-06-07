# CLAUDE.md — PC 대여 포털 (dshs-server)

## 프로젝트 개요

학교 전산실 워크스테이션을 학생에게 브라우저로 대여해주는 시스템.
Docker + KasmVNC로 Ubuntu MATE 데스크톱을 스트리밍하고, Cloudflare Quick Tunnel로 외부에서 접속 가능하게 한다.

**GitHub**: https://github.com/minigu5/dshs-server

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
      → Cloudflare Quick Tunnel
        → FastAPI 백엔드 (서버컴 port 8000)
          → docker run (Kasm 컨테이너 port 8080 → 6901)
          → cloudflared Quick Tunnel (세션용)
            → nginx port 80 (Authorization 자동 주입)
              → Kasm KasmVNC 스트리밍
```

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
ssh student3@100.115.25.22  # 비밀번호: BOS123!@#
bash ~/start_backend.sh
# 출력된 BACKEND_URL을 Vercel 환경변수에 설정
```

---

## 환경변수

### Vercel (프론트엔드)
| 변수명 | 설명 |
|--------|------|
| `BACKEND_URL` | start_backend.sh 실행 후 출력되는 Quick Tunnel URL |
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
| GET | `/session` | 현재 활성 세션 조회 |
| POST | `/session` | 새 세션 생성 (Kasm 컨테이너 + cloudflared 시작) |
| GET | `/session/{id}` | 세션 상태 폴링 (url 발급 여부) |
| DELETE | `/session/{id}` | 세션 종료 (컨테이너 + 터널 삭제) |

모든 요청에 `x-api-key` 헤더 필요.

---

## Vercel 배포 설정

- **Root Directory**: Vercel 대시보드 → Settings → General → `frontend`로 설정 (필수)
- `vercel.json`은 빈 파일 유지 (`{}`)
- 서버 재시작 시 `BACKEND_URL`이 변경되므로 Vercel 환경변수 업데이트 + Redeploy 필요

---

## 노드 서버 정보

| 항목 | 값 |
|------|-----|
| Tailscale IP | `100.115.25.22` |
| 내부망 IP | `10.72.117.24` |
| GPU | NVIDIA RTX 3080 |
| OS | Ubuntu (GDM 비활성화, multi-user.target) |
| 컨테이너 이미지 | `kasmweb/ubuntu-jammy-desktop:1.16.0` |
| 접속 URL (교내) | `http://10.72.117.24/` |

---

## 알려진 이슈 및 미결 사항

- Quick Tunnel 재시작 시 URL이 바뀌므로 Vercel `BACKEND_URL` 수동 업데이트 필요
- `/tmp/runtime-ubuntu` 권한 문제 (chmod 755 임시 대책 적용 중)
- 세션 정보가 인메모리 dict — 서버 재시작 시 초기화됨 (DB 연동 미완료)
- 스케줄러(자동 세션 회수) 미구현
- 나머지 14대 노드 세팅 미완료
