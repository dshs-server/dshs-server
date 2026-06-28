# 로컬 파일 전송 e2e 테스트 런북

3계층(프론트 → 허브 → 노드+도커)을 한 PC에서 재현해 "업로드 → 컨테이너 바탕화면에 파일 도착"까지 확인한다.

## 0. 팀 구글 계정에서 가져올 것 — 사실상 1개

| 항목 | 어디서 | 어디에 둠 |
|---|---|---|
| **Firebase 서비스 계정 키(JSON)** | Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성 | `hub/serviceAccountKey.json` (`hub/main.py:37` 가 읽음) |

이게 허브가 Firestore(nodes/sessions)에 접근하는 유일한 필수 구글 자격증명이다.
**로그인은 구글 OAuth 불필요** — 레포에 이미 개발용 우회(`/api/auth/google`)가 있어 `dev@ts.hs.kr` 로 바로 로그인된다.

> 진짜 OAuth 흐름까지 테스트하려면(선택): GCP 콘솔에서 `GOOGLE_CLIENT_ID/SECRET` + 리디렉트 `http://localhost:3000/api/auth/callback` 등록, Firebase 웹앱 config로 `NEXT_PUBLIC_FIREBASE_*` 채움. 파일 테스트엔 불필요.

## 1. 프론트엔드 env — `frontend/.env.local`

```
BACKEND_URL=http://localhost:8001
HUB_LAN_URL=http://localhost:8001        # 로컬은 http라 mixed-content 차단 없음
API_KEY=local-test-key                   # 허브와 동일하게
UPLOAD_SECRET=                           # 비움 → API_KEY 재사용
AUTH_SECRET=local-dev-secret-32chars-minimum-xxxxx
DEV_LOGIN_EMAIL=ts250024@ts.hs.kr        # 관리자로 로그인하려면(선택)
ALLOWED_DOMAIN=ts.hs.kr
```

실행: `cd frontend && npm run dev` → http://localhost:3000 → "로그인" 클릭(개발 우회) → 대시보드.

## 2. 허브 env + 실행

`~/.hub.env`:
```
SSH_PASSWORD=<이 PC(노드)로 SSH 들어갈 비밀번호>
```
실행:
```
export API_KEY=local-test-key
export FIREBASE_CRED=$PWD/hub/serviceAccountKey.json
export DESKTOP_SHARE=/home/kasm-user/Desktop/받은파일   # 플레인 이미지면 /root/받은파일 등으로
cd hub && uvicorn main:app --host 0.0.0.0 --port 8001
```
> `python-multipart` 필요(레포 requirements에 추가됨): `pip install -r hub/requirements.txt`

## 3. 노드 = 이 PC. SSH + Docker

- **SSH 서버**가 떠 있어야 함(허브가 SSH/SFTP로 접속). WSL/리눅스면 `sudo service ssh start`.
- Firestore `nodes` 컬렉션에 문서 1개 추가:
  ```
  id: local-1
  name: "로컬테스트"
  tailscale_ip: "127.0.0.1"     # 허브가 SSH 갈 주소(=이 PC)
  ssh_user: "<SSH 계정명>"
  gpu_type: "dedicated"
  cpu_cores: 4   ram_gb: 16   storage_gb: 100
  kasm_url: "http://localhost:8080"
  ```
- **GPU 플래그 주의**: `hub/main.py` 의 `docker run ... --gpus all` 은 NVIDIA 컨테이너 툴킷 없으면 실패 → 로컬 테스트 시 그 플래그를 임시 제거.
- 이미지: 진짜 화면 확인은 `dshs-kasm-win10`, 메커니즘만 확인은 아무 이미지(`ubuntu`)로도 OK.

## 4. 시나리오

1. 대시보드에서 새 세션 시작 → 노드(이 PC)에 컨테이너가 `-v .../받은파일` 마운트로 뜸.
2. ReadyState의 **📤 내 PC로 파일 보내기** 클릭 → 파일 선택.
3. 흐름: `/api/upload-ticket`(토큰) → `http://localhost:8001/upload` → 허브가 127.0.0.1로 SFTP → `~/dshs-shared/<email>/` → 마운트로 컨테이너 안에 표시.
4. 검증: `docker exec active_session ls -la "/home/kasm-user/Desktop/받은파일"` 에 업로드 파일이 보이면 성공.

## 5. 토큰 호환성 단위 테스트 (인프라 불필요)

```
python local-test/verify_token.py
```
프론트(발급)·허브(검증)의 HMAC/base64url 로직 일치를 오프라인으로 검증. 외부 토큰 검증은 `python local-test/verify_token.py <token>`.
