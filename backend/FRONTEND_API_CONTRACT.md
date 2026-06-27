# 프론트엔드 ↔ 백엔드 API 계약서

프론트엔드 리팩토링(2026-06-27) 이후 백엔드에서 구현이 필요한 엔드포인트 목록.
기존 엔드포인트는 하위 호환 유지. 신규/변경 항목만 기술.

---

## 1. 노드 목록 조회 (사양 필터링)

```
GET /nodes?cpu_cores=4&ram_gb=16&storage_gb=100&gpu=dedicated
Headers: x-api-key
```

사용자가 요구 사양 슬라이더를 조작할 때마다 프론트엔드가 이 엔드포인트를 호출하여 매칭되는 PC 목록을 표시한다.

### Query Parameters (모두 선택적)

| 파라미터 | 타입 | 설명 |
|---------|------|------|
| `cpu_cores` | int | 최소 CPU 코어 수 |
| `ram_gb` | int | 최소 RAM (GB) |
| `storage_gb` | int | 최소 저장공간 (GB) |
| `gpu` | `none` \| `shared` \| `dedicated` | GPU 타입 |

### Response

```json
{
  "nodes": [
    {
      "id": "server-01",
      "name": "1호기",
      "cpu": "Intel Core i7-10700",
      "cpu_cores": 8,
      "gpu": "NVIDIA GTX 1660",
      "ram_gb": 32,
      "storage_gb": 500,
      "available": true,
      "session_state": "none"
    }
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `available` | bool | `false`이면 기존 하위 호환 — 사용 불가 |
| `session_state` | `"none"` \| `"suspended"` \| `"active"` | PC 세션 상태 (우선순위: `available` 보다 높음) |

- `session_state: "none"` 또는 `available: true` → 선택 가능 (초록 배지 "사용 가능")
- `session_state: "suspended"` → 선택 가능, 새 세션 생성 시 기존 저장 세션 대체 (주황 배지 "저장된 세션 있음")
- `session_state: "active"` 또는 (`available: false` + `session_state` 미제공) → 완전 비활성 (빨간 배지 "사용 중") — 새 세션 생성·이어서 사용 모두 불가

미구현 시 fallback: `{ nodes: [{ id: "server-01", name: "1호기", cpu: "Intel Core i7", gpu: "NVIDIA GTX 1660", ram_gb: 32, storage_gb: 500, available: true, session_state: "none" }] }` 반환.

---

## 1-b. 단일 노드 스펙 (레거시)

```
GET /node_specs
Headers: x-api-key
```

`/api/node` 라우트에서 사용. `/nodes`로 대체 가능하나 하위 호환용으로 유지.

---

## 2. 세션 생성 — 요청 바디 확장

```
POST /session
Headers: x-api-key, x-user-email, x-user-admin
Content-Type: application/json
```

### Request Body (선택적 — 없어도 기존 동작 유지)

```json
{
  "project_name": "ML 실습 프로젝트",
  "team_members": ["ts250015@ts.hs.kr"],
  "resources": {
    "cpu_cores": 4,
    "ram_gb": 16,
    "storage_gb": 100,
    "gpu": "dedicated"
  },
  "duration_days": 7,
  "replace_session_id": "abc123"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `project_name` | string | 프로젝트 이름 (저장된 세션 카드에 표시) |
| `team_members` | string[] | 팀원 이메일 목록 (`@ts.hs.kr`) |
| `node_id` | string? | 사용자가 선택한 PC ID (모달에서 `/nodes` 조회 후 선택) |
| `resources.cpu_cores` | int | 요청 CPU 코어 수 |
| `resources.ram_gb` | int | 요청 RAM (GB) |
| `resources.storage_gb` | int | 요청 저장공간 (GB) |
| `resources.gpu` | `"none"` \| `"shared"` \| `"dedicated"` | GPU 타입 |
| `duration_days` | int | 세션 유지 기간 (1~30일) |
| `replace_session_id` | string? | 삭제할 기존 suspended 세션 ID (새로 시작하기) |

### 1PC 제한 규칙
- 사용자당 활성 세션 최대 1개 (기본값)
- 팀 세션인 경우 팀장(`x-user-email`)만 카운트
- 초과 시 `429 Too Many Requests` 반환

```json
{ "error": "이미 활성 PC가 있습니다." }
```

---

## 3. 세션 재개 — session_id 파라미터 추가

```
POST /session?resume=true&session_id={id}
Headers: x-api-key, x-user-email
```

`session_id` 파라미터: 여러 suspended 세션 중 특정 세션 재개. 없으면 기존 동작(하나뿐인 세션 재개).

---

## 4. 세션 조회 — suspended_sessions 배열 추가

```
GET /session
Headers: x-api-key, x-user-email
```

### Response (변경)

기존 `{ "status": "suspended" }` 단일 응답 외에, suspended 세션이 여러 개인 경우:

```json
{
  "status": "none",
  "suspended_sessions": [
    {
      "id": "abc123",
      "project_name": "ML 실습 프로젝트",
      "saved_at": 1750000000,
      "team_members": ["ts250015@ts.hs.kr"],
      "resources": {
        "cpu_cores": 4,
        "ram_gb": 16,
        "storage_gb": 100,
        "gpu": "dedicated"
      }
    }
  ]
}
```

활성 세션과 suspended 세션이 동시에 존재할 경우:

```json
{
  "status": "ready",
  "session_id": "xyz789",
  "url": "https://kasm.dshs-app.net",
  "suspended_sessions": [...]
}
```

`suspended_sessions` 없으면 프론트엔드가 기존 `status: "suspended"` 방식으로 fallback.

---

## 5. PC 모니터링 (관리자)

```
GET /admin/nodes
Headers: x-api-key
```

관리자 패널이 3초마다 폴링. 현재 모든 노드의 실시간 사용률 반환.

### Response

```json
{
  "nodes": [
    {
      "id": "server-01",
      "name": "1호기",
      "status": "in_use",
      "project_name": "ML 실습 프로젝트",
      "owner": "ts250024@ts.hs.kr",
      "cpu_usage": 82.3,
      "gpu_usage": 60.1,
      "ram_used_gb": 12.4,
      "ram_total_gb": 32,
      "storage_used_gb": 245,
      "storage_total_gb": 500,
      "top_process": "python3"
    },
    {
      "id": "server-02",
      "name": "2호기",
      "status": "idle",
      "cpu_usage": 2.1,
      "gpu_usage": 0,
      "ram_used_gb": 1.2,
      "ram_total_gb": 32,
      "storage_used_gb": 80,
      "storage_total_gb": 500,
      "top_process": null
    }
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `status` | `"idle"` \| `"in_use"` \| `"offline"` | PC 상태 |
| `cpu_usage` | float | CPU 사용률 0~100 |
| `gpu_usage` | float | GPU 사용률 0~100 |
| `ram_used_gb` | float | 사용 중 RAM (GB) |
| `ram_total_gb` | float | 전체 RAM (GB) |
| `storage_used_gb` | float | 사용 중 저장공간 (GB) |
| `storage_total_gb` | float | 전체 저장공간 (GB) |
| `top_process` | string? | 가장 많은 자원을 사용하는 프로세스 이름 |

미구현 시 관리자 페이지에 "GET /admin/nodes 구현 후 표시" 안내 문구 표시. 에러 없음.

---

## 6. 사용자 목록 조회

```
GET /admin/users
Headers: x-api-key
```

### Response

```json
{
  "users": [
    {
      "email": "ts250024@ts.hs.kr",
      "max_sessions": 1,
      "active_sessions": 0
    },
    {
      "email": "ts250015@ts.hs.kr",
      "max_sessions": 2,
      "active_sessions": 1
    }
  ]
}
```

미구현 시 프론트엔드 관리자 페이지의 사용자 목록이 빈 상태로 표시 (에러 아님).

---

## 6. 사용자 최대 세션 수 변경

```
PATCH /admin/users/{email}
Headers: x-api-key
Content-Type: application/json
```

### Request Body

```json
{ "max_sessions": 2 }
```

### Response

```json
{ "email": "ts250024@ts.hs.kr", "max_sessions": 2 }
```

---

## 7. 저장된 세션 영구 삭제

```
DELETE /session/{id}?permanent=true
Headers: x-api-key, x-user-email
```

기존 `DELETE /session/{id}` (파라미터 없음)는 `docker stop` — 컨테이너 보존.  
`?permanent=true`는 `docker rm -f` — 컨테이너 + 볼륨 완전 삭제.

### Response

```json
{ "message": "세션을 완전히 삭제했습니다." }
```

---

## 구현 우선순위

| 우선순위 | 항목 | 이유 |
|---------|------|------|
| 🔴 높음 | `GET /admin/nodes` | 관리자 모니터링 — 3초 폴링, 미구현 시 빈 화면 |
| 🔴 높음 | `GET /nodes` | PC 선택 모달 필수 — fallback은 단일 서버 하드코딩 |
| 🔴 높음 | `POST /session` 바디 파싱 (`node_id` 포함) | 프론트엔드가 항상 JSON body 전송 |
| 🔴 높음 | 1PC 제한 (`429` 반환) | 다중 대여 방지 |
| 🔴 높음 | `DELETE /session/{id}?permanent=true` | 영구 삭제 — 없으면 suspend와 동일 동작 |
| 🟡 중간 | `GET /session` → `suspended_sessions[]` | 다중 저장 세션 UX |
| 🟡 중간 | `POST /session?resume=true&session_id=` | 특정 세션 재개 |
| 🟢 낮음 | `GET /node_specs` | `/nodes` fallback 있음 |
| 🟢 낮음 | `GET /admin/users`, `PATCH /admin/users/{email}` | 관리자 편의 기능 |
