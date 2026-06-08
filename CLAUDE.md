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

| 항목 | 값 |
|------|-----|
| Tailscale IP | `100.115.25.22` |
| 내부망 IP | `10.72.117.24` |
| GPU | NVIDIA RTX 3080 |
| OS | Ubuntu (GDM 비활성화, multi-user.target) |
| 컨테이너 이미지 | `kasmweb/ubuntu-jammy-desktop:1.16.0` |
| 접속 URL (교내) | `http://10.72.117.24/` |

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
ssh student3@100.115.25.22  # BOS123!@#
bash ~/start_backend.sh
# 출력된 BACKEND_URL을 Vercel 환경변수에 설정 후 Redeploy
```

---

## 학교망 접속 관련 이슈

학교 네트워크 DNS가 `*.trycloudflare.com`을 차단한다. 구조적 이유:
- **백엔드 API 터널**: Vercel 서버가 서버측에서 호출 → 사용자 브라우저 무관 ✅
- **세션 VNC 터널**: 사용자 브라우저가 직접 접근 → 학교망 DNS 차단 ❌

**현재 해결 방법**: VPN을 켜고 접속.

**장기 해결 방법**: 고정 도메인 Cloudflare Named Tunnel 도입 (Quick Tunnel과 달리 차단될 가능성 낮음).

---

## 알려진 이슈 및 미결 사항

- Quick Tunnel 재시작 시 URL이 바뀌므로 Vercel `BACKEND_URL` 수동 업데이트 필요
- 세션 정보가 인메모리 dict — 서버 재시작 시 `_restore_session_from_container()`로 복원되나 DB 연동 미완료
- 실제 VNC 접속 여부(사용자가 브라우저로 접속 중인지)는 확인하지 않음 — 컨테이너 실행 여부만 체크
- 스케줄러(자동 세션 회수) 미구현
- 나머지 14대 노드 세팅 미완료
- 학교망에서 `*.trycloudflare.com` DNS 차단 — VPN 필요 (§26 참고)
- cloudflared가 재시작되면 URL이 바뀌므로 포털 새로고침 필요 (자동 감지 후 폴링 전환은 구현됨)
