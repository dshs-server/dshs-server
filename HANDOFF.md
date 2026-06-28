# 인수인계 — 파일 전송 기능 (대시보드 → 내 가상 PC)

> 다른 AI/도구(Codex 등)가 이 작업을 이어받기 위한 자급식 문서.
> 이 대화 맥락 없이도 이 문서 + 코드만으로 진행 가능.

## 2026-06-28 실제 끝단 테스트 이후 최신 상태 — 반드시 먼저 읽을 것

이 절은 아래의 기존 인수인계보다 최신이다. 아래쪽에 남아 있는 "끝단 테스트 필요",
"push 필요" 같은 문구는 최초 작성 당시 상태를 설명한 것이므로, 현재 판단에는 이 절을
우선한다.

### 결론

- **파일 전송 끝단 테스트는 실제 브라우저 화면에서 성공했다.**
- 확인된 전체 경로는 다음과 같다.

  ```text
  로컬 Next.js 화면(localhost:3003)
    → GET /api/upload-ticket 200
    → 브라우저가 https://api.dshs-app.net/upload 직접 호출
    → 중앙 허브 POST /upload 200
    → 노드 호스트 사용자별 공유 폴더
    → active_session 컨테이너 바탕화면/받은파일
  ```

- 테스트 파일은 사용자가 화면의 업로드 버튼으로 선택한
  `server_connection.zip`이었다.
- 중앙 허브 로그에서 아래 요청을 확인했다.

  ```text
  OPTIONS /upload HTTP/1.1 200 OK
  POST /upload HTTP/1.1 200 OK
  ```

- 노드 호스트에서 확인한 파일:

  ```text
  /home/admin-swai/dshs-shared/ts250015@ts.hs.kr/server_connection.zip
  크기: 644221 bytes
  SHA-256: 095a1712b039c58c38092aac5e9c2e4ef6f72384e433c8e3abb892941c2673ee
  ```

- 컨테이너 내부에서 확인한 파일:

  ```text
  /home/kasm-user/Desktop/받은파일/server_connection.zip
  크기: 644221 bytes
  SHA-256: 095a1712b039c58c38092aac5e9c2e4ef6f72384e433c8e3abb892941c2673ee
  ```

- 호스트와 컨테이너 파일의 크기와 SHA-256이 완전히 동일하므로, 단순히 API가
  200을 반환한 것뿐 아니라 노드 컨테이너까지 파일 내용이 그대로 도착한 것이
  검증되었다.

### 절대 하지 말 것

- **사용자의 새로운 명시적 승인 없이 push하지 말 것.**
- 테스트 성공 직후 `git push origin feature/file-transfer`를 한 차례 시도했지만,
  GitHub 계정 `Matwaetle`에 쓰기 권한이 없어 HTTP 403으로 실패했다.
- 따라서 이 시도로 원격 저장소에 반영된 변경은 없다.
- 다음 담당자는 "테스트가 끝났으니 자동으로 push해도 된다"고 해석하지 말고,
  반드시 사용자에게 다시 확인해야 한다.
- 실제 `.env.local`, SSH 비밀번호, Firebase 서비스 계정 개인키를 Git에 넣지 말 것.

### 현재 Git 브랜치 상태

확인 시점의 브랜치는 `feature/file-transfer`이다.

```text
로컬 HEAD:  745f0b0 Merge remote-tracking branch 'origin/main' into feature/file-transfer
원격 HEAD:  c72fe6f feat: 파일 전송(대시보드→내 PC) + 사용자 가이드
ahead/behind: 원격 기준 로컬 3커밋 ahead, behind 0
```

중요: **파일 전송 기능 자체와 사용자 가이드는 이미 원격의 `c72fe6f`까지 올라가
있다.** 로컬에만 있고 아직 원격에 없는 3개 커밋은 다음과 같다.

```text
745f0b0 Merge remote-tracking branch 'origin/main' into feature/file-transfer
9b7f7d9 refactor: SSH Tailscale→내부망 전환, 노드별 ssh_user 지원
dbce601 feat: 대시보드·관리자 모니터링 및 UI 전반 개선
```

원격 대비 로컬의 미반영 파일 범위는 다음과 같다.

```text
M  .gitignore
M  backend/main.py
M  frontend/.gitignore
M  frontend/app/admin/page.tsx
A  frontend/app/api/admin/containers/[name]/route.ts
A  frontend/app/api/admin/containers/route.ts
M  frontend/app/api/admin/nodes/route.ts
A  frontend/app/api/session/[id]/stats/route.ts
M  frontend/app/dashboard/page.tsx
M  hub/main.py
```

`HANDOFF.md`는 현재 `?? HANDOFF.md` 상태의 **미추적 파일**이다. 즉 이 문서도 아직
어느 커밋이나 원격 브랜치에도 들어 있지 않다. 사용자가 문서 포함을 승인하면 먼저
내용에 비밀이 없는지 다시 검토한 뒤 별도 커밋 대상으로 삼는다.

### 실제 중앙 PC 상태 — 기존 문서와 다른 점

기존 문서에는 중앙 PC 허브가 `~/hub`, 포트 `8001`이라고 적혀 있지만, 실제 접속 후
확인한 운영 상태는 달랐다.

```text
중앙 PC Tailscale SSH: admin-swai@100.87.162.103
실제 허브 디렉터리: /home/admin-swai/backend
실제 uvicorn 포트: 8000
공개 HTTPS 주소: https://api.dshs-app.net
health: https://api.dshs-app.net/health → 200 {"status":"ok"}
```

중앙 PC 접속 비밀번호와 노드 비밀번호는 코드나 이 문서에 적지 않는다. 담당자에게
안전한 채널로 받아야 한다.

처음 접속했을 당시 중앙 PC의 `/home/admin-swai/backend/main.py`는 Docker를 중앙
PC에서 직접 실행하는 구형 단일-PC 코드였다. 새 `hub/main.py`는 Firebase와 SSH를
사용하는 멀티 노드 코드이므로 다음 파일을 실제 운영 경로에 배포했다.

```text
/home/admin-swai/backend/main.py
/home/admin-swai/backend/requirements.txt
/home/admin-swai/backend/serviceAccountKey.json
```

기존 운영 파일 백업 위치:

```text
/home/admin-swai/backend/backups/20260628-134710/
```

운영 `start.sh`도 `/home/admin-swai/backend`, 포트 8000 구조를 유지하면서 다음을
하도록 중앙 PC에서 수정했다.

- `$HOME/.hub.env`를 source하여 `SSH_PASSWORD`를 읽는다.
- `FIREBASE_CRED` 기본값을
  `/home/admin-swai/backend/serviceAccountKey.json`으로 잡는다.
- 기존 uvicorn을 종료하고 새 `main:app`을 `0.0.0.0:8000`에서 nohup으로 실행한다.
- `requirements.txt`에 있는 `asyncssh`, `firebase-admin`, `python-multipart` 등을
  설치한다.

재시작 직후 `IMPORT_OK`, `/health` 200, `/nodes` 200, `/session` 200을 확인했다.
중앙 PC의 수정된 `start.sh`는 실제 배포 환경 전용이며 현재 Git의 `hub/start.sh`와
경로/포트가 다르다.

### Firebase 서비스 계정 주의

- 테스트를 위해 Firebase Admin 서비스 계정 JSON을 받아 중앙 PC의
  `/home/admin-swai/backend/serviceAccountKey.json`에 권한 600으로 설치했다.
- 로컬에는 `hub/serviceAccountKey.json`으로 존재하지만 `hub/.gitignore`에 의해
  무시된다.
- 서비스 계정 개인키가 대화에 한 번 노출되었으므로 **폐기하고 새 키로 교체해야
  한다.**
- 교체할 때는 새 JSON을 중앙 PC의 같은 경로에 권한 600으로 넣고 허브를 재시작한다.
- 새 개인키 원문이나 실제 JSON을 Git, 문서, PR, 이슈에 붙이지 않는다.

### 실제 노드 정보 — 기존 문서의 ssh_user 수정

Firestore의 `nodes/server-01` 문서를 직접 확인한 실제 값:

```text
ip: 10.72.117.23
ssh_user: admin-swai
name: 1호기
container: active_session
```

기존 인수인계의 `ai-admin`은 실제 Firestore 값과 달랐다. `ai-admin`으로 SSH를 시도하면
인증이 실패했지만, 새 허브의 `_ssh(..., ssh_user="admin-swai")` 경로로는 다음을
확인했다.

```text
RC=0
NODE_SSH_OK
whoami → admin-swai
active_session → running
```

따라서 이후 디버깅에서는 하드코딩한 사용자명이 아니라 반드시 Firestore
`node["ssh_user"]`를 사용해야 한다.

### 로컬 frontend 테스트에서 발견한 설정 문제와 해결법

로컬 frontend는 `frontend/node_modules`가 이미 설치되어 있었고 `npm run dev`로
실행했다. 당시 3000~3002 포트가 사용 중이라 Next.js가 `http://localhost:3003`에서
실행되었다. 다음 실행에서는 사용 가능한 포트가 달라질 수 있으므로 터미널의 `Local`
주소를 확인한다.

로컬 테스트에 사용된 비밀이 아닌 URL 설정:

```dotenv
BACKEND_URL=https://api.dshs-app.net
HUB_LAN_URL=https://api.dshs-app.net
```

`API_KEY`는 로컬 frontend와 중앙 허브가 반드시 같아야 한다. 테스트 초기에 두 값이
달라서 다음 현상이 있었다.

- 허브는 `/session`에 401을 반환했다.
- frontend BFF의 `GET /api/session`은 허브의 non-2xx를 `{status:"none"}`으로
  숨겼다.
- 대시보드는 사용자의 활성 세션을 찾지 못해 `ready`가 되지 않았다.
- `UploadButton`은 `ReadyState` 안에만 있으므로 화면에 업로드 버튼이 나타나지 않았다.

로컬 `.env.local`의 `API_KEY`를 중앙 허브와 맞춘 뒤 결과:

```json
{
  "status": "ready",
  "session_id": "1a3adb39",
  "url": "https://kasm.dshs-app.net"
}
```

이후 `GET /api/session/{id}/stats`도 200이 되었고 `ReadyState`와 업로드 버튼이
표시되었다. 실제 API 키 값은 이 문서에 기록하지 않는다.

### 로컬 개발 로그인 주의

- 로그인 화면의 Google 버튼은 현재 Firebase `signInWithPopup()`을 호출한다.
- `frontend/app/api/auth/google/route.ts`에는 Google OAuth를 건너뛰는 개발용 로그인
  라우트가 있지만, 현재 로그인 버튼과 자동 연결되어 있지 않다.
- 로컬 끝단 테스트에서는 브라우저에서
  `http://localhost:<실행포트>/api/auth/google`로 직접 들어가 세션 쿠키를 발급했다.
- 활성 세션 소유자의 명시적 허가를 받은 뒤에만 `DEV_LOGIN_EMAIL`을 그 이메일로
  설정해야 한다. 다른 사람의 세션을 임의로 가장하지 않는다.
- 테스트 당시 승인받아 사용한 활성 세션 소유자는 `ts250015@ts.hs.kr`이었다.
- 개발 우회 라우트가 운영 배포에서도 무조건 열리지 않도록 향후 production gate를
  추가하는 것이 좋다.

### Firestore 상태 불일치 관찰

테스트 중 관리 API에서 다음과 같은 불일치가 관찰되었다.

- `/admin/status`는 활성 세션 소유자를 `ts250015@ts.hs.kr`, `total_active: 2`로
  반환했다.
- `/admin/nodes`의 실시간 노드 메트릭은 프로젝트/소유자를 다른 값으로 표시한 적이
  있었다.
- `GET /session`은 승인받은 테스트 계정에 대해 세션 `1a3adb39`를 `ready`로 정상
  반환했고 실제 업로드도 그 계정의 공유 폴더에 성공했다.

즉 파일 전송 기능은 성공했지만, Firestore에 중복 또는 오래된 active 세션 문서가
있는지 별도로 점검할 가치가 있다. 다른 사용자의 세션을 확인 없이 삭제하지 않는다.

### 다음 담당자가 할 일

1. push하지 말고 먼저 사용자에게 현재 로컬/원격 차이를 보여준다.
2. 이 문서 자체가 미추적 상태임을 알리고, 문서를 커밋할지 승인받는다.
3. 노출된 Firebase 서비스 계정 키를 폐기하고 새 키로 중앙 PC 파일을 교체한다.
4. 필요하면 Firestore의 중복/오래된 active 세션을 읽기 전용으로 조사한다.
5. frontend BFF가 허브의 401/500을 `{status:"none"}`으로 숨기지 않도록 오류 전달을
   개선할지 팀과 상의한다.
6. 개발 로그인 라우트를 production에서 차단할지 팀과 상의한다.
7. 원격에 없는 3개 커밋을 올릴지는 반드시 사용자 또는 저장소 관리자의 명시적
   지시를 받은 뒤 진행한다.

## 0. 한 줄 요약

학생이 **로컬에서 띄운 frontend의 업로드 버튼**으로 파일을 올리면 → **중앙 PC(허브)** 를 거쳐 → **본인 세션이 떠 있는 노드 PC의 도커 컨테이너 바탕화면(`받은파일` 폴더)** 에 파일이 도착하는 기능. 코드 작성·통합은 끝났고, **실제 중앙 PC→노드 끝단 테스트만 남음.**

## 1. 시스템 구조 (배경)

```
[브라우저] ──HTTPS(또는 로컬 http)──> [Vercel Next.js frontend]
                                         │ /api/* (BFF 프록시, x-api-key 부착)
                                         ▼
                            [허브 hub/main.py, FastAPI :8001]  ← 중앙 PC 10.72.117.22
                                         │ SSH/SFTP (내부망 직통)
                                         ▼
                            [노드 PC 10.72.117.23] docker 컨테이너(Kasm 데스크톱)
```
- 허브는 Firebase Firestore(`nodes`/`sessions`/`users`)로 상태 관리.
- **중요(최근 변경 9b7f7d9):** 노드 접속이 Tailscale → **내부망 직통 SSH**로 바뀜.
  - Firestore `nodes` 필드: `ip`(구 `tailscale_ip`), 노드별 `ssh_user`(기본 `ai-admin`).
  - `_ssh(host, command, ssh_user=SSH_USER)` 시그니처.

## 2. 이번에 추가/수정한 것 (이미 완료, 브랜치에 커밋됨)

브랜치: **`feature/file-transfer`** (로컬 HEAD `745f0b0` = 팀원 main 머지 + 본 기능).
※ 원격 `origin/feature/file-transfer`는 **머지 전(c72fe6f)** 상태 — **push로 갱신 필요**.

| 파일 | 내용 |
|---|---|
| `hub/main.py` | `/upload` 라우트, docker run에 `-v` bind-mount, docker cp 폴백, 헬퍼들. **전부 `node["ip"]` + 노드별 `ssh_user` 사용.** |
| `hub/requirements.txt` | `python-multipart==0.0.9` 추가 (multipart 파싱 필수) |
| `frontend/app/api/upload-ticket/route.ts` | (신규) HMAC 업로드 토큰 발급 + `HUB_LAN_URL` 반환 |
| `frontend/components/upload.tsx` | (신규) 업로드 버튼. 티켓 받아 `HUB_LAN_URL/upload`로 **브라우저→허브 직행** |
| `frontend/components/guide.tsx` | (신규) 사용자 가이드 (부가기능) |
| `frontend/app/dashboard/page.tsx` | ReadyState에 `<UploadButton/>`, 가이드, 팀원 사용량게이지 공존 |
| `frontend/.env.local.example` | `HUB_LAN_URL`, `UPLOAD_SECRET` 항목 추가 |
| `local-test/RUNBOOK.md`, `verify_token.py` | 로컬 테스트 런북 + 토큰 호환성 단위테스트 |

### 동작 흐름 (업로드)
1. 브라우저가 `GET /api/upload-ticket` → 로그인 확인 후 토큰 발급.
   - 토큰 = `base64url("<email>|<exp>")` + "." + `HMAC-SHA256(UPLOAD_SECRET, payload_b64)`(hex). TTL 5분.
   - `UPLOAD_SECRET` 미설정 시 `API_KEY` 재사용. 응답에 `upload_url`(=`HUB_LAN_URL`) 포함.
2. 브라우저가 `POST {HUB_LAN_URL}/upload` (multipart `files`, 헤더 `x-upload-token`). **Vercel 우회 → 용량 제한 없음.**
3. 허브: 토큰 검증 → `email`로 본인 세션 노드 조회 → 그 노드(`node["ip"]`, `node["ssh_user"]`)로 SFTP.
   - 노드 호스트 경로: `/home/<ssh_user>/dshs-shared/<sanitized_email>/` (없으면 `mkdir`+`chmod 777`).
   - 컨테이너에 마운트 있으면 자동 노출, 없으면 `docker cp`로 즉시 반영.
4. 컨테이너 안 경로: `DESKTOP_SHARE = /home/kasm-user/Desktop/받은파일`.

### 검증 완료 (이미 함)
- 토큰 발급(Node)↔검증(Python) **교차검증 통과**: 정상/만료/변조 모두 (`python local-test/verify_token.py`).
- 허브 `python -c "import ast; ast.parse(...)"` 문법 OK.
- 프론트 `npx tsc --noEmit` 에러 0.
- 충돌 마커 0, 옛 `tailscale_ip` 참조 0.

## 3. 최초 작성 당시 TODO 기록 — 현재 상태는 최상단 최신 절을 따를 것

### 과거 TODO-1. 브랜치 push — 현재는 실행 금지, 사용자에게 다시 승인받을 것
```bash
git push origin feature/file-transfer   # 인증: GitHub PAT 필요
```
- 현재 origin 브랜치는 머지 전이라, 머지 결과(745f0b0)를 올려야 함.
- ⚠️ 이전 세션에서 PAT가 채팅에 노출돼 **폐기 권고**함. 새 PAT 발급해 사용.

### 과거 TODO-2. 중앙 PC(허브)에 이 코드 반영 — 실제 운영 경로에 완료됨
중앙 PC(10.72.117.22)의 허브를 이 브랜치 코드로 교체:
```bash
# 중앙 PC에서 — ~/hub 가 git clone 이면:
cd ~/hub && git fetch && git checkout feature/file-transfer && git pull
# git 아니면 hub/main.py, requirements.txt 수동 복사
pip install -r requirements.txt        # python-multipart 설치
bash ~/hub/start.sh                     # uvicorn :8001 재시작 (~/.hub.env 의 SSH_PASSWORD 필요)
```
- **확인 필요:** `~/hub`가 git 체크아웃인지(팀원 확인). Firebase 키(`hub/serviceAccountKey.json`)·`~/.hub.env`는 운영 중이라 이미 있을 것.
- `UPLOAD_SECRET`은 frontend와 동일해야 함(미설정 시 양쪽 `API_KEY` 일치하면 됨).

### 과거 TODO-3. 노트북 frontend 로컬 설정 — 테스트 시 완료됨
`frontend/.env.local` (로컬은 http라 mixed-content 문제 없음):
```
BACKEND_URL=http://10.72.117.22:8001     # /api/* → 허브
HUB_LAN_URL=http://10.72.117.22:8001     # 브라우저 → 허브 직행 (같은 학교 WiFi 전제)
API_KEY=<중앙 허브 API_KEY와 동일한 값>    # 실제 값은 문서나 Git에 기록하지 않음
UPLOAD_SECRET=                            # 비우면 API_KEY 재사용
AUTH_SECRET=<아무 32자+>
ALLOWED_DOMAIN=ts.hs.kr
```
```bash
cd frontend && npm run dev               # http://localhost:3000
```
- 로그인: 레포에 **개발용 우회**(`/api/auth/google`) 있어 구글 OAuth 없이 `dev@ts.hs.kr`로 로그인됨(`DEV_LOGIN_EMAIL`로 변경 가능). 구글 키 불필요.

### 과거 TODO-4. 끝단 테스트 — 성공 완료, 증거는 최상단 참조
1. 로컬 대시보드 로그인 → "새 세션 시작" → 노드 선택.
   - 허브가 노드에 `docker run ... -v /home/<ssh_user>/dshs-shared/<email>:/home/kasm-user/Desktop/받은파일 ...` 으로 컨테이너 생성.
2. ready 되면 **📤 내 PC로 파일 보내기** 클릭 → 파일 선택 → 업로드.
3. **판정:** 중앙 PC에서
   ```bash
   ssh <ssh_user>@10.72.117.23 "docker exec active_session ls -la '/home/kasm-user/Desktop/받은파일'"
   ```
   업로드한 파일이 보이면 **성공.** 또는 가상 데스크톱(kasm) 접속해 바탕화면 `받은파일` 확인.

## 4. 주의/리스크 (Codex가 막히면 볼 것)
- **로컬 단독 테스트 불가:** 이 개발 노트북엔 Docker 미설치(WSL Ubuntu만 있음). 끝단은 실제 노드(10.72.117.23, Docker 보유)에서.
- **`--gpus all`:** 노드에 NVIDIA 컨테이너 툴킷 없으면 `docker run` 실패. 노드가 GPU 머신이면 OK. 아니면 `hub/main.py`의 create_session에서 임시 제거.
- **실서비스(Vercel HTTPS) 배포 시:** 브라우저(https) → 허브(http)는 **mixed-content 차단**. 운영에선 `HUB_LAN_URL`을 **유효 인증서 HTTPS**(예: `hub.dshs-app.net` → 중앙PC LAN IP, Let's Encrypt)로 해야 함. 로컬 http 테스트엔 무관.
- **bind-mount는 신규 컨테이너에만 적용.** 이미 떠 있던 컨테이너는 `docker cp` 폴백으로 처리(코드에 있음).
- `chown -R 1000:1000`은 kasm-user uid=1000 가정(Kasm 표준). 다르면 조정.
- `DESKTOP_SHARE` 한글 폴더명(`받은파일`)은 Linux에서 문제 없음. 단 이미지에 `/home/kasm-user/Desktop`가 있어야 함.

## 5. 핵심 좌표
- 브랜치: `feature/file-transfer` (HEAD `745f0b0`), base `main`(`9b7f7d9`). **`main` 직접 push 금지** — PR로 머지.
- 중앙 PC(허브): Tailscale SSH로 접속하며, 실제 운영 경로는 `/home/admin-swai/backend`, uvicorn은 `:8000`, 공개 주소는 `https://api.dshs-app.net`. 비밀은 문서에 기록하지 않음.
- 노드: `10.72.117.23`, Firestore의 실제 ssh_user는 `admin-swai`, 컨테이너 `active_session`, 이미지 `dshs-kasm-win10`.
- PR 생성: https://github.com/dshs-server/dshs-server/pull/new/feature/file-transfer (push 후)
