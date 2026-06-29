# 이메일 알림 시스템 설계

**날짜**: 2026-06-29  
**대상 파일**: `hub/main.py`

---

## 개요

PC 대여 세션의 주요 상태 변경 시 세션 소유자에게 자동으로 이메일 경고를 발송한다.
Gmail API (OAuth2)를 사용하며, 허브 서버(admin-swai-00)에서 실행된다.

---

## 트리거 (4가지)

| 시점 | 트리거 위치 | 이메일 제목 |
|------|-----------|-----------|
| 만료 7일 전 | `_email_notification_loop()` (1시간 주기 스캔) | "[PC대여] 세션이 7일 후 자동 일시중지됩니다" |
| 만료 자동 suspend | `_poll_nodes_loop()` 만료 처리 블록 | "[PC대여] 세션이 만료되어 일시중지되었습니다" |
| 사용자 수동 일시중지 | `DELETE /session/{id}` | "[PC대여] 세션을 일시중지했습니다" |
| 영구 삭제 | `DELETE /session/{id}?permanent=true` | "[PC대여] 세션이 삭제되었습니다" |

---

## 인증 방식

- **방식**: Gmail API OAuth2 (Desktop App credentials)
- **초기 설정**: 허브 서버에서 1회 인터랙티브 인증 → `token.json` 저장
- **이후**: google-auth 라이브러리가 refresh token으로 자동 갱신

### 환경변수 (`~/.hub.env`)

```
GMAIL_CREDENTIALS=/root/hub/credentials.json   # GCP OAuth2 client secrets
GMAIL_TOKEN=/root/hub/token.json               # 저장된 토큰 (1회 인증 후 자동 생성)
GMAIL_SENDER=dshs-admin@gmail.com              # 발신 Gmail 계정
```

---

## 데이터 모델 변경

Firestore `sessions` 컬렉션의 세션 문서에 필드 1개 추가:

```
warning_email_sent: bool  # 7일 전 경고 이메일 발송 여부 (중복 발송 방지)
```

---

## 구현 범위 (`hub/main.py`)

### 추가할 것

1. **패키지**: `google-auth`, `google-auth-oauthlib`, `google-api-python-client`

2. **환경변수 읽기**: `GMAIL_CREDENTIALS`, `GMAIL_TOKEN`, `GMAIL_SENDER`

3. **`_send_email(to, subject, body)`**: Gmail API 호출 헬퍼. 실패 시 로그만 남기고 예외 무시.

4. **`_email_notification_loop()`**: 백그라운드 태스크. 1시간 주기로 실행.
   - 모든 active/starting 세션 조회
   - `expires_at - now < 7일` AND `warning_email_sent` 없음인 세션 → 경고 이메일 + `warning_email_sent: True` 저장

5. **`lifespan`**: `_email_notification_loop()` 태스크 등록

### 수정할 것

6. **`_poll_nodes_loop()` 만료 블록**: suspend 후 이메일 발송 1줄 추가

7. **`delete_session()` 일시중지 분기**: suspend 후 이메일 발송 1줄 추가

8. **`delete_session()` 영구삭제 분기**: delete 후 이메일 발송 1줄 추가

---

## 오류 처리

- Gmail API 실패 → `try/except` 로 격리, 로그만 출력, 세션 로직에 영향 없음
- `token.json` 없음 → 이메일 기능 비활성화 (경고 로그), 나머지 정상 동작
- `GMAIL_CREDENTIALS` 없음 → 동일하게 비활성화

---

## 성공 기준

1. 7일 전 경고 이메일: 세션당 1회만 발송 (`warning_email_sent` 필드로 보장)
2. 만료 auto-suspend 시 이메일 발송
3. 수동 일시중지 시 이메일 발송
4. 영구 삭제 시 이메일 발송
5. Gmail API 오류가 세션 API 응답에 영향 없음 (격리됨)
6. `GMAIL_CREDENTIALS` 미설정 시 graceful degradation

---

## 설정 안 하는 것

- 이메일 템플릿 파일 (인라인 문자열로 충분)
- 큐/재시도 메커니즘 (단순 발송 실패 허용)
- 관리자 알림 이메일 (사용자 본인만)
- 7일 외 다른 경고 주기 (요청 없음)
