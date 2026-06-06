# 학교 전산실 컴퓨팅 자원 대여 시스템 — 통합 설계 및 진행 기록

> 설계 문서 + 노드 세팅 완료 기록 + Cloudflare Tunnel 테스트 진행 기록을 통합한 최종 문서입니다.
> 마지막 업데이트: 2026-06-06 (§17 §18 §19 §20 §21 §22 §23 추가)

---

## 목차

1. [시스템 개요](#1-시스템-개요)
2. [전체 아키텍처](#2-전체-아키텍처)
3. [네트워크 설계 (Cloudflare Tunnel)](#3-네트워크-설계-cloudflare-tunnel)
4. [섹션(Session) 개념 및 생명주기](#4-섹션session-개념-및-생명주기)
5. [사용자(학생) 접속 경험 (UX)](#5-사용자학생-접속-경험-ux)
6. [웹사이트 서버 구성](#6-웹사이트-서버-구성)
7. [백엔드 로직 상세 설계](#7-백엔드-로직-상세-설계)
8. [보안 설계](#8-보안-설계)
9. [노드 PC 초기 세팅 (Phase 1~5)](#9-노드-pc-초기-세팅-phase-15)
10. [Docker 컨테이너 명령어 레퍼런스](#10-docker-컨테이너-명령어-레퍼런스)
11. [백엔드-노드 SSH 통신 설정](#11-백엔드-노드-ssh-통신-설정)
12. [초기 세팅 원격 작업 방법 (Tailscale)](#12-초기-세팅-원격-작업-방법-tailscale)
13. [Cloudflare Tunnel 세팅 가이드](#13-cloudflare-tunnel-세팅-가이드)
14. [Tech Stack 정리](#14-tech-stack-정리)
15. [진행 현황 (노드 세팅 완료 기록)](#15-진행-현황-노드-세팅-완료-기록)
16. [미결 사항 및 체크리스트](#16-미결-사항-및-체크리스트)
17. [트러블슈팅 기록 (2026-06-06)](#17-트러블슈팅-기록-2026-06-06)
18. [노드 데스크톱 환경 확정 기록 (2026-06-06)](#18-노드-데스크톱-환경-확정-기록-2026-06-06)
19. [kasmweb 이미지 테스트 및 Chrome 401 해결 (2026-06-06)](#19-kasmweb-이미지-테스트-및-chrome-401-해결-2026-06-06)
20. [내부망 직접 접속으로 전환 (2026-06-06)](#20-내부망-직접-접속으로-전환-2026-06-06)
21. [Cloudflare Quick Tunnel 운영 방식 확정 (2026-06-06)](#21-cloudflare-quick-tunnel-운영-방식-확정-2026-06-06)
22. [FastAPI 백엔드 구현 완료 (2026-06-06)](#22-fastapi-백엔드-구현-완료-2026-06-06)
23. [Next.js 프론트엔드 구현 및 Vercel 배포 준비 (2026-06-06)](#23-nextjs-프론트엔드-구현-및-vercel-배포-준비-2026-06-06)

---

## 1. 시스템 개요

학교 전산실 워크스테이션 15대를 클라우드 컴퓨팅 서비스(GCP, AWS)처럼 학생들에게 대여해주는 시스템이다.

### 핵심 목표
- 학생이 **브라우저만으로** 우분투 GUI 데스크톱 환경에 접속 가능
- 특정 학생이 컴퓨터를 독점하지 않고 **섹션(Session) 단위로 공유**
- 임대 종료 후 같은 컴퓨터를 다른 학생이 새 섹션으로 사용 가능
- 학생 간 데이터 완전 격리 (서로 볼 수 없음)
- 학교 방화벽 문제를 우회하여 외부(집)에서도 접속 가능

### 기술적 배경
- 도커(Docker) 기술로 OS와 프로그램이 세팅된 컨테이너를 즉시 생성/삭제
- Cloudflare Tunnel로 학교 방화벽을 우회 (포트포워딩, VPN 불필요)
- `nvidia-glx-desktop` 이미지로 브라우저 안에 GNOME Ubuntu 바탕화면 스트리밍 (WebRTC, GPU 완전 가속)

---

## 2. 전체 아키텍처

```
[학생 브라우저]
      |
      | (1) 대여 신청
      v
[Vercel — 프론트엔드]
      |
      | (2) API 요청
      v
[Cloudflare Tunnel] ──────────────────────────────────────────────────────┐
      |                                                                    |
      v                                                                    |
[메인 서버 (node01)] — FastAPI 백엔드                                     |
      |  - DB 관리 (Users / Nodes / Instances)                            |
      |  - 자원 탐색 및 섹션 할당                                          |
      |  - Cloudflare API로 터널 동적 생성                                 |
      |  - SSH로 노드에 Docker 명령 전송                                   |
      |                                                                    |
      | (3) SSH 내부망 통신 (192.168.x.x)                                 |
      v                                                                    |
[node02 ~ node15] — Docker 호스트                                         |
      |  - 컨테이너 실행/삭제                                              |
      |  - /data/students/{student_id} 볼륨 마운트                        |
      |                                                                    |
      | (4) Cloudflare Tunnel (섹션별 동적 생성)                          |
      v                                                                    |
[session-a1b2c3.school.com] ──────────────────────────────────────────────┘
      |
      | (5) 학생이 URL 클릭
      v
[학생 브라우저 — GNOME Ubuntu 바탕화면 렌더링 (Selkies / WebRTC)]
```

### 서버 역할 분리 요약

| 역할 | 플랫폼 | 비고 |
|------|--------|------|
| 프론트엔드 (대여 신청 UI) | Vercel | 구글 로그인 포함 |
| 백엔드 API + DB | node01 (메인 서버) | FastAPI, Cloudflare Tunnel 연결 |
| Docker 호스트 (컨테이너 실행) | node02 ~ node15 (14대) | Cloudflare Tunnel 각각 설치 |

---

## 3. 네트워크 설계 (Cloudflare Tunnel)

### 기존 방식의 문제
- 학교 전산망은 보안이 강력해 외부(집)에서 학교 내부 PC로 직접 접속(포트 포워딩)을 원천 차단
- Inbound 트래픽 = 학생이 집에서 학교 PC로 들어오려 함 → 방화벽이 차단

### Cloudflare Tunnel 방식
- 학교 PC가 **스스로 Cloudflare(글로벌 통신사)로 나가는 터널을 뚫어둠 (Outbound)**
- 학생은 집에서 Cloudflare가 제공한 도메인(예: `session-a1b2c3.school.com`)으로 접속
- 터널을 타고 학교 PC로 연결됨
- VPN 설치 불필요, 웹 브라우저만으로 접속 가능

### Tunnel 적용 범위
- **메인 서버(node01)**: Vercel 프론트 → 백엔드 API 통신용 터널 1개 (고정)
- **node02 ~ node15**: 섹션별로 동적 터널 생성/삭제

### 동적 터널 생성 방식 (Cloudflare API)

섹션 생성 시:
```http
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/tunnels
```

섹션 종료 시:
```http
DELETE https://api.cloudflare.com/client/v4/accounts/{account_id}/tunnels/{tunnel_id}
```

FastAPI 백엔드가 섹션 생성/종료 시 자동으로 Cloudflare API를 호출하여 터널을 만들고 삭제한다.

각 노드에 cloudflared 프로세스를 실행해야 하므로, 메인 서버가 SSH로 다음 명령을 전송:
```bash
ssh admin@node03 "cloudflared tunnel run session-a1b2c3 &"
```

### URL 구조
```
session-{uuid}.school.com   # 섹션별 고유 URL
api.school.com              # 메인 서버 백엔드 API
```

---

## 4. 섹션(Session) 개념 및 생명주기

### 섹션이란?
**섹션 = 학생 + 노드 + 시간**의 조합 단위

- 학생이 컴퓨터를 독점하는 것이 아니라, **임대 시간 동안만 해당 노드에 대한 접근권**을 가짐
- 임대 종료 후 같은 노드를 다른 학생이 새 섹션으로 사용 가능
- 섹션 간 데이터 격리: Docker 컨테이너 + 섹션별 고유 터널 URL로 보장

### 섹션 생명주기

```
[섹션 생성]
    학생 대여 신청
        → 빈 노드 탐색
        → 컨테이너 생성 (docker run)
        → Cloudflare API로 터널 생성
        → 섹션 URL 발급 (session-a1b2c3.school.com)
        → 학생에게 URL 전달

[섹션 사용 중]
    학생이 URL 클릭
        → 브라우저 안에 GNOME Ubuntu 바탕화면 렌더링
        → GPU 100% 성능으로 작동
        → /data/students/{student_id} 폴더에 작업 내용 저장

[섹션 종료 (자동)]
    임대 시간 만료
        → 스케줄러가 만료 감지
        → 컨테이너 삭제 (docker rm -f)
        → Cloudflare 터널 삭제
        → DB에서 노드 상태를 idle로 변경
        → /data/students/{student_id} 폴더 데이터는 보존
```

### 데이터 보존 정책
- 컨테이너는 삭제되지만 `/data/students/{student_id}` 폴더의 데이터는 남음
- 학생이 다음 섹션 생성 시 이전 작업 파일 등이 그대로 유지됨
- 단, 새 섹션은 같은 노드가 아닐 수 있음 (빈 노드 할당 방식)
- **주의:** `nvidia-glx-desktop` 이미지는 볼륨 마운트 경로가 `/home/user`이므로, 컨테이너 내부에 설치한 apt 패키지는 컨테이너 삭제 시 사라짐. 학생 작업 파일(홈 디렉토리)만 보존됨.

### 섹션 간 격리 예시
```
학생 A → session-a1b2c3.school.com → node03 컨테이너 A (임대 종료 후 삭제)
학생 B → session-x9y8z7.school.com → node03 컨테이너 B (새로 생성)

→ A의 터널 URL은 이미 삭제됨
→ B는 A의 데이터/화면에 접근 불가
```

---

## 5. 사용자(학생) 접속 경험 (UX)

학생은 복잡한 컴퓨터 지식이 전혀 없어도 됨. SSH 클라이언트 설치 불필요.

### 접속 시나리오 (집에서 MATLAB 사용)

1. **웹사이트 접속**
   - 크롬 브라우저에서 대여 시스템 웹사이트 접속 (예: `portal.school.com`)
   - 구글 로그인

2. **대여 신청**
   - [GUI 데스크톱 환경 (RTX 3080) 대여하기] 버튼 클릭
   - 사용 시간 선택 (예: 3시간)

3. **발급 대기 (약 3~5초)**
   - "컨테이너를 생성 중입니다..." 로딩 화면

4. **발급 완료**
   - 화면에 접속 URL 표시: `https://session-a1b2c3.school.com`
   - 비밀번호 함께 표시 (랜덤 자동 발급)

5. **웹 브라우저로 원격 접속 (핵심)**
   - URL 클릭 시 **크롬 브라우저 탭 안에 GNOME Ubuntu 바탕화면**이 나타남
   - 터미널을 열고 패키지 설치 등 마음껏 사용
   - 화면 스트리밍 방식이므로 **학생 컴퓨터 성능은 무관**
   - 모든 연산은 학교 RTX 3080이 처리

6. **종료**
   - 임대 시간 종료 시 브라우저 화면이 닫히며 컨테이너 자동 파기
   - `/data/students/{student_id}` 폴더에 데이터는 보존됨

### 화면 스트리밍 기술
- `ghcr.io/selkies-project/nvidia-glx-desktop:latest` 이미지 사용 (채택 확정)
- 내부적으로 **Selkies** 엔진으로 **WebRTC** 스트리밍 → 부드러운 화면
- GNOME 데스크톱 환경 → Ubuntu 기본 UI와 동일
- GPU OpenGL/Vulkan 완전 가속 지원
- 별도 클라이언트 설치 없이 브라우저만으로 완전한 데스크톱 환경 제공

---

## 6. 웹사이트 서버 구성

### 프론트엔드 — Vercel

- 대여 신청 UI
- 구글 로그인 (Google OAuth)
- 섹션 상태 조회, URL 표시
- Vercel은 서버리스(Serverless)이므로 SSH 명령을 직접 날릴 수 없음
  → 메인 서버 FastAPI로 API 요청만 보내는 역할
- **참고:** Vercel 도메인(`xxx.vercel.app`)은 Cloudflare Tunnel용 도메인으로 사용 불가. 별도 도메인 필요.

### 백엔드 — 메인 서버 (node01)

- FastAPI로 REST API 제공
- Cloudflare Tunnel을 통해 외부(Vercel)에서 접근 가능
- 내부망(192.168.x.x)으로 node02~15에 SSH 명령 전송
- Cloudflare API 호출로 터널 동적 생성/삭제
- DB 관리 (SQLite 또는 MySQL)
- 스케줄러(Cron / Celery)로 만료된 섹션 자동 회수

### 통신 흐름 상세
```
학생 브라우저
  → Vercel 프론트 (대여 신청 버튼 클릭)
  → api.school.com (Cloudflare Tunnel)
  → 메인 서버 FastAPI
      → DB 조회 (빈 노드 탐색)
      → SSH → node03 "docker run ..."
      → Cloudflare API → 터널 생성 (session-a1b2c3.school.com)
      → DB 업데이트 (node03 상태: busy, 만료 시간 기록)
  → Vercel 프론트로 URL 반환
  → 학생 화면에 접속 URL + 비밀번호 표시
```

---

## 7. 백엔드 로직 상세 설계

### DB 스키마

**Users 테이블** — 학생 정보
```
id, google_id, name, email, remaining_hours
```

**Nodes 테이블** — 노드 PC 상태
```
node_id, ip (192.168.1.101~115), status (idle/busy), hostname (node01~15)
```

**Instances 테이블** — 현재 실행 중인 섹션 정보
```
instance_id, student_id, node_id, container_name, tunnel_id, tunnel_url,
session_password, port, created_at, expires_at
```

### 섹션 생성 API Flow

1. **[요청 수신]** 학생이 웹에서 'GUI 데스크톱 생성' API 호출
2. **[자원 탐색]** DB에서 `status = idle`인 노드 탐색 (예: node03 당첨)
3. **[포트 할당]** 사용 가능한 랜덤 포트 선택 (예: `8083`)
4. **[비밀번호 생성]** 랜덤 비밀번호 자동 생성 (예: `x7k2m9`)
5. **[Docker 실행]** 메인 서버 → node03으로 SSH 명령 전송:
   ```bash
   ssh admin@192.168.1.103 \
     "docker run -d \
       --name session_a1b2c3_gui \
       --gpus all \
       --runtime nvidia \
       --shm-size='2gb' \
       -p 8083:8080 \
       -e TZ=Asia/Seoul \
       -e PASSWD=x7k2m9 \
       -e SIZEW=1920 \
       -e SIZEH=1080 \
       -v /data/students/student_A:/home/user \
       ghcr.io/selkies-project/nvidia-glx-desktop:latest"
   ```
6. **[터널 생성]** Cloudflare API 호출 → `session-a1b2c3.school.com` 생성
   - node03의 `192.168.1.103:8083`으로 라우팅되도록 설정
7. **[DB 업데이트]**
   - Nodes: node03 상태 → `busy`
   - Instances: 섹션 정보 + 만료 시간 기록
8. **[학생에게 반환]** 접속 URL + 비밀번호 전달

### 자동 회수 로직 (스케줄러)

백엔드에 Cron 또는 Celery 백그라운드 작업자:
```
1분마다 DB 확인
    만료 시간이 지난 Instances 탐색
        → SSH로 컨테이너 삭제:
          ssh admin@192.168.1.103 "docker rm -f session_a1b2c3_gui"
        → Cloudflare API로 터널 삭제
        → Nodes DB: node03 상태 → idle
        → Instances DB: 레코드 삭제
```

### Nginx / Caddy 역할

메인 서버(node01)에서 Caddy 웹 서버를 사용하는 것을 권장:
- Nginx보다 설정이 간단함
- API를 통해 백엔드에서 파이썬 코드로 라우팅 링크 실시간 생성 가능

---

## 8. 보안 설계

### 인증 레이어 (3단계)

**레이어 1 — 웹사이트 레벨 (Vercel 프론트)**
- 구글 로그인 필수
- 로그인하지 않으면 대여 신청 자체가 불가

**레이어 2 — 컨테이너 레벨 (자동 비밀번호)**
- 섹션 생성 시 랜덤 비밀번호 자동 발급 후 컨테이너에 주입:
  ```bash
  docker run -e PASSWD=<random> ...
  ```
  - `nvidia-glx-desktop` 이미지의 비밀번호 env 변수명은 `PASSWD` (webtop의 `PASSWORD`와 다름)
- 학생에게 URL + 비밀번호를 함께 전달
- URL을 알아도 비밀번호 없이는 접속 불가

**레이어 3 — Cloudflare Access (선택, 무료 플랜 가능)**
- 터널 레벨에서 구글 로그인 강제
- 허용된 이메일 도메인(예: `@school.ac.kr`)만 접근 가능:
  ```
  접속 시도 → Cloudflare Access → 구글 로그인 확인 → 통과 시 컨테이너 연결
  ```

### 보안 주의사항

- `/data/students`의 기본 권한 `chmod 777`은 위험할 수 있음
  - 컨테이너 탈출 시 다른 학생 데이터 접근 가능
  - 실제 운영 시 권한 정책 재검토 필요
- 학생이 컨테이너 안에서 외부 공격 트래픽을 발생시킬 가능성 → 네트워크 정책 고려
- 섹션 URL은 짧은 임대 시간 + 비밀번호 조합으로 충분한 보안 확보

---

## 9. 노드 PC 초기 세팅 (Phase 1~5)

> **1대 완벽 세팅 후 나머지 14대에 동일하게 적용. 또는 쉘 스크립트로 자동화.**

### Phase 1. OS 정리 및 기본 네트워크 설정

#### 방법 1. 기존 우분투 초기화 (강력 추천)

불필요한 기존 사용자 계정 삭제:
```bash
# 예시: 기존 student1 계정과 그 데이터 영구 삭제 (-r 옵션 필수)
sudo userdel -r student1
```

찌꺼기 프로그램 및 캐시 정리:
```bash
# 불필요한 패키지 완전 삭제
sudo apt-get autoremove --purge -y

# 다운로드 설치 파일 캐시 삭제
sudo apt-get clean

# 오래된 시스템 로그 삭제 (최근 2일치만 남김)
sudo journalctl --vacuum-time=2d
```

학생 저장 공간 초기화:
```bash
sudo rm -rf /data/students/*
```

#### 방법 2. 보조 디스크(D드라이브)가 있는 경우

```bash
# 디스크 목록 확인
lsblk

# 보조 디스크 포맷 (예: /dev/sdb — 데이터 완전 삭제 주의!)
sudo mkfs.ext4 /dev/sdb

# 학생용 저장 폴더로 마운트
sudo mount /dev/sdb /data/students
```

#### 기본 설정

- **컴퓨터 이름(Hostname)**: `node01`, `node02` ... `node15`로 지정
- **관리자 계정 생성**: 웹 서버가 SSH로 접속할 계정 (예: `admin` / 복잡한 비밀번호)
  - 학생에게 절대 노출 금지
- **패키지 업데이트 및 SSH 서버 설치**:
  ```bash
  sudo apt update && sudo apt upgrade -y
  sudo apt install openssh-server -y
  sudo systemctl enable ssh
  sudo systemctl start ssh
  ```
- **고정 IP 할당**: 공유기 DHCP 설정에서 MAC 주소로 고정 할당
  - 예: `192.168.1.101` ~ `192.168.1.115`

### Phase 2. NVIDIA GPU 드라이버 설치

```bash
# 설치 가능한 드라이버 확인
ubuntu-drivers devices

# 권장 드라이버 자동 설치
sudo ubuntu-drivers autoinstall

# 재부팅 (필수)
sudo reboot
```

재부팅 후 확인:
```bash
nvidia-smi
# RTX 3080 정보와 표가 출력되면 성공
```

### Phase 3. Docker 및 NVIDIA Container Toolkit 설치

#### Docker Engine 설치
```bash
# 도커 설치
sudo apt install -y docker.io docker-compose

# 부팅 시 자동 실행
sudo systemctl enable docker
sudo systemctl start docker

# 관리자 계정이 sudo 없이 docker 명령어 사용 가능하도록 권한 부여
sudo usermod -aG docker $USER
# (적용을 위해 재부팅 진행)
sudo reboot
```

#### NVIDIA Container Toolkit 설치 (도커에서 GPU 사용)
```bash
# NVIDIA 툴킷 저장소 추가
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# 패키지 업데이트 및 설치
sudo apt update
sudo apt install -y nvidia-container-toolkit

# 도커에 NVIDIA 런타임 적용
sudo nvidia-ctk runtime configure --runtime=docker

# 도커 재시작
sudo systemctl restart docker
```

GPU 연동 확인:
```bash
docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi
# 컨테이너 안에서 RTX 3080 정상 인식 확인
```

### Phase 4. 학생 데이터 저장소(볼륨) 폴더 생성

```bash
# 학생 데이터 저장 폴더 생성
sudo mkdir -p /data/students

# 도커가 읽고 쓸 수 있도록 권한 부여
sudo chmod -R 777 /data/students
# (운영 시 보안 정책에 따라 권한 재검토 필요)
```

### Phase 5. 테스트 — Docker 명령어 직접 실행

```bash
# GUI 데스크톱 컨테이너 실행 테스트
docker run -d \
  --name test_gui \
  --gpus all \
  --runtime nvidia \
  --shm-size="2gb" \
  -p 8080:8080 \
  -e TZ=Asia/Seoul \
  -e PASSWD=test1234 \
  -e SIZEW=1920 \
  -e SIZEH=1080 \
  -v /data/students/test_student:/home/user \
  ghcr.io/selkies-project/nvidia-glx-desktop:latest

# 브라우저에서 http://<노드IP>:8080 접속하여 Ubuntu GNOME 바탕화면 확인
# 비밀번호: test1234

# 테스트 컨테이너 삭제
docker rm -f test_gui
```

---

## 10. Docker 컨테이너 명령어 레퍼런스

### GUI 데스크톱 컨테이너 (채택된 방식)

이미지: `ghcr.io/selkies-project/nvidia-glx-desktop:latest`

```bash
docker run -d \
  --name {session_id}_gui \
  --gpus all \
  --runtime nvidia \
  --shm-size="2gb" \
  -p {assigned_port}:8080 \
  -e TZ=Asia/Seoul \
  -e PASSWD={random_password} \
  -e SIZEW=1920 \
  -e SIZEH=1080 \
  -v /data/students/{student_id}:/home/user \
  ghcr.io/selkies-project/nvidia-glx-desktop:latest
```

#### webtop vs nvidia-glx-desktop 비교

| 항목 | webtop:ubuntu-xfce | nvidia-glx-desktop |
|------|--------------------|--------------------|
| 데스크톱 | XFCE | GNOME (Ubuntu 기본) |
| GPU 가속 | 컨테이너 전달만 | OpenGL/Vulkan 완전 가속 |
| 스트리밍 방식 | KasmVNC / noVNC | WebRTC (Selkies) |
| 화면 부드러움 | 보통 | 훨씬 부드러움 |
| 이미지 크기 | 작음 | 큼 (첫 pull 오래 걸림) |
| 비밀번호 env | `PASSWORD` | `PASSWD` |
| 내부 포트 | 3000/3001 | 8080 |
| 볼륨 경로 | `/config` | `/home/user` |

→ **nvidia-glx-desktop 채택 확정.** Ubuntu 기본 GNOME UI, WebRTC 스트리밍, GPU 완전 가속.

### (참고) 초기 테스트에 사용했던 webtop 명령어 — 미사용

```bash
docker run -d \
  --name test_gui \
  --gpus all \
  --shm-size="2gb" \
  -p 3001:3001 \
  -e TZ=Asia/Seoul \
  -v /data/students/test_user:/config \
  lscr.io/linuxserver/webtop:ubuntu-xfce
```

### (참고) 터미널 전용 컨테이너 — 미사용

이미지: `linuxserver/openssh-server`

```bash
docker run -d \
  --name {session_id}_term \
  -p 2222:2222 \
  -e USER_NAME=student \
  -e USER_PASSWORD={random_password} \
  -v /data/students/{student_id}:/config \
  linuxserver/openssh-server
```

→ 현재 설계에서는 채택하지 않음. GUI 방식만 사용.

### 컨테이너 관리 명령어

```bash
# 상태 확인
docker ps

# GPU 확인
docker exec test_gui nvidia-smi

# 로그 확인 (첫 실행 시 pull 진행 상황 확인)
docker logs -f test_gui

# 컨테이너 중지 및 삭제 (섹션 회수)
docker rm -f {session_id}_gui
```

---

## 11. 백엔드-노드 SSH 통신 설정

### SSH Key 기반 인증 설정 (비밀번호 입력 없이 자동화)

1. 메인 서버(node01)에서 SSH 키 생성:
   ```bash
   ssh-keygen -t ed25519 -C "main-server"
   ```

2. 각 노드에 공개 키 배포:
   ```bash
   ssh-copy-id admin@node02
   ssh-copy-id admin@node03
   # ... node15까지 반복
   # 또는 스크립트로 자동화:
   for i in $(seq 2 15); do
     ssh-copy-id admin@192.168.1.10$i
   done
   ```

3. 이후 백엔드 코드에서 비밀번호 없이 즉각 명령 실행 가능:
   ```python
   import subprocess
   subprocess.run([
     "ssh", "admin@192.168.1.103",
     "docker run -d --name session_gui ..."
   ])
   # 또는 paramiko / Fabric 라이브러리 사용
   ```

### Python Paramiko 예시
```python
import paramiko

def run_docker_on_node(node_ip: str, docker_command: str):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(node_ip, username="admin", key_filename="/home/admin/.ssh/id_ed25519")
    stdin, stdout, stderr = client.exec_command(docker_command)
    client.close()
```

---

## 12. 초기 세팅 원격 작업 방법 (Tailscale)

### 현재 상황
- 전산실 문이 잠겨 있어 물리적 접근 불가
- 1대의 PC가 **Tailscale**로 원격 SSH 연결 가능한 상태

### Tailscale로 원격 세팅 가능 여부
→ **가능. SSH 터미널만 있으면 Phase 1~5 전부 명령어로 완료 가능.**

### 주의사항: 재부팅 시 연결 끊김

GPU 드라이버 설치 후 `sudo reboot` 필요 → SSH 연결 끊김.

재부팅 전 Tailscale 자동 시작 여부 확인:
```bash
sudo systemctl is-enabled tailscaled
# "enabled" 출력 시 재부팅 후 자동 재연결됨
```

재부팅 후 1분 기다렸다가 다시 SSH 접속하면 됨.

### 나머지 14대 세팅 전략
- 1대 세팅 완료 후 동일한 절차를 나머지 14대에 반복
- 또는 Phase 1~5를 쉘 스크립트로 만들어 각 PC에 복사 후 한 번에 실행

### 최종 운영 시 접근 방식
- Tailscale은 초기 세팅용으로만 사용
- 운영 시에는 메인 서버(node01)가 내부망 SSH로 노드들을 관리
- 외부 접근은 Cloudflare Tunnel만 사용

---

## 13. Cloudflare Tunnel 세팅 가이드

> **현재 상태:** 도메인 미보유로 Quick Tunnel(임시 URL)로 테스트 완료. 도메인 확보 후 고정 터널로 전환 예정.

### 도메인 관련 주의사항

- Vercel 도메인(`xxx.vercel.app`)은 사용 불가 — Vercel 소유 도메인이라 Cloudflare로 네임서버 이전 불가
- Cloudflare Tunnel은 **내가 소유한 도메인**에만 DNS 레코드 등록 가능
- 도메인 구입처: Cloudflare Registrar 권장 (`.com` 연 ~$10, `.kr` 연 ~₩22,000)

### Phase A. cloudflared 설치 (서버컴)

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

### Phase B. Quick Tunnel — 도메인 없이 임시 테스트 ✅ 완료

로그인 없이 임시 URL로 바로 테스트 가능. 단, 재실행마다 URL이 바뀌고 프로세스 종료 시 사라짐.

컨테이너 실행 확인 후 (서버컴):
```bash
docker ps  # test_gui Up 상태 확인

cloudflared tunnel --url http://localhost:8080
# 출력 예시:
# https://some-random-words.trycloudflare.com
```

내 컴퓨터 브라우저에서 출력된 URL 접속 → 비밀번호 입력 → Ubuntu GNOME 확인.

> **`nvidia-glx-desktop`은 HTTP로 서빙하므로 `--url http://localhost:8080` (https 아님)**

| 항목 | Quick Tunnel |
|------|-------------|
| URL 고정 여부 | ❌ 재실행마다 바뀜 |
| 프로세스 종료 시 | ❌ URL 즉시 사라짐 |
| 로그인 불필요 | ✅ |
| 비용 | ✅ 무료 |
| 운영 가능 여부 | ❌ 테스트 전용 |

### Phase C. 고정 터널 — 도메인 확보 후 진행 (미완료)

도메인 준비 완료 후 아래 순서로 진행:

#### Step 1 — Cloudflare 로그인 (서버컴)

```bash
cloudflared tunnel login
# 출력된 URL을 내 컴퓨터 브라우저에서 열고 → 도메인 선택 → 승인
# ~/.cloudflared/cert.pem 자동 생성됨
```

#### Step 2 — 터널 생성 (서버컴)

```bash
cloudflared tunnel create node01
# 출력 예시: Created tunnel node01 with id abc123de-xxxx-...
# 터널 ID 메모 필수
cloudflared tunnel list
```

#### Step 3 — 설정 파일 작성 (서버컴)

```bash
sudo mkdir -p /etc/cloudflared
sudo nano /etc/cloudflared/config.yml
```

```yaml
tunnel: abc123de-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # 실제 터널 ID
credentials-file: /root/.cloudflared/abc123de-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json

ingress:
  - hostname: node01.school.com     # 실제 도메인으로 교체
    service: http://localhost:8080  # nvidia-glx-desktop은 HTTP
  - service: http_status:404
```

#### Step 4 — DNS 자동 등록 (서버컴)

```bash
cloudflared tunnel route dns node01 node01.school.com
# Cloudflare DNS에 CNAME 레코드 자동 추가
```

#### Step 5 — 포그라운드 테스트 (서버컴)

```bash
cloudflared tunnel run node01
# 내 컴퓨터 브라우저에서 https://node01.school.com 접속 확인
```

#### Step 6 — 서비스 등록 (서버컴)

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sudo systemctl status cloudflared
# 이후 재부팅해도 터널 자동 시작
```

---

## 14. Tech Stack 정리

| 구분 | 기술 | 이유 |
|------|------|------|
| 프론트엔드 | Next.js (Vercel) | 기존 개발 경험, 배포 간편 |
| 백엔드 API | Python FastAPI | API 개발 속도 빠름, Paramiko 연동 용이 |
| DB | SQLite (개발) / MySQL (운영) | 소규모 시스템에 적합 |
| 노드 원격 제어 | Paramiko 또는 Fabric | Python에서 SSH 명령 자동화 |
| 웹 서버/프록시 | Caddy | Nginx보다 설정 10배 쉬움, API로 라우팅 자동화 가능 |
| 컨테이너 이미지 | `nvidia-glx-desktop` (Selkies) | GNOME UI, WebRTC 스트리밍, GPU 완전 가속 |
| GPU 지원 | NVIDIA Container Toolkit | 도커에서 RTX 3080 사용 |
| 외부 접근 | Cloudflare Tunnel (무료) | 방화벽 우회, VPN 불필요 |
| 접근 제어 | Cloudflare Access (선택) | 터널 레벨 구글 로그인 강제 |
| 인증 | Google OAuth | 구글 로그인 |
| 스케줄러 | Cron 또는 Celery | 만료 섹션 자동 회수 |

---

## 15. 진행 현황 (노드 세팅 완료 기록)

### 테스트 노드 환경 정보 (2026-06-05 완료)

| 항목 | 내용 |
|------|------|
| OS | Ubuntu (기존 설치 상태 유지, 포맷 생략) |
| GPU | NVIDIA GeForce RTX 3080 (10240MiB) |
| NVIDIA 드라이버 | 535.309.01 |
| CUDA | 12.2 |
| 원격 접속 수단 | Tailscale (SSH) → Cloudflare Quick Tunnel로 전환 완료 |
| 노드 Tailscale IP | `100.115.25.22` |

### 완료된 세팅 단계

#### Phase 1 — OS 정리
기존 파일 및 사용자 계정 정리 생략. 필요 시 추후 진행.

#### Phase 2 — NVIDIA GPU 드라이버
- 상태: **사전 설치 완료** (세팅 불필요)
- 확인 명령어:
  ```bash
  nvidia-smi
  # Driver Version: 535.309.01 / CUDA Version: 12.2 확인됨
  ```

#### Phase 3a — Docker Engine 설치 ✅
```bash
sudo apt update && sudo apt install -y docker.io docker-compose
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER
sudo reboot
# 재부팅 후 Tailscale 자동 재연결 확인됨
```

#### Phase 3b — NVIDIA Container Toolkit 설치 ✅
```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update && sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

GPU 연동 확인:
```bash
docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi
# 컨테이너 안에서 RTX 3080 정상 인식 확인 ✅
```

#### Phase 4 — 학생 데이터 저장 폴더 ✅
```bash
sudo mkdir -p /data/students
sudo chmod -R 777 /data/students
```

#### Phase 5 — 컨테이너 테스트 ✅

**1차 테스트: webtop:ubuntu-xfce** (이후 UI 이슈로 교체)
```bash
docker run -d \
  --name test_gui \
  --gpus all \
  --shm-size="2gb" \
  -p 3000:3000 \
  -p 3001:3001 \
  -e TZ=Asia/Seoul \
  -v /data/students/test_user:/config \
  lscr.io/linuxserver/webtop:ubuntu-xfce
```
- `https://100.115.25.22:3001` 접속 확인 (자체 서명 인증서 → `thisisunsafe` 우회)
- XFCE UI가 Ubuntu 기본 UI(GNOME)와 달라 학생 친숙도 낮음 → 이미지 교체 결정

**2차 테스트: nvidia-glx-desktop** (채택) ✅
```bash
docker rm -f test_gui

docker run -d \
  --name test_gui \
  --gpus all \
  --runtime nvidia \
  --shm-size="2gb" \
  -p 8080:8080 \
  -e TZ=Asia/Seoul \
  -e SIZEW=1920 \
  -e SIZEH=1080 \
  -e PASSWD=test1234 \
  -v /data/students/test_user:/home/user \
  ghcr.io/selkies-project/nvidia-glx-desktop:latest
```
- GNOME Ubuntu 바탕화면 정상 렌더링 확인 ✅
- WebRTC 스트리밍으로 화면 부드러움 확인 ✅

#### Cloudflare Quick Tunnel 테스트 ✅

```bash
# cloudflared 설치
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Quick Tunnel 실행 (백그라운드)
nohup cloudflared tunnel --url http://localhost:8080 > /tmp/cloudflared.log 2>&1 & disown

# URL 확인
grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cloudflared.log | head -1
```
- Tailscale 없이 외부에서 접속 가능 확인 ✅
- 임시 URL(`https://xxx.trycloudflare.com`)로 Ubuntu GNOME 화면 접속 완료 ✅
- HTTP 포트(`8080`)로 연결 시 정상 작동 확인 (HTTPS 강제 이슈 없음)

#### HTTPS 강제 이슈 비교 (webtop vs nvidia-glx-desktop)

| 이미지 | HTTP 접속 | HTTPS 접속 |
|--------|-----------|------------|
| webtop:ubuntu-xfce | ❌ selkies JS가 HTTPS 강제 | ✅ (자체 서명 인증서 경고) |
| nvidia-glx-desktop | ✅ 정상 작동 | ✅ |

→ `nvidia-glx-desktop`은 HTTP로도 정상 접속 → Cloudflare Tunnel이 HTTPS 처리하므로 문제 없음

---

## 17. 트러블슈팅 기록 (2026-06-06)

### 증상: cloudflared Quick Tunnel 502 Bad Gateway / ERR_TOO_MANY_RETRIES

외부 URL 접속 시 502 → 이후 ERR_TOO_MANY_RETRIES 발생.

### 원인 1 — 호스트 GDM이 GPU 점유 → 컨테이너 Xorg 실패

이전 테스트(2026-06-05) 이후 호스트가 재부팅되면서 GDM(GNOME Display Manager)이 RTX 3080을 선점.
컨테이너 안 Xorg가 `Fatal server error: no screens found`로 종료 → selkies-gstreamer가 X socket 무한 대기 → nginx도 selkies(8081)가 뜰 때까지 대기 → 8080 listen 자체가 없음 → cloudflared가 connection reset.

**조치:**
```bash
# student3 계정으로 sudo 가능
echo 'BOS123!@#' | sudo -S systemctl stop gdm3
# 필요 시 복구: sudo systemctl start gdm3
```

> **운영 주의:** 24/7 운영 시 GDM을 아예 비활성화하거나 멀티시트 방식으로 노드 PC를 구성해야 함.
> ```bash
> sudo systemctl disable gdm3   # 부팅 시 GUI 로그인 없이 시작
> sudo systemctl set-default multi-user.target
> ```

### 원인 2 — `/tmp/runtime-ubuntu` 디렉토리 권한 `700` → nginx .htpasswd 읽기 실패

컨테이너 재시작마다 selkies 엔트리포인트가 `/tmp/runtime-ubuntu`를 `chmod 700`으로 생성.
nginx worker(`www-data`)가 디렉토리에 진입 자체가 불가 → `.htpasswd` open 실패 → HTTP 500.

**조치 (컨테이너 시작 직후 매번 실행):**
```bash
docker exec -u root test_gui chmod 755 /tmp/runtime-ubuntu
```

**현재 임시 대책:** student3 crontab에 `@reboot` 항목 등록:
```bash
@reboot sleep 30 && docker exec -u root test_gui chmod 755 /tmp/runtime-ubuntu 2>/dev/null
```

> **근본 해결:** Docker 실행 시 엔트리포인트 실행 후 권한을 덮어쓰는 래퍼 스크립트를 만들거나,
> `SELKIES_ENABLE_BASIC_AUTH=false` 환경변수로 Basic Auth 자체를 끄는 방법 검토.

### 원인 3 — Quick Tunnel URL의 브라우저 캐시 오염

502/500이 반복되면 Chrome이 해당 도메인에 대해 `ERR_TOO_MANY_RETRIES`를 반환.
→ cloudflared를 재시작하여 **새 URL** 발급 후 시크릿 탭으로 접속하면 해결.

```bash
# 기존 tunnel 종료 후 새로 시작
pkill -f 'cloudflared tunnel'
nohup cloudflared tunnel --url http://localhost:8080 > /tmp/cloudflared.log 2>&1 & disown
sleep 12
grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cloudflared.log | head -1
```

### 접속 확인 체크리스트 (매 터널 시작 후 검증 순서)

```bash
# 1. 노드 내부 — origin 응답 확인
curl -sS -o /dev/null -w 'HTTP=%{http_code}\n' -u 'ubuntu:test1234' http://localhost:8080/

# 2. 외부 — 터널 경유 응답 확인 (로컬 머신에서)
curl -sS -o /dev/null -w 'HTTP=%{http_code}\n' -u 'ubuntu:test1234' https://<tunnel-url>/

# 3. 외부 — 페이지 제목 확인
curl -sS -u 'ubuntu:test1234' https://<tunnel-url>/ | grep '<title>'
# 기대값: <title>Selkies - webrtc</title>

# 4. 브라우저 — 시크릿 탭에서 접속 후 로딩 인디케이터 → 바탕화면 렌더링 확인
```

### 현재 접속 정보 (2026-06-06 기준)

| 항목 | 값 |
|------|-----|
| 터널 URL | `https://modular-campaign-entry-restrictions.trycloudflare.com` |
| Username | `abc` |
| Password | `test1234` |
| 상태 | 외부 HTTP 200 확인 ✅ |
| 주의 | Quick Tunnel이라 cloudflared 재시작 시 URL 변경됨 |

---

## 18. 노드 데스크톱 환경 확정 기록 (2026-06-06)

### 최종 채택 구성

| 항목 | 내용 |
|------|------|
| Docker 이미지 | `lscr.io/linuxserver/webtop:ubuntu-mate` |
| 데스크톱 환경 | Ubuntu MATE (GNOME 2 계열) |
| 스트리밍 방식 | Selkies WebSocket (`--mode=websockets`) |
| 스트리밍 이유 | KasmVNC에서 Selkies로 이미지 자체 업데이트됨 |
| 브라우저 접속 방식 | Cloudflare Quick Tunnel → nginx → Selkies |
| 내부 포트 | 컨테이너 3000 → 호스트 8080 |
| GPU | `--gpus all` — CUDA 연산 가속 사용 가능 |
| 볼륨 | `/data/students/{student_id}:/config` |
| 인증 | HTTP Basic Auth (nginx): `abc` / `test1234` |

### GNOME Shell 시도 실패 이유

| 방식 | 실패 원인 |
|------|-----------|
| `gnome-session` | systemd 없이 시작 불가 (`org.freedesktop.systemd1` 미존재) |
| `gnome-session --session=gnome-flashback-metacity` | 동일한 systemd 의존성 문제 |
| KDE Plasma (nvidia-glx-desktop) | KDE 세션 manager(ksmserver) 충돌, XDG_RUNTIME_DIR 권한 문제 |

→ **결론: Docker 컨테이너(systemd 없음) 환경에서 GNOME Shell 계열은 사용 불가. Ubuntu MATE 확정.**

### MATE 패널 레이아웃 설정

```bash
# 컨테이너 안에서 실행 (DISPLAY=:1)
# 상단 바: 애플리케이션 메뉴 + 터미널/Chromium/파일관리자 런처 + 시스템 트레이/시계
# 하단 바: 바탕화면 보기 + 열린 창 목록 + 작업공간 전환

gsettings set org.mate.panel toplevel-id-list '["top", "bottom"]'
gsettings set org.mate.panel object-id-list '["menu-bar", "terminal-launcher", "chromium-launcher", "caja-launcher", "notification-area", "indicatorappletcomplete", "show-desktop", "window-list", "workspace-switcher"]'

# 패널 높이 — HiDPI 3424×2144 기준 192px (2배 스케일)
gsettings set "org.mate.panel.toplevel:/org/mate/panel/toplevels/top/" size 192
gsettings set "org.mate.panel.toplevel:/org/mate/panel/toplevels/bottom/" size 192

# 폰트/DPI — HiDPI 2배 스케일 (text-scaling-factor 최대 3.0)
gsettings set org.mate.font-rendering dpi 576.0
gsettings set org.gnome.desktop.interface text-scaling-factor 3.0
gsettings set org.mate.interface font-name "Sans 48"
gsettings set org.mate.interface document-font-name "Sans 48"
gsettings set org.mate.interface monospace-font-name "Monospace 40"
gsettings set org.mate.Marco.general titlebar-font "Sans Bold 48"
pkill -HUP xsettingsd 2>/dev/null
```

> **주의:** `nohup mate-panel &`으로 패널을 수동 실행하면 mate-session이 관리하는 프로세스와 **중복 실행**되어 패널이 두 줄로 겹쳐 보인다. 패널 재시작 시 반드시 `killall -9 mate-panel`만 실행하고 mate-session이 자동 재시작하도록 둘 것.

### 패널 중복 문제 해결법

증상: 상단/하단 바가 두 줄씩 겹쳐 표시됨

원인: `nohup mate-panel &` 수동 실행 + mate-session 자동 재시작이 동시에 동작

```bash
# 해결: 모든 mate-panel 종료 후 mate-session이 단독 재시작하도록 둠
docker exec -u abc test_gui bash -c 'export DISPLAY=:1; killall -9 mate-panel'
# (mate-session이 수 초 내에 자동 재시작)
```

### 컨테이너 재시작 후 패널 설정 재적용 스크립트

컨테이너 재시작 시 gsettings 값이 초기화될 수 있음. 재적용 방법:

```bash
docker cp /tmp/set_panels.sh test_gui:/tmp/set_panels.sh
docker exec -u abc test_gui bash /tmp/set_panels.sh
```

`/tmp/set_panels.sh` 내용은 위 MATE 패널 레이아웃 설정 명령어 전체를 포함. 볼륨(`/data/students/test_user`)에 dconf가 저장되므로 재시작 후에도 유지되나, 일부 설정은 재적용 필요.

### Selkies WebSocket 스트리밍 특이사항

- Selkies가 `--mode=websockets`로 실행 → WebRTC(UDP) 불필요 → Cloudflare Tunnel 완벽 통과
- 접속 후 브라우저에서 **한 번 클릭**해야 스트림이 시작됨 (자동재생 정책)
- 해상도는 브라우저 뷰포트에 자동 맞춤 (테스트 환경: 3424×2144 HiDPI)
- `InvalidUpgrade` WebSocket 에러는 일시적 — 새로고침 후 재접속하면 해결

---

## 16. 미결 사항 및 체크리스트

### 인프라 준비

- [x] 테스트 노드 1대 Phase 2~5 세팅 완료 (2026-06-05)
- [x] `nvidia-smi` 정상 출력 확인
- [x] Docker + NVIDIA Toolkit GPU 연동 확인
- [x] `nvidia-glx-desktop` 컨테이너 실행 및 GNOME 화면 확인
- [x] Cloudflare Quick Tunnel로 외부 접속 확인 (Tailscale 없이)
- [x] 502/ERR_TOO_MANY_RETRIES 원인 파악 및 해결 (2026-06-06, 상세 내용 §17)
- [x] 브라우저 접속 데스크톱 환경 확정: Ubuntu MATE + Selkies WebSocket (2026-06-06, §18)
- [x] MATE 패널 레이아웃 구성: 상단 바(메뉴+앱런처+시계) + 하단 작업표시줄 (2026-06-06)
- [x] HiDPI(3424×2144) 환경 스케일 적용 — 패널 192px, 폰트 576DPI/Sans48 (2026-06-06)
- [x] 패널 중복 문제(두 줄 겹침) 해결 — mate-session 단독 관리 방식으로 전환 (2026-06-06)
- [ ] 패널 설정 스크립트(`set_panels.sh`)를 컨테이너 이미지에 영구 포함 (Dockerfile 작성)
- [x] GDM 영구 비활성화 (`multi-user.target`으로 전환) — 컨테이너 안정 운영을 위해 필요 (2026-06-06 완료)
- [x] 내부망 직접 접속 시도 — 학교 VLAN 차단으로 불가 확인 (2026-06-06, §20)
- [x] Cloudflare Quick Tunnel 무료 운영 방식으로 확정 (2026-06-06, §21)
- [ ] `/tmp/runtime-ubuntu` 권한 문제 근본 해결 (래퍼 스크립트 또는 Basic Auth 비활성화 검토)
- [ ] 나머지 14대 동일 세팅 적용 (스크립트화 예정)
- [ ] 메인 서버(node01) 지정 및 SSH Key 배포 (14대에 `ssh-copy-id`)
- [x] 섹션 생성 시 URL 자동 캡처 → DB 저장 → 포털 표시 구현 (2026-06-06, §22 §23)
- [ ] 24/7 운영을 위한 전산실 PC 전원 정책 확인 (학교 측 협의)

### 개발 전 결정 필요

- [x] 백엔드 언어 최종 확정 → **Python FastAPI** (2026-06-06, §22)
- [ ] Cloudflare 계정 및 도메인 준비 (`.com` 또는 `.kr`)
- [ ] 메인 서버로 사용할 노드 지정 (node01 권장)
- [ ] 섹션 최대 임대 시간 정책 결정 (예: 최대 6시간)
- [ ] 학생 계정당 동시 섹션 수 제한 (예: 1인 1섹션)
- [ ] 데이터 보존 기간 정책 (학기 말 초기화 등)

### 보안 검토

- [ ] `/data/students` 권한 정책 재검토 (777 → 적절한 권한으로 변경)
- [ ] 컨테이너 네트워크 외부 트래픽 제한 정책 검토
- [ ] 학교 전산 담당 선생님 협의 및 승인

### 개발 구현 순서 (권장)

1. ✅ 메인 서버에서 수동으로 `docker run` 테스트 (완료)
2. ✅ FastAPI로 단일 노드에 docker 명령 날리는 기본 API 구현 (2026-06-06, §22)
3. ☐ DB 설계 및 섹션 생성/회수 로직 구현 (현재: 인메모리 dict)
4. ✅ Cloudflare Quick Tunnel 연동 완료 (2026-06-06, §22)
5. ✅ Vercel 프론트 개발 + 간단 로그인 연동 (2026-06-06, §23)
6. ☐ 스케줄러(자동 회수) 구현
7. ☐ 전체 통합 테스트 (Vercel 배포 후)
8. ☐ 나머지 14대 확장

---

## 19. kasmweb 이미지 테스트 및 Chrome 401 해결 (2026-06-06)

### 테스트 배경

기존 `webtop:ubuntu-mate` UI가 Ubuntu 순정과 다르다는 피드백으로 대체 이미지 탐색.
Docker 컨테이너에서 GNOME Shell은 systemd 의존성으로 불가(§18 동일 이유)하므로,
`kasmweb/ubuntu-jammy-desktop:1.16.0` (Ubuntu 22.04 기반) 테스트 진행.

### kasmweb 컨테이너 실행

```bash
# 기존 컨테이너 정지 (삭제 없음, 볼륨 보존)
docker stop test_gui

# GDM 중지 (GPU 점유 해제)
echo 'BOS123!@#' | sudo -S systemctl stop gdm3

# kasmweb 컨테이너 실행
docker run -d \
  --name test_kasm \
  --gpus all \
  --shm-size='2gb' \
  -p 8080:6901 \
  -e VNC_PW=test1234 \
  kasmweb/ubuntu-jammy-desktop:1.16.0
```

| 항목 | 내용 |
|------|------|
| 내부 포트 | 컨테이너 6901 → 호스트 8080 |
| 데스크톱 환경 | XFCE (ubuntu-jammy-desktop도 XFCE 기반) |
| 스트리밍 방식 | KasmVNC (HTTPS 전용) |
| 인증 | `www-authenticate: Basic realm="Websockify"` |

> **주의:** `kasmweb/ubuntu-jammy-desktop`은 이름과 달리 GNOME이 아닌 **XFCE** 데스크톱 환경을 사용함.
> Docker 컨테이너에서 GNOME Shell은 systemd 없이 동작하지 않음.

### Chrome 502/401 문제 및 해결

#### 문제 1 — TLS 인증서 불일치 (502 Bad Gateway)

`--url https://localhost:8080`으로 cloudflared 실행 시 502 발생.

```
tls: failed to verify certificate: x509: certificate is not valid for any names, but wanted to match localhost
```

Kasm이 자체 서명 인증서를 사용하는데 cloudflared가 이를 거부.

**조치:** `--no-tls-verify` 플래그 추가.

```bash
cloudflared tunnel --url https://localhost:8080 --no-tls-verify
```

#### 문제 2 — Chrome HTTP ERROR 401

Safari에서는 정상 작동하나 Chrome에서 `HTTP ERROR 401` 발생.

**원인:** Kasm이 모든 요청에 `www-authenticate: Basic realm="Websockify"` 헤더와 함께 401을 반환.
Safari는 401 응답 본문(로그인 화면)을 렌더링하지만, Chrome 90+은 이 패턴에서 다이얼로그 대신 에러 페이지를 표시.

**해결:** nginx를 앞단 프록시로 두어 `Authorization` 헤더를 자동 주입 → 브라우저가 401을 보지 않음.

```bash
# nginx 설치
sudo apt-get install -y nginx

# 프록시 설정 (/etc/nginx/sites-available/kasm-proxy)
server {
    listen 9090;

    location / {
        proxy_pass https://localhost:8080;
        proxy_set_header Authorization "Basic a2FzbV91c2VyOnRlc3QxMjM0";  # kasm_user:test1234
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host localhost;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# 적용
sudo ln -sf /etc/nginx/sites-available/kasm-proxy /etc/nginx/sites-enabled/kasm-proxy
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

> `a2FzbV91c2VyOnRlc3QxMjM0` = `kasm_user:test1234` base64 인코딩값.
> 운영 시 비밀번호 변경 시 이 값도 함께 갱신 필요.

```bash
# cloudflared는 nginx(HTTP)로 연결 — TLS 문제 없음
nohup cloudflared tunnel --url http://localhost:9090 > /tmp/cloudflared.log 2>&1 & disown
```

### 최종 접속 흐름

```
브라우저 → Cloudflare Tunnel (HTTPS)
  → nginx :9090 (HTTP, Authorization 자동 주입)
    → Kasm :8080 (HTTPS, 자체 서명 인증서)
      → KasmVNC 데스크톱 스트리밍
```

### 현재 접속 정보 (2026-06-06 기준)

| 항목 | 값 |
|------|-----|
| 터널 URL | Quick Tunnel (재시작마다 변경) |
| Username | `kasm_user` |
| Password | `test1234` |
| nginx 프록시 포트 | `9090` |
| 컨테이너 포트 | `8080 → 6901` |
| Chrome 접속 | ✅ 정상 (HTTP 200) |
| Safari 접속 | ✅ 정상 |

### 운영 시 주의사항

- nginx `kasm-proxy` 설정은 재부팅 후에도 유지됨 (`/etc/nginx/sites-enabled/`).
- cloudflared는 `nohup ... &`으로 실행되므로 재부팅 시 수동 재시작 필요 — 운영 시 systemd 서비스로 등록 권장.
- `Authorization` 헤더에 비밀번호가 평문(base64)으로 포함되므로, nginx는 로컬에서만 접근 가능하게 유지할 것 (외부 포트 9090 노출 금지).

---

## 20. 내부망 직접 접속으로 전환 (2026-06-06)

### 전환 배경

Cloudflare Tunnel은 학교 15대 PC의 트래픽을 외부 서버(Cloudflare)를 경유시키는 구조로,
학교 데이터 처리 정책상 법적 리스크 존재. 학생들이 어차피 교내망 내부에서만 접속하므로
Cloudflare 없이 내부망 직접 접속으로 전환.

### 노드 네트워크 정보

| 항목 | 값 |
|------|-----|
| 내부망 IP | `10.72.117.24` |
| 서브넷 | `/22` (`10.72.116.0 ~ 10.72.119.255`) |
| OS 방화벽(ufw) | 비활성화 |
| iptables | `INPUT policy ACCEPT` — 내부망 트래픽 전체 허용 |

### 접속 구조 (변경 후)

```
학생 브라우저 (교내망 PC)
  → http://10.72.117.24/   (포트 80, nginx)
    → https://localhost:8080 (Kasm 컨테이너, nginx가 Authorization 자동 주입)
      → KasmVNC 데스크톱 스트리밍
```

Cloudflare Tunnel, Tailscale 모두 불필요. 교내망 접속만으로 동작.

### 변경 내용

**nginx 포트 변경 (9090 → 80):** `/etc/nginx/sites-available/kasm-proxy`

```nginx
server {
    listen 80;

    location / {
        proxy_pass https://localhost:8080;
        proxy_set_header Authorization "Basic a2FzbV91c2VyOnRlc3QxMjM0";
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host localhost;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

**부팅 시 자동 구동 설정 (재부팅/Tailscale 없이도 동작):**

| 서비스 | 설정 | 비고 |
|--------|------|------|
| Docker | `systemctl enable docker` | 완료 |
| nginx | `systemctl enable nginx` | 완료 |
| GDM3 | `systemctl disable gdm3` | 완료 — GPU 점유 방지 |
| 기본 런레벨 | `multi-user.target` | GUI 없이 부팅 |
| Kasm 컨테이너 | `--restart unless-stopped` | Docker 시작 시 자동 실행 |
| cloudflared | 제거 (종료) | 내부망 전환으로 불필요 |

**재부팅 시 자동 시작 순서:**
```
systemd 부팅
  → Docker 시작 → test_kasm 컨테이너 자동 실행
  → nginx 시작 → 포트 80 리스닝 시작
  (GDM 없음 → GPU를 컨테이너가 독점 사용)
```

### 현재 접속 정보

| 항목 | 값 |
|------|-----|
| **학생 접속 URL** | `http://10.72.117.24/` |
| 별도 설치 | 불필요 (브라우저만으로 접속) |
| Cloudflare | 사용 안 함 |
| Tailscale | 사용 안 함 (관리자 원격 접속용으로만 선택적 사용) |

### 학교 내부망 방화벽 주의사항

> 학교 네트워크는 VLAN 분리, 스위치 ACL 등으로 **노드 PC 간 통신을 차단**할 수 있음.
> 학생 PC → 노드 PC(10.72.117.24:80) 접속이 실제로 되는지 교내에서 직접 확인 필요.
> 차단된 경우: 학교 전산 담당자에게 해당 포트 개방 요청 필요.

### 관리자 원격 접속 방법 (교외)

운영 중 원격 관리가 필요할 경우 Tailscale을 선택적으로 사용:
```bash
# 노드에서 Tailscale 시작
sudo tailscale up

# 관리자 Mac에서 SSH 접속
ssh student3@100.115.25.22
```

Tailscale을 끄면 학생 서비스(http://10.72.117.24/)에는 영향 없음.

---

## 21. Cloudflare Quick Tunnel 운영 방식 확정 (2026-06-06)

### 배경

§20에서 내부망 직접 접속을 시도했으나 학교 VLAN/스위치 ACL로 패킷 자체가 차단됨 (tcpdump 0 packets 확인).
Cloudflare Quick Tunnel은 노드가 outbound로 Cloudflare에 연결하는 방식이라 학교 방화벽을 우회 가능.
무료 플랜으로 운영하되, Quick Tunnel의 URL 변경 특성을 시스템 설계에 반영하는 방향으로 확정.

### 확정된 접속 구조

```
학생 브라우저
  → https://{session-id}.trycloudflare.com  (세션 생성 시 발급)
    → Cloudflare Edge (outbound 터널)
      → cloudflared 프로세스 (노드에서 실행)
        → nginx :80 (Authorization 자동 주입)
          → Kasm 컨테이너 :8080 (HTTPS, KasmVNC 스트리밍)
```

### Quick Tunnel URL 변경 문제 해결 방식

Quick Tunnel은 cloudflared를 재시작할 때마다 URL이 바뀜.
→ **백엔드가 URL을 캡처해 DB에 저장하고, 학생은 포털에서 현재 URL을 확인**하는 방식으로 해결.

#### 섹션 생성 시 URL 캡처 플로우

```
백엔드 (FastAPI)
  1. docker run → 컨테이너 시작
  2. SSH로 노드에서 cloudflared 실행:
       nohup cloudflared tunnel --url http://localhost:80 > /tmp/cf_{session_id}.log 2>&1 &
  3. 15초 대기 후 URL 파싱:
       grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' /tmp/cf_{session_id}.log | head -1
  4. 파싱된 URL을 Instances DB에 저장 (tunnel_url 컬럼)
  5. 학생에게 URL 반환 / 포털에 표시
```

#### Python 백엔드 구현 예시

```python
import paramiko, time, re

def start_session_tunnel(node_ip: str, session_id: str) -> str:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(node_ip, username="admin", key_filename="/home/admin/.ssh/id_ed25519")

    log_path = f"/tmp/cf_{session_id}.log"

    # cloudflared 실행
    client.exec_command(
        f"nohup cloudflared tunnel --url http://localhost:80 > {log_path} 2>&1 &"
    )

    # URL 발급 대기 (최대 20초)
    for _ in range(20):
        time.sleep(1)
        _, stdout, _ = client.exec_command(
            f"grep -Eo 'https://[a-zA-Z0-9.-]+\\.trycloudflare\\.com' {log_path} | head -1"
        )
        url = stdout.read().decode().strip()
        if url:
            client.close()
            return url  # DB에 저장 후 학생에게 반환

    client.close()
    raise RuntimeError("Tunnel URL 발급 실패")
```

#### 학생 포털 UX

```
[섹션 생성 버튼 클릭]
   → "데스크톱 준비 중..." (로딩, ~15초)
   → 접속 URL 표시:
       https://abc-xyz.trycloudflare.com
       [바로 접속하기] 버튼
```

섹션이 만료되거나 컨테이너가 재시작되면, 포털에서 "재연결 중..." 후 새 URL을 다시 표시.

### 현재 노드 운영 상태 (2026-06-06 기준)

| 항목 | 값 |
|------|-----|
| 노드 내부 IP | `10.72.117.24` |
| nginx | 포트 80, 부팅 시 자동 시작 |
| Kasm 컨테이너 | `--restart unless-stopped` |
| cloudflared | Quick Tunnel, `nohup` 실행 (재부팅 시 수동 재시작 필요) |
| GDM | 영구 비활성화 (`multi-user.target`) |

> **운영 시 개선 사항:** cloudflared를 systemd 서비스로 등록하면 재부팅 시 자동으로 새 URL을 발급하고, 백엔드가 이를 감지해 DB를 갱신하는 구조로 발전 가능.

---

## 22. FastAPI 백엔드 구현 완료 (2026-06-06)

### 구현 내용

§21의 설계를 바탕으로 실제 FastAPI 백엔드를 구현·배포 완료.

**파일 위치 (서버):** `/home/student3/backend/`

```
backend/
├── main.py          # FastAPI 앱 본체
├── requirements.txt # fastapi, uvicorn
└── start.sh         # 백엔드 + cloudflared 일괄 시작 스크립트
```

### 구현된 API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/health` | 헬스체크 |
| `POST` | `/session` | 컨테이너 생성 + 터널 시작 |
| `GET` | `/session/{id}` | 세션 상태·URL 조회 |
| `DELETE` | `/session/{id}` | 세션 종료 |

모든 엔드포인트는 `x-api-key` 헤더로 인증. 환경변수 `API_KEY`와 비교.

### 세션 생성 플로우 (`POST /session`)

```
1. 기존 session cloudflared 종료 (PID 파일 /tmp/session_cf.pid)
2. 기존 컨테이너 삭제 (test_kasm, active_session)
3. docker run kasmweb/ubuntu-jammy-desktop:1.16.0 -p 8080:6901
4. cloudflared tunnel --url http://localhost:80 → /tmp/session_cf.log
5. session_id 반환 (즉시)
```

`GET /session/{id}` 폴링 시 `/tmp/session_cf.log`에서 URL 파싱해 반환.

### 세션 URL 응답 예시

```json
// starting 상태
{"status": "starting"}

// ready 상태 (보통 3~5초 이내)
{"status": "ready", "url": "https://xxxx.trycloudflare.com"}
```

### 접속 구조 (백엔드 포함)

```
Vercel 프론트엔드
  → cloudflared Quick Tunnel (백엔드용, 포트 8000)
    → FastAPI :8000 (student3@100.115.25.22)
        → docker rm/run (Kasm 컨테이너 :8080)
        → cloudflared Quick Tunnel (세션용, 포트 80)
            → nginx :80 (Authorization 자동 주입)
                → Kasm :8080
```

### 백엔드 시작/재시작 방법

```bash
ssh student3@100.115.25.22  # BOS123!@#
bash ~/start_backend.sh
# → 출력: BACKEND_URL=https://xxxx.trycloudflare.com
```

### 현재 운영 상태 (2026-06-06 기준)

| 항목 | 값 |
|------|-----|
| FastAPI 포트 | `8000` |
| 백엔드 클라우드플레어 URL | `https://softball-mating-briefly-presence.trycloudflare.com` |
| API 키 | `pc-rental-secret-2024` |
| 세션 컨테이너명 | `active_session` |
| 세션 CF 로그 | `/tmp/session_cf.log` |
| 세션 CF PID | `/tmp/session_cf.pid` |

> **재부팅 주의:** 서버 재부팅 시 `bash ~/start_backend.sh` 실행 → 새 `BACKEND_URL` 확인 → Vercel 환경변수 업데이트 → Redeploy 필요.

---

## 23. Next.js 프론트엔드 구현 및 Vercel 배포 준비 (2026-06-06)

### 구현 내용

**GitHub:** `https://github.com/minigu5/dshs-server`

**로컬 경로:** `/Users/shinmingyu/Project/server_connection/frontend/`

```
frontend/
├── app/
│   ├── page.tsx                    # / → 로그인 여부에 따라 리다이렉트
│   ├── layout.tsx
│   ├── login/page.tsx              # 로그인 페이지
│   ├── dashboard/page.tsx          # PC 대여 대시보드
│   └── api/
│       ├── login/route.ts          # POST 로그인 → 쿠키 발급
│       ├── logout/route.ts         # POST 로그아웃
│       └── session/
│           ├── route.ts            # POST 세션 생성 (백엔드 프록시)
│           └── [id]/route.ts       # GET 상태조회 / DELETE 종료
├── lib/auth.ts                     # HMAC 토큰 유틸
├── middleware.ts                   # /dashboard 보호 (Edge Runtime, Web Crypto API)
├── .env.local                      # 환경변수 (git 제외)
└── .env.local.example              # 환경변수 템플릿
```

### 인증 방식

- 로그인: `ADMIN_USERNAME` / `ADMIN_PASSWORD` (환경변수) 검증
- 세션: HMAC-SHA256 서명 쿠키 (`AUTH_SECRET` 키 사용)
- API 키: `API_KEY` 환경변수 → 백엔드 `x-api-key` 헤더로 전달 (클라이언트에 노출 안 됨)

### UX 흐름

```
로그인 페이지
  → [로그인] 클릭
대시보드
  → [PC 대여하기] 클릭
  → "데스크톱 환경을 준비하는 중..." (프로그레스 바 + 경과 시간)
  → 3초마다 상태 폴링
  → URL 수신 시 "데스크톱이 준비되었습니다!" + [데스크톱 열기] 버튼
  → [세션 종료] 클릭 시 컨테이너·터널 삭제
```

### Vercel 환경변수 설정

| 변수명 | 값 | 비고 |
|--------|-----|------|
| `BACKEND_URL` | `https://xxxx.trycloudflare.com` | 재부팅 시 변경됨 |
| `API_KEY` | `pc-rental-secret-2024` | 백엔드 API 키 |
| `ADMIN_USERNAME` | `admin` | 포털 로그인 아이디 |
| `ADMIN_PASSWORD` | `admin1234` | 포털 로그인 비밀번호 |
| `AUTH_SECRET` | `pc-rental-auth-secret-super-random-2024` | 쿠키 서명 시크릿 |

### Vercel 배포 방법

1. [vercel.com](https://vercel.com) → **New Project** → `minigu5/dshs-server` 연결
2. 위 환경변수 5개 입력
3. **Deploy** 클릭

### 로컬 테스트 방법

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
npm run dev
# http://localhost:3000
# 아이디: admin / 비밀번호: admin1234
```

### 동작 확인 결과 (2026-06-06)

| 테스트 항목 | 결과 |
|-------------|------|
| 로그인 성공/실패 | ✅ |
| 대시보드 미인증 접근 차단 | ✅ |
| 세션 생성 API (백엔드 프록시) | ✅ |
| URL 폴링 (3초 이내 ready) | ✅ |
| 빌드 경고 없음 | ✅ |
| GitHub 업로드 | ✅ |
