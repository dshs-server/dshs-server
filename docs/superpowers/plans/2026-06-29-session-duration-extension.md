# Session Duration & Extension Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션 유지 기간을 1~28일로 세분화하고, 2일 이내 연장 버튼, 40일 총 기간 제한, 이어서하기 시 기간 재선택, 관리자 대리 신청 기능을 구현한다.

**Architecture:** Hub FastAPI에 `original_created_at` 필드와 `PATCH /session/{id}` 연장 엔드포인트를 추가한다. 프론트엔드는 `useSession` 훅에 `handleExtend` / `handleResume(id, duration)` 을 추가하고, SavedPage에 duration 선택 시트를, WorkPage에 연장 버튼을 삽입한다. 관리자 기능(대리 신청, 40일 초과 세션 허가)은 AdminArea 세션 탭에 추가한다.

**Tech Stack:** FastAPI (Python), Next.js 14 App Router, React, TypeScript, CSS Modules (atelier.module.css)

## Global Constraints

- CSS: 기존 `atelier.module.css`의 클래스만 재사용. 새 클래스 추가 시 파일 하단에 추가.
- 관리자 이메일: `ts250024@ts.hs.kr` (auth.ts `HARDCODED_ADMINS` 첫 번째 값)
- 40일 제한: `(expires_at - original_created_at) / 86400 >= 40` AND NOT `extend_unlocked`
- 무한 기간(관리자 전용): `duration_days = 0` → `expires_at = now + 999 * 86400`
- 28+ 선택 시: 폼 제출 불가, 관리자 이메일 안내문 표시
- 연장 단위: 항상 3일
- 연장 활성 조건: `remaining <= 172800` (2일 = 2×86400초)
- 기존 코드 패턴 유지: `_sc_get`, `_sc_update`, `_sc_set`, `_sc_del` 함수 사용

---

## File Map

| 파일 | 변경 유형 | 역할 |
|------|-----------|------|
| `hub/main.py` | Modify | `original_created_at`, `PATCH /session/{id}`, `behalf_of`, resume에 duration 추가 |
| `frontend/app/api/session/[id]/route.ts` | Modify | PATCH 핸들러 추가 |
| `frontend/app/api/admin/sessions/route.ts` | Modify | PATCH(extend_unlock), POST(behalf_of 세션 생성) 추가 |
| `frontend/app/portal/RequestSheet.tsx` | Modify | 1~28일 + 28+ + isAdmin prop + 무한 옵션 |
| `frontend/app/portal/useSession.ts` | Modify | `handleExtend`, `handleResume(id, duration)` 업데이트, `extend_blocked` 추가 |
| `frontend/app/portal/pages/WorkPage.tsx` | Modify | 연장 버튼, 40일 초과 시 관리자 연락 버튼 |
| `frontend/app/portal/pages/SavedPage.tsx` | Modify | 이어하기 → duration 선택 시트 먼저 |
| `frontend/app/portal/PortalShell.tsx` | Modify | RequestSheet에 `isAdmin` prop 전달 |
| `frontend/app/portal/admin/AdminArea.tsx` | Modify | 대리 신청 폼 + 40일 초과 허가 UI |
| `frontend/app/portal/atelier.module.css` | Modify | 연장 버튼, duration 시트, 관리자 배너 스타일 |

---

## Task 1: Hub — original_created_at + PATCH 연장 엔드포인트 + behalf_of

**Files:**
- Modify: `hub/main.py`

**Interfaces:**
- Produces:
  - `GET /session` → `original_created_at: float`, `extend_blocked: bool` in active session and each suspended_session entry
  - `PATCH /session/{id}` body `{"extend_days": 3}` → `{"expires_at": float}`
  - `PATCH /session/{id}` body `{"extend_unlocked": true}` (admin only) → `{"ok": true}`
  - `POST /session` body `SessionBody` with optional `behalf_of: str` (admin only)
  - `POST /session?resume=true` now reads `duration_days` from body `SessionBody`

- [ ] **Step 1: SessionBody에 behalf_of 추가**

`hub/main.py` line 921 근처의 `SessionBody` 클래스 수정:

```python
class SessionBody(BaseModel):
    node_id: Optional[str] = None
    project_name: Optional[str] = None
    team_members: Optional[list[str]] = None
    resources: Optional[dict] = None
    duration_days: Optional[int] = 7
    work_type: Optional[str] = None
    replace_session_id: Optional[str] = None
    behalf_of: Optional[str] = None  # admin only
```

- [ ] **Step 2: create_session에서 new session 시 original_created_at 저장 + behalf_of 처리**

`hub/main.py`의 `create_session` 함수에서 새 세션 생성 부분(line ~1207) 수정:

```python
    # behalf_of: 관리자가 다른 사용자 대신 신청
    if is_admin and body and body.behalf_of:
        me = body.behalf_of.lower().strip()

    # ...기존 node 선택 로직...

    duration = (body.duration_days if body else None)
    if duration is None or duration < 0:
        duration = 7
    # 무한(0) → 999일
    if duration == 0:
        expires_delta = 999 * 86400
    else:
        expires_delta = duration * 86400

    now_ts = time.time()
    session_data = {
        "node_id": node_id,
        "owner": me,
        "team_members": (body.team_members if body else None) or [],
        "project_name": (body.project_name if body else None) or "",
        "status": "starting",
        "created_at": now_ts,
        "original_created_at": now_ts,  # 연장/재개 시 불변
        "expires_at": now_ts + expires_delta,
        "extend_unlocked": False,
        "work_type": (body.work_type if body else None) or "",
        "resources": (body.resources if body else None) or {},
        "port": port,
        "url": _session_url(new_id, kasm_url),
    }
```

위에서 기존 `duration = (body.duration_days if body else None) or 7` 및 `session_data` 딕셔너리를 통째로 교체한다.

- [ ] **Step 3: resume 시 duration_days 처리 + 40일 체크**

`hub/main.py`의 `create_session` resume 분기(line ~1047)에서 `docker start` 후 `_sc_update` 호출 부분 수정:

```python
    if resume:
        suspended_docs = _sc_list(owner=me, status="suspended")
        if not suspended_docs:
            raise HTTPException(status_code=404, detail="저장된 세션이 없습니다.")

        target_sid, s = (
            next((pair for pair in suspended_docs if pair[0] == session_id), suspended_docs[0])
            if session_id else suspended_docs[0]
        )
        node = await _get_node(s["node_id"])
        _suser = node.get("ssh_user", SSH_USER)
        container = _container_name(target_sid)

        inspect_out, inspect_rc = await _ssh(
            node["ip"],
            f"docker inspect --format={{{{.State.Status}}}} {container} 2>/dev/null",
            _suser,
        )
        if inspect_rc == -1:
            raise HTTPException(status_code=503, detail="노드 서버 연결 실패. 잠시 후 다시 시도하세요.")
        if inspect_rc != 0 or not inspect_out:
            _sc_del(target_sid)
            try:
                await db.collection(COL_SESSIONS).document(target_sid).delete()
            except Exception:
                pass
            raise HTTPException(status_code=409, detail="저장된 작업 파일이 더 이상 존재하지 않습니다. 새로 시작해주세요.", headers={"X-Container-Gone": "1"})

        # duration 결정
        resume_duration = (body.duration_days if body else None)
        if resume_duration is None or resume_duration < 0:
            resume_duration = 7
        if resume_duration == 0:
            expires_delta = 999 * 86400
        else:
            expires_delta = resume_duration * 86400

        now_ts = time.time()
        new_expires = now_ts + expires_delta
        original_created = s.get("original_created_at") or s.get("created_at", now_ts)

        # 40일 초과 체크
        if not (is_admin or s.get("extend_unlocked")):
            total_days = (new_expires - original_created) / 86400
            if total_days > 40:
                raise HTTPException(
                    status_code=403,
                    detail="세션 총 이용 기간이 40일을 초과합니다. 관리자 허가가 필요합니다.",
                )

        stdout, rc = await _ssh(node["ip"], f"docker start {container}", _suser)
        if rc != 0:
            raise HTTPException(status_code=500, detail=f"docker start 실패: {stdout}")

        updates = {
            "status": "starting",
            "created_at": now_ts,
            "expires_at": new_expires,
        }
        _sc_update(target_sid, updates)
        await db.collection(COL_SESSIONS).document(target_sid).update(updates)
        if s.get("port"):
            await _nginx_update(s["node_id"], node["ip"], _suser, node.get("kasm_url", ""))
        await _log_activity(
            me,
            "session_resume",
            "세션을 이어서 시작했습니다",
            s.get("project_name") or target_sid,
            members=s.get("team_members"),
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
        return {"session_id": target_sid, "status": "starting"}
```

- [ ] **Step 4: get_session 응답에 original_created_at, extend_blocked 추가**

`hub/main.py`의 `get_session` 함수(line ~931) 수정:

`suspended_sessions` 목록 생성 부분:
```python
    now_ts = time.time()
    suspended_sessions = []
    for sid, s in suspended:
        orig = s.get("original_created_at") or s.get("created_at", 0)
        # suspend된 세션은 만료 기한이 없으므로 estimated: 현재 + 40d limit check용
        s_extend_blocked = (not s.get("extend_unlocked", False)) and \
            ((now_ts + 86400 - orig) / 86400 >= 40)  # 최소 1일로 재개해도 40일 초과 여부
        suspended_sessions.append({
            "id": sid,
            "project_name": s.get("project_name", ""),
            "saved_at": s.get("suspended_at") or s.get("created_at", 0),
            "team_members": s.get("team_members", []),
            "resources": s.get("resources", {}),
            "original_created_at": orig,
            "extend_blocked": s_extend_blocked,
        })
```

active session 응답 부분(`dock == "running"` 분기):
```python
    if dock == "running":
        url = _session_url(session_id, node.get("kasm_url", "https://kasm.dshs-app.net"))
        orig = s.get("original_created_at") or s.get("created_at", time.time())
        expires = s.get("expires_at", time.time())
        extend_blocked = (not s.get("extend_unlocked", False)) and \
            ((expires - orig) / 86400 >= 40)
        return {
            "status": "ready",
            "session_id": session_id,
            "url": url,
            "expires_at": expires,
            "original_created_at": orig,
            "extend_blocked": extend_blocked,
            "suspended_sessions": suspended_sessions,
            **meta,
        }
```

- [ ] **Step 5: PATCH /session/{id} 엔드포인트 추가**

`delete_session` 함수 바로 앞에 삽입:

```python
class ExtendBody(BaseModel):
    extend_days: Optional[int] = None
    extend_unlocked: Optional[bool] = None


@app.patch("/session/{session_id}", dependencies=[Depends(require_key), Depends(require_user)])
async def patch_session(
    session_id: str,
    body: ExtendBody,
    x_user_email: str = Header(""),
    x_user_admin: str = Header("0"),
):
    s = _sc_get(session_id)
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found")

    me = x_user_email.lower()
    is_admin = x_user_admin == "1"

    if not is_admin and s.get("owner") != me:
        raise HTTPException(status_code=403, detail="본인 세션만 수정할 수 있습니다.")

    # 관리자 전용: extend_unlocked 설정
    if body.extend_unlocked is not None:
        if not is_admin:
            raise HTTPException(status_code=403, detail="관리자만 허가할 수 있습니다.")
        updates = {"extend_unlocked": body.extend_unlocked}
        _sc_update(session_id, updates)
        await db.collection(COL_SESSIONS).document(session_id).update(updates)
        return {"ok": True}

    # extend_days: 3일 연장
    if body.extend_days is not None:
        if body.extend_days <= 0:
            raise HTTPException(status_code=400, detail="extend_days는 양수여야 합니다.")

        current_expires = s.get("expires_at", time.time())
        now_ts = time.time()
        remaining = current_expires - now_ts

        # 2일 이내에만 연장 가능
        if remaining > 2 * 86400 and not is_admin:
            raise HTTPException(
                status_code=400,
                detail="세션 종료 2일 이내에만 연장할 수 있습니다.",
            )

        new_expires = current_expires + body.extend_days * 86400
        orig = s.get("original_created_at") or s.get("created_at", now_ts)

        # 40일 초과 체크
        if not (is_admin or s.get("extend_unlocked")):
            total_days = (new_expires - orig) / 86400
            if total_days > 40:
                raise HTTPException(
                    status_code=403,
                    detail="세션 총 이용 기간이 40일을 초과합니다. 관리자 허가가 필요합니다.",
                )

        updates = {"expires_at": new_expires}
        _sc_update(session_id, updates)
        await db.collection(COL_SESSIONS).document(session_id).update(updates)
        await _log_activity(
            s.get("owner", me),
            "session_extend",
            f"세션을 {body.extend_days}일 연장했습니다",
            s.get("project_name") or session_id,
            node_id=s.get("node_id"),
            project_name=s.get("project_name"),
        )
        return {"expires_at": new_expires}

    raise HTTPException(status_code=400, detail="extend_days 또는 extend_unlocked 중 하나를 제공해야 합니다.")
```

- [ ] **Step 6: admin/status 엔드포인트에서 세션에 extend_blocked 포함**

`hub/main.py`의 `/admin/status` 또는 `/admin/sessions` 응답에 `original_created_at`, `extend_blocked` 포함 확인. `/admin/sessions` 엔드포인트를 찾아:

```python
# 기존 sessions 목록 반환 부분에서 각 세션 딕셔너리에 아래 필드 추가
now_ts = time.time()
for sid, s in all_sessions:
    orig = s.get("original_created_at") or s.get("created_at", 0)
    expires = s.get("expires_at", 0)
    s["extend_blocked"] = (not s.get("extend_unlocked", False)) and \
        ((expires - orig) / 86400 >= 40)
    s["original_created_at"] = orig
```

- [ ] **Step 7: hub 배포 및 확인**

```bash
ssh admin-swai@100.79.232.71  # asdwsx12!
sudo systemctl restart hub
sudo systemctl status hub
```

기대: `hub.service: active (running)`

---

## Task 2: Frontend API Routes — PATCH 핸들러 + Admin 세션 API 확장

**Files:**
- Modify: `frontend/app/api/session/[id]/route.ts`
- Modify: `frontend/app/api/admin/sessions/route.ts`

**Interfaces:**
- Produces:
  - `PATCH /api/session/[id]` body `{extend_days: number}` → `{expires_at: number}` or error
  - `PATCH /api/admin/sessions?session_id=X` body `{extend_unlocked: true}` → `{ok: true}`
  - `POST /api/admin/sessions` body `{behalf_of, node_id, project_name, ...SessionBody}` → session create response

- [ ] **Step 1: /api/session/[id]/route.ts 에 PATCH 추가**

`frontend/app/api/session/[id]/route.ts` 파일 끝에 추가:

```typescript
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const headers = await userHeaders();
  if (!headers) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const body = await request.json();
    const res = await fetch(`${BACKEND_URL}/session/${id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json({ error: detail || "연장 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (e) {
    console.error("session patch error:", e);
    return NextResponse.json({ error: "백엔드 서버에 연결할 수 없습니다." }, { status: 503 });
  }
}
```

- [ ] **Step 2: /api/admin/sessions/route.ts 확장 (PATCH + POST)**

`frontend/app/api/admin/sessions/route.ts` 전체 교체:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail, isAdmin } from "@/lib/auth";

const BACKEND_URL = process.env.BACKEND_URL;
const API_KEY = process.env.API_KEY;

async function adminHeaders() {
  const email = await getSessionEmail();
  if (!isAdmin(email)) return null;
  return {
    "x-api-key": API_KEY!,
    "x-user-email": email!,
    "x-user-admin": "1",
  };
}

export async function GET() {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ sessions: [] });

  try {
    const res = await fetch(`${BACKEND_URL}/admin/sessions`, {
      headers,
      cache: "no-store",
    });
    if (res.ok) return NextResponse.json(await res.json());
    return NextResponse.json({ sessions: [] });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}

// 관리자가 세션 연장 허가
export async function PATCH(request: NextRequest) {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ error: "설정 오류" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("session_id");
  if (!sessionId) return NextResponse.json({ error: "session_id 필요" }, { status: 400 });

  try {
    const body = await request.json();
    const res = await fetch(`${BACKEND_URL}/session/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json({ error: detail || "처리 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}

// 관리자가 다른 사용자 대신 세션 생성
export async function POST(request: NextRequest) {
  const headers = await adminHeaders();
  if (!headers) return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  if (!BACKEND_URL) return NextResponse.json({ error: "설정 오류" }, { status: 500 });

  try {
    const body = await request.json();
    const res = await fetch(`${BACKEND_URL}/session`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : null;
      return NextResponse.json({ error: detail || "세션 생성 실패" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "백엔드 연결 실패" }, { status: 503 });
  }
}
```

- [ ] **Step 3: TypeScript 타입 오류 없는지 확인**

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
npx tsc --noEmit 2>&1 | head -30
```

기대: 타입 오류 없음 (또는 기존 오류와 동일)

---

## Task 3: RequestSheet — 1~28일 선택 + 28+ 안내 + isAdmin 무한

**Files:**
- Modify: `frontend/app/portal/RequestSheet.tsx`
- Modify: `frontend/app/portal/PortalShell.tsx`
- Modify: `frontend/app/portal/atelier.module.css`

**Interfaces:**
- Consumes: `isAdmin: boolean` prop (new)
- Produces: `NewSessionForm.duration_days: number` (0 = 무한, -1 = 28+ invalid)

- [ ] **Step 1: CSS — duration 관련 스타일 추가**

`frontend/app/portal/atelier.module.css` 파일 맨 끝에 추가:

```css
/* Duration picker — RequestSheet / DurationSheet 공용 */
.durationGrid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.durationBtn { appearance: none; padding: 6px 2px; border: 1px solid var(--hair); border-radius: 4px; background: transparent; color: var(--dim); font-size: 9px; text-align: center; cursor: pointer; transition: .12s; }
.durationBtn:hover { border-color: var(--signal); color: var(--paper); }
.durationBtn[data-on="true"] { border-color: var(--signal); background: rgba(47,120,255,.15); color: var(--paper); }
.durationBtn[data-special="true"] { color: var(--signal); }
.durationBtn[data-infinite="true"] { grid-column: span 2; color: #a78bfa; border-color: rgba(167,139,250,.4); }
.durationAdminNotice { margin: 8px 0 0; padding: 10px 12px; border: 1px solid rgba(167,139,250,.35); border-radius: 6px; background: rgba(167,139,250,.06); color: #a78bfa; font-size: 9px; line-height: 1.6; }
.durationOverNotice { margin: 8px 0 0; padding: 10px 12px; border: 1px solid #ead39a; border-radius: 6px; background: rgba(252,238,199,.12); color: #d8b365; font-size: 9px; line-height: 1.6; }
/* DurationSheet (이어하기 기간 선택) */
.durationSheet { width: min(480px, 94vw); }
.durationSheet .formMain { padding: 24px; border-right: 0; }

/* 연장 버튼 */
.extendRow { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; padding: 10px 0 0; border-top: 1px solid var(--hair-dark); }
.extendRow > span { flex: 1; color: var(--faint); font-size: 9px; }
.extendBanner { margin: 10px 0 0; padding: 10px 14px; border: 1px solid #e8aeb8; border-radius: 8px; background: rgba(251,210,217,.12); color: #963e4c; font-size: 9px; line-height: 1.6; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
```

- [ ] **Step 2: RequestSheet.tsx 전체 교체**

`frontend/app/portal/RequestSheet.tsx`:

```typescript
"use client";

import { memo, useEffect, useState } from "react";
import s from "./atelier.module.css";
import { Overlay, Field, HelpTip } from "./ui";
import { nodeState, type NodeInfo } from "./useNodes";
import type { NewSessionForm } from "./useSession";

const WORK_TYPES: { key: string; label: string; sub: string }[] = [
  { key: "general", label: "일반 연산", sub: "코딩·자료 처리" },
  { key: "gpu", label: "GPU 학습", sub: "비전·딥러닝" },
  { key: "custom", label: "직접 지정", sub: "사양 개별 선택" },
];

const CPU_OPTS = [2, 4, 8, 16, 32];
const RAM_OPTS = [4, 8, 16, 32, 64];
const STORAGE_OPTS = [50, 100, 250, 500];

const ADMIN_EMAIL = "ts250024@ts.hs.kr";

// 1~28 + 특수값: -1 = 28+, 0 = 무한
const DURATION_DAYS: number[] = Array.from({ length: 28 }, (_, i) => i + 1);

export default function RequestSheet({
  nodes,
  isAdmin = false,
  onClose,
  onSubmit,
}: {
  nodes: NodeInfo[];
  isAdmin?: boolean;
  onClose: () => void;
  onSubmit: (form: NewSessionForm) => void;
}) {
  const [projectName, setProjectName] = useState("");
  const [workType, setWorkType] = useState("gpu");
  const [members, setMembers] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState("");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [cpu, setCpu] = useState(8);
  const [ram, setRam] = useState(16);
  const [storage, setStorage] = useState(100);
  const [duration, setDuration] = useState(7); // -1 = 28+, 0 = 무한
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNodeId !== null) return;
    const selectable = nodes.filter((n) => nodeState(n) !== "active");
    if (selectable.length === 1) setSelectedNodeId(selectable[0].id);
  }, [nodes, selectedNodeId]);

  function addMember() {
    const email = memberInput.trim().toLowerCase();
    if (!email) return;
    if (!email.endsWith("@ts.hs.kr")) {
      setMemberError("@ts.hs.kr 이메일만 추가할 수 있습니다.");
      return;
    }
    if (members.includes(email)) {
      setMemberError("이미 추가된 팀원입니다.");
      return;
    }
    setMembers((m) => [...m, email]);
    setMemberInput("");
    setMemberError(null);
  }

  const meets = (node: NodeInfo) =>
    (node.cpu_cores == null || node.cpu_cores >= cpu) &&
    node.ram_gb >= ram &&
    node.storage_gb >= storage &&
    (node.resource_used == null || node.cpu_cores == null || node.cpu_cores === 0 ||
      (node.resource_used.cpu_cores + cpu) / node.cpu_cores <= 0.9) &&
    (node.resource_used == null || node.ram_gb === 0 ||
      (node.resource_used.ram_gb + ram) / node.ram_gb <= 0.9);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedOk = selectedNode ? meets(selectedNode) && nodeState(selectedNode) !== "active" : false;
  const isOverLimit = duration === -1;
  const canStart = !!projectName.trim() && !!selectedNodeId && selectedOk && !isOverLimit;
  const selectedNo = selectedNode ? nodes.findIndex((n) => n.id === selectedNode.id) + 1 : null;

  const durationLabel = duration === 0 ? "무한" : duration === -1 ? "28+" : `${duration}일`;

  function submit() {
    if (!canStart) return;
    onSubmit({
      project_name: projectName.trim(),
      team_members: members,
      cpu_cores: cpu,
      ram_gb: ram,
      storage_gb: storage,
      duration_days: duration,
      work_type: workType,
      node_id: selectedNodeId ?? undefined,
    });
  }

  return (
    <Overlay>
      <section className={s.requestSheet}>
        <header>
          <div>
            <span>작업 신청서</span>
            <h2>새 PC 배정</h2>
          </div>
          <button onClick={onClose}>닫기</button>
        </header>

        <div className={s.formGrid}>
          <div className={s.formMain}>
            <Field label="작업 이름">
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="예: 실시간 교통 객체 인식"
                autoFocus
              />
            </Field>

            <Field label="함께 사용할 학생">
              <div className={s.inlineInput}>
                <input
                  value={memberInput}
                  onChange={(e) => { setMemberInput(e.target.value); setMemberError(null); }}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMember())}
                  placeholder="@ts.hs.kr 계정"
                />
                <button type="button" onClick={addMember}>추가</button>
              </div>
            </Field>
            {memberError && (
              <p style={{ color: "#963e4c", fontSize: "13px", margin: "-10px 0 12px" }}>{memberError}</p>
            )}
            {members.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: "-6px 0 16px" }}>
                {members.map((m) => (
                  <span key={m} className={s.stateMark} style={{ cursor: "default" }}>
                    {m}
                    <button
                      type="button"
                      onClick={() => setMembers((x) => x.filter((y) => y !== m))}
                      style={{ border: 0, background: "none", cursor: "pointer", padding: "0 0 0 6px" }}
                    >✕</button>
                  </span>
                ))}
              </div>
            )}

            <fieldset>
              <legend>작업 성격</legend>
              <div className={s.workTypes}>
                {WORK_TYPES.map((t) => (
                  <label key={t.key}>
                    <input type="radio" name="type" checked={workType === t.key} onChange={() => setWorkType(t.key)} />
                    <span>{t.label}<small>{t.sub}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={s.specFields}>
              <Field label="CPU">
                <select value={cpu} onChange={(e) => setCpu(Number(e.target.value))}>
                  {CPU_OPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <small>코어 이상</small>
              </Field>
              <Field label="메모리">
                <select value={ram} onChange={(e) => setRam(Number(e.target.value))}>
                  {RAM_OPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <small>GB 이상</small>
              </Field>
              <Field label="저장 공간">
                <select value={storage} onChange={(e) => setStorage(Number(e.target.value))}>
                  {STORAGE_OPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <small>GB</small>
              </Field>
            </div>

            <Field label="유지 기간">
              <DurationPicker value={duration} onChange={setDuration} isAdmin={isAdmin} />
            </Field>
          </div>

          <SelectMachine
            nodes={nodes}
            cpu={cpu}
            ram={ram}
            storage={storage}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
          />
        </div>

        <footer>
          <div>
            <span>선택</span>
            <strong>
              {selectedNo ? `${selectedNo}호기` : "장비 미선택"} · {workTypeLabel(workType)} · {durationLabel}
            </strong>
          </div>
          <button className={s.lineButton} onClick={onClose}>취소</button>
          <button className={s.solidButton} disabled={!canStart} onClick={submit}>배정 요청</button>
        </footer>
      </section>
    </Overlay>
  );
}

export function DurationPicker({
  value,
  onChange,
  isAdmin = false,
}: {
  value: number;
  onChange: (v: number) => void;
  isAdmin?: boolean;
}) {
  return (
    <>
      <div className={s.durationGrid}>
        {DURATION_DAYS.map((d) => (
          <button
            key={d}
            type="button"
            className={s.durationBtn}
            data-on={value === d}
            onClick={() => onChange(d)}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className={s.durationBtn}
          data-on={value === -1}
          data-special="true"
          onClick={() => onChange(-1)}
        >
          28+
        </button>
        {isAdmin && (
          <button
            type="button"
            className={s.durationBtn}
            data-on={value === 0}
            data-infinite="true"
            onClick={() => onChange(0)}
          >
            ∞ 무한
          </button>
        )}
      </div>
      {value === -1 && (
        <p className={s.durationOverNotice}>
          28일 초과 이용은 관리자 승인이 필요합니다.
          관리자({ADMIN_EMAIL})에게 직접 문의해 주세요.
        </p>
      )}
      {value === 0 && isAdmin && (
        <p className={s.durationAdminNotice}>
          무한 기간: 999일로 설정됩니다. (관리자 전용)
        </p>
      )}
    </>
  );
}

function workTypeLabel(key: string) {
  return WORK_TYPES.find((t) => t.key === key)?.label ?? "일반";
}

const SelectMachine = memo(function SelectMachine({
  nodes, cpu, ram, storage, selectedNodeId, onSelect,
}: {
  nodes: NodeInfo[];
  cpu: number;
  ram: number;
  storage: number;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}) {
  const meets = (node: NodeInfo) =>
    (node.cpu_cores == null || node.cpu_cores >= cpu) &&
    node.ram_gb >= ram &&
    node.storage_gb >= storage &&
    (node.resource_used == null || node.cpu_cores == null || node.cpu_cores === 0 ||
      (node.resource_used.cpu_cores + cpu) / node.cpu_cores <= 0.9) &&
    (node.resource_used == null || node.ram_gb === 0 ||
      (node.resource_used.ram_gb + ram) / node.ram_gb <= 0.9);

  return (
    <aside className={s.selectMachine}>
      <div className={s.titleLine}>
        <h3>장비 선택</h3>
        <HelpTip text="요청 사양을 만족하는 장비만 선택할 수 있습니다." />
      </div>
      {nodes.length === 0 && <p>연결된 PC가 없습니다.</p>}
      {nodes.map((node, index) => {
        const st = nodeState(node);
        const ok = meets(node) && st !== "active";
        const sc = node.session_count ?? 0;
        const cpuPct = node.load?.cpu_pct ?? null;
        const userLabel =
          st === "active" ? "2명 사용 중 (만석)" :
          sc === 1 ? "1명 사용 중" : "비어 있음";
        const stateLabel =
          st === "active" ? "사용 중 (2/2)" :
          meets(node) ? "선택 가능" : "사양 부족";
        return (
          <button
            key={node.id}
            disabled={!ok}
            data-on={selectedNodeId === node.id}
            onClick={() => ok && onSelect(node.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{node.name || node.id}</strong>
              <small>
                {node.gpu}<br />
                {node.ram_gb}GB · {node.storage_gb}GB
              </small>
              {cpuPct !== null && <NodeLoadBar pct={cpuPct} label={userLabel} />}
              {cpuPct === null && sc > 0 && (
                <small style={{ color: "var(--c-text-2, #888)", fontSize: "11px" }}>{userLabel}</small>
              )}
            </div>
            <em>{stateLabel}</em>
          </button>
        );
      })}
    </aside>
  );
});

function NodeLoadBar({ pct, label }: { pct: number; label: string }) {
  const color = pct >= 80 ? "#c0392b" : pct >= 50 ? "#e67e22" : "#27ae60";
  return (
    <div style={{ marginTop: "4px" }}>
      <div style={{ height: "3px", borderRadius: "2px", background: "rgba(0,0,0,0.08)", overflow: "hidden", width: "100%" }}>
        <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: "11px", color: "var(--c-text-2, #888)" }}>CPU {Math.round(pct)}% · {label}</span>
    </div>
  );
}
```

- [ ] **Step 3: PortalShell.tsx — RequestSheet에 isAdmin 전달**

`frontend/app/portal/PortalShell.tsx`의 `RequestSheet` 호출 부분 수정 (line ~113):

```typescript
      {ctrl.showNewSessionModal && (
        <RequestSheet
          nodes={nodes}
          isAdmin={isAdmin}
          onClose={() => {
            ctrl.setShowNewSessionModal(false);
            ctrl.setReplaceSessionId(null);
          }}
          onSubmit={(form) =>
            ctrl.handleStartNew(form, ctrl.replaceSessionId || undefined)
          }
        />
      )}
```

---

## Task 4: useSession — handleExtend + handleResume(duration) + extend_blocked

**Files:**
- Modify: `frontend/app/portal/useSession.ts`

**Interfaces:**
- Produces:
  - `handleResume(id: string, durationDays: number): Promise<void>`
  - `handleExtend(): Promise<void>`
  - `extendBlocked: boolean`
  - `SuspendedSession.original_created_at?: number`
  - `SuspendedSession.extend_blocked?: boolean`
  - `SessionData.original_created_at?: number`
  - `SessionData.extend_blocked?: boolean`

- [ ] **Step 1: 타입 업데이트**

`useSession.ts`의 `SuspendedSession` 인터페이스:

```typescript
export interface SuspendedSession {
  id: string;
  project_name?: string;
  saved_at?: number;
  delete_after?: number;
  team_members?: string[];
  original_created_at?: number;
  extend_blocked?: boolean;
  resources?: {
    cpu_cores?: number;
    ram_gb?: number;
    storage_gb?: number;
    storage_used_gb?: number;
    gpu?: string;
  };
}
```

`SessionData` 인터페이스에 추가:

```typescript
export interface SessionData {
  // ...기존 필드...
  original_created_at?: number;
  extend_blocked?: boolean;
}
```

- [ ] **Step 2: 상태 변수 추가**

`useSession` 훅 내부 state 선언부에 추가:

```typescript
const [extendBlocked, setExtendBlocked] = useState(false);
```

- [ ] **Step 3: applyData 에서 extend_blocked 반영**

`applyData` 콜백:

```typescript
  const applyData = useCallback((data: SessionData) => {
    if (typeof data.expires_at === "number") setExpiresAt(data.expires_at);
    if (data.owner) setOwner(data.owner);
    if (typeof data.queue_position === "number") setQueuePos(data.queue_position);
    if (Array.isArray(data.suspended_sessions)) setSuspendedSessions(data.suspended_sessions);
    if (typeof data.extend_blocked === "boolean") setExtendBlocked(data.extend_blocked);
  }, []);
```

- [ ] **Step 4: handleResume 시그니처 변경 — durationDays 추가**

기존 `handleResume` 함수를 교체:

```typescript
  const handleResume = useCallback(
    async (suspendedId: string, durationDays: number) => {
      setStatus("starting");
      setErrorMsg(null);
      setUrl(null);
      elapsedRef.current = 0;
      setSessionId(null);
      expiredRef.current = false;
      timerRef.current = setInterval(() => { elapsedRef.current += 1; }, 1000);

      try {
        const extra =
          suspendedId !== "default" ? `&session_id=${encodeURIComponent(suspendedId)}` : "";
        const res = await fetch(`/api/session?resume=true${extra}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duration_days: durationDays }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 409 && data.container_gone) {
            setSuspendedSessions((prev) => prev.filter((x) => x.id !== suspendedId));
            setStatus("idle");
            clearIntervals();
            toast(data.error || "저장된 작업 파일이 없습니다. 새로 시작해주세요.", "error");
            return;
          }
          throw new Error(data.error || "세션 재시작 실패");
        }
        setSuspendedSessions((prev) => {
          const item = prev.find((x) => x.id === suspendedId);
          if (item) setActiveMeta({ project_name: item.project_name });
          return prev.filter((x) => x.id !== suspendedId);
        });
        applyData(data);
        setSessionId(data.session_id);
        startPolling(data.session_id);
        toast("이전 환경을 복원하고 있습니다…", "info");
      } catch (e) {
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "오류 발생");
        clearIntervals();
      }
    },
    [applyData, clearIntervals, startPolling, toast]
  );
```

- [ ] **Step 5: handleExtend 추가**

`handleTerminate` 함수 바로 뒤에 추가:

```typescript
  const handleExtend = useCallback(async () => {
    const sid = sessionId;
    if (!sid) return;
    try {
      const res = await fetch(`/api/session/${sid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extend_days: 3 }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || "연장에 실패했습니다.", "error");
        return;
      }
      if (typeof data.expires_at === "number") {
        setExpiresAt(data.expires_at);
        // 연장 후 새 total 계산 → extendBlocked 재계산은 다음 poll/applyData에서 처리
      }
      toast("세션이 3일 연장되었습니다.", "success");
    } catch {
      toast("연장 중 오류가 발생했습니다.", "error");
    }
  }, [sessionId, toast]);
```

- [ ] **Step 6: return에 새 값 추가**

`useSession` 훅 return 객체에 추가:

```typescript
  return {
    // ...기존 필드...
    extendBlocked,
    handleExtend,
  };
```

`SessionController` 타입이 자동으로 업데이트됨 (`ReturnType<typeof useSession>`).

---

## Task 5: WorkPage — 연장 버튼 + 40일 초과 배너

**Files:**
- Modify: `frontend/app/portal/pages/WorkPage.tsx`

**Interfaces:**
- Consumes: `ctrl.handleExtend()`, `ctrl.extendBlocked`, `ctrl.remaining`

- [ ] **Step 1: ReadyAssignment 에 연장 버튼 추가**

`WorkPage.tsx`의 `ReadyAssignment` 함수에서 `actionLine` div 바로 아래 `extendRow` 추가:

```typescript
function ReadyAssignment({
  ctrl,
  nodes,
  onTerminate,
}: {
  ctrl: SessionController;
  nodes: NodeInfo[];
  onTerminate: () => void;
}) {
  const { activeMeta, remaining, expiresAt, stats, url, extendBlocked } = ctrl;
  const timeLevel =
    remaining == null ? "normal" : remaining <= 300 ? "critical" : remaining <= 1800 ? "warning" : "normal";
  const idx = nodes.findIndex((n) => n.id === activeMeta.node_id);
  const nodeNo = idx >= 0 ? String(idx + 1).padStart(2, "0") : "PC";
  const expiryStr = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " 종료"
    : "";

  const canExtend = remaining != null && remaining <= 2 * 86400 && !extendBlocked;
  const showExtendRow = (remaining != null && remaining <= 2 * 86400) || extendBlocked;

  return (
    <div className={s.readyAssignment}>
      <div className={s.projectLine}>
        <div>
          <small>작업 이름</small>
          <h2>{activeMeta.project_name || "작업 환경"}</h2>
        </div>
        <div className={s.timeReadout} data-level={timeLevel}>
          <small>남은 시간</small>
          <strong>{remaining != null ? formatRemaining(remaining) : "—"}</strong>
          <p>{expiryStr}</p>
        </div>
      </div>

      <div className={s.machineIdentity}>
        <span>{nodeNo}</span>
        <div>
          <small>배정 장비</small>
          <strong>
            {activeMeta.node_name || "—"}
            {activeMeta.node_gpu ? ` / ${activeMeta.node_gpu}` : ""}
          </strong>
        </div>
        <p>{activeMeta.node_ip || ""}</p>
      </div>

      <div className={s.numbers}>
        <Metric label="CPU" stat={stats?.cpu_pct} unit="%" cool="blue" note={stats?.top_process || undefined} />
        <Metric label="GPU" stat={stats?.gpu_pct} unit="%" cool="green" />
        <Metric
          label="메모리"
          stat={stats?.ram_pct}
          unit="%"
          cool="green"
          note={stats?.ram_used && stats?.ram_total ? `${stats.ram_used} / ${stats.ram_total}` : undefined}
        />
        <Metric
          label="저장 공간"
          stat={stats?.storage_pct}
          unit="%"
          cool="blue"
          note={stats?.storage_total_gb != null ? `${stats?.storage_used_gb ?? 0}G / ${stats.storage_total_gb}G` : undefined}
        />
      </div>

      <div className={s.actionLine}>
        <a className={s.solidButton} href={url || "#"} target="_blank" rel="noopener noreferrer">
          데스크톱 열기 <span>↗</span>
        </a>
        <span />
        <button className={s.powerButton} aria-label="작업 종료" title="작업 종료" onClick={onTerminate}>
          <PowerIcon />
        </button>
      </div>

      {showExtendRow && !extendBlocked && (
        <div className={s.extendRow}>
          <span>세션 종료 2일 이내 · 3일 연장 가능</span>
          <button className={s.lineButton} onClick={ctrl.handleExtend} disabled={!canExtend}>
            + 3일 연장
          </button>
        </div>
      )}

      {extendBlocked && (
        <div className={s.extendBanner}>
          <span>이 세션은 총 이용 기간 40일을 초과해 연장이 제한됩니다.</span>
          <a href={`mailto:ts250024@ts.hs.kr?subject=[PC대여] 세션 연장 허가 요청`} className={s.lineButton}>
            관리자에게 연락하기
          </a>
        </div>
      )}

      <div className={s.uploadRow}>
        <UploadButton />
      </div>
    </div>
  );
}
```

---

## Task 6: SavedPage — 이어하기 클릭 시 DurationSheet 먼저

**Files:**
- Modify: `frontend/app/portal/pages/SavedPage.tsx`

**Interfaces:**
- Consumes: `ctrl.handleResume(id, duration)` (새 시그니처), `ctrl.me?.isAdmin`
- Consumes: `DurationPicker` (from RequestSheet.tsx)

- [ ] **Step 1: SavedPage.tsx 교체**

```typescript
"use client";

import { useState } from "react";
import s from "../atelier.module.css";
import { HelpTip, ConfirmSheet, Overlay, formatDateTime } from "../ui";
import { DurationPicker } from "../RequestSheet";
import type { SessionController } from "../useSession";
import type { Page } from "../PortalShell";

const ADMIN_EMAIL = "ts250024@ts.hs.kr";

export default function SavedPage({
  ctrl,
  onNavigate,
}: {
  ctrl: SessionController;
  onNavigate: (p: Page) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingResumeId, setPendingResumeId] = useState<string | null>(null);
  const [resumeDuration, setResumeDuration] = useState(7);
  const items = ctrl.suspendedSessions;
  const isAdmin = !!ctrl.me?.isAdmin;

  function openResume(id: string) {
    setResumeDuration(7);
    setPendingResumeId(id);
  }

  function confirmResume() {
    if (!pendingResumeId) return;
    ctrl.handleResume(pendingResumeId, resumeDuration);
    setPendingResumeId(null);
    onNavigate("work");
  }

  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>보관함</h1>
          <HelpTip text="종료한 작업 환경은 보관됩니다. 이어하기 시 종료 기한을 선택합니다." />
        </div>
        <span className={s.pageTitleDate}>{items.length}개 저장됨</span>
      </div>

      {items.length === 0 ? (
        <div className={s.savedEmpty}>
          보관 중인 작업이 없습니다. 세션을 종료하면 이곳에 저장됩니다.
        </div>
      ) : (
        <div className={s.savedCards}>
          {items.map((item, index) => {
            const blocked = !!item.extend_blocked;
            return (
              <article className={s.savedCard} key={item.id}>
                <header className={s.savedCardHead}>
                  <span className={s.savedIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h2>{item.project_name || "저장된 세션"}</h2>
                    <p>{item.saved_at ? `${formatDateTime(item.saved_at)} 저장` : "저장됨"}</p>
                  </div>
                </header>
                <dl className={s.savedCardMeta}>
                  <div>
                    <dt>환경</dt>
                    <dd>{specSummary(item.resources)}</dd>
                  </div>
                  <div>
                    <dt>저장 용량</dt>
                    <dd>
                      {item.resources?.storage_used_gb != null
                        ? `${item.resources.storage_used_gb}/${item.resources.storage_gb ?? "—"}GB`
                        : item.resources?.storage_gb
                        ? `—/${item.resources.storage_gb}GB`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>자동 삭제</dt>
                    <dd>{item.delete_after ? formatDateTime(item.delete_after) : "—"}</dd>
                  </div>
                </dl>
                <footer className={s.savedCardFoot}>
                  {blocked ? (
                    <>
                      <a
                        href={`mailto:${ADMIN_EMAIL}?subject=[PC대여] 세션 재개 허가 요청`}
                        className={s.lineButton}
                      >
                        관리자에게 연락하기
                      </a>
                      <span style={{ fontSize: "9px", color: "var(--faint)", alignSelf: "center" }}>
                        총 이용 40일 초과
                      </span>
                    </>
                  ) : (
                    <>
                      <button className={s.solidButton} onClick={() => openResume(item.id)}>
                        이어하기
                      </button>
                      <button className={s.quietButton} onClick={() => setPendingDelete(item.id)}>
                        삭제
                      </button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {/* Duration 선택 시트 */}
      {pendingResumeId && (
        <Overlay>
          <section className={`${s.uploadSheet} ${s.durationSheet}`}>
            <header>
              <div>
                <span>이어하기</span>
                <h2>종료 기한 선택</h2>
              </div>
              <button onClick={() => setPendingResumeId(null)}>닫기</button>
            </header>
            <div className={s.formMain} style={{ padding: "24px" }}>
              <p style={{ margin: "0 0 16px", color: "var(--dim)", fontSize: "13px" }}>
                이어서 사용할 기간을 선택하세요. 이전 세션 생성 시점부터 총 40일을 초과할 수 없습니다.
              </p>
              <DurationPicker value={resumeDuration} onChange={setResumeDuration} isAdmin={isAdmin} />
            </div>
            <footer>
              <span style={{ flex: 1 }} />
              <button className={s.lineButton} onClick={() => setPendingResumeId(null)}>취소</button>
              <button
                className={s.solidButton}
                disabled={resumeDuration === -1}
                onClick={confirmResume}
              >
                이어하기
              </button>
            </footer>
          </section>
        </Overlay>
      )}

      {pendingDelete && (
        <ConfirmSheet
          title="파일 완전히 제거"
          message="저장된 세션의 모든 파일과 설치된 패키지가 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
          confirmLabel="영구 삭제"
          danger
          onConfirm={() => { ctrl.handlePermanentDelete(pendingDelete); setPendingDelete(null); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function specSummary(r?: { cpu_cores?: number; ram_gb?: number; gpu?: string }) {
  if (!r) return "—";
  const parts = [r.gpu, r.cpu_cores ? `${r.cpu_cores} Core` : null, r.ram_gb ? `${r.ram_gb}GB` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}
```

---

## Task 7: AdminArea — 대리 신청 폼 + 40일 초과 허가 UI

**Files:**
- Modify: `frontend/app/portal/admin/AdminArea.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/sessions` (behalf_of 세션 생성)
- Consumes: `PATCH /api/admin/sessions?session_id=X` body `{extend_unlocked: true}`
- Consumes: `AdminSession.extend_blocked`, `AdminSession.original_created_at`

- [ ] **Step 1: AdminSession 인터페이스 확장**

`AdminArea.tsx` 상단의 `AdminSession` 인터페이스 수정:

```typescript
interface AdminSession {
  id: string;
  owner?: string;
  project_name?: string;
  node_id?: string;
  node_name?: string;
  status?: string;
  expires_at?: number;
  suspended_at?: number;
  original_created_at?: number;
  extend_blocked?: boolean;
  extend_unlocked?: boolean;
}
```

- [ ] **Step 2: state 추가 + 대리 신청 state**

`AdminArea` 컴포넌트 상단 state 선언부에 추가:

```typescript
  const [behalfEmail, setBehalfEmail] = useState("");
  const [behalfProject, setBehalfProject] = useState("");
  const [behalfDuration, setBehalfDuration] = useState(7);
  const [behalfNodeId, setBehalfNodeId] = useState("");
  const [adminNodes2, setAdminNodes2] = useState<{ id: string; name?: string }[]>([]);
```

- [ ] **Step 3: 노드 목록 로드 + unlockExtend 함수**

`loadSessions` 콜백 바로 뒤에 추가:

```typescript
  const loadAdminNodes2 = useCallback(async () => {
    try {
      const r = await fetch("/api/nodes");
      if (r.ok) {
        const d = await r.json();
        setAdminNodes2((d.nodes || []).map((n: { id: string; name?: string }) => ({ id: n.id, name: n.name })));
      }
    } catch {}
  }, []);
```

`useEffect` 내에서 `loadAdminNodes2()` 호출 추가:

```typescript
  useEffect(() => {
    loadStatus();
    loadNodes();
    loadUsers();
    loadSessions();
    loadContainers();
    loadLog();
    loadAdminNodes2();
    // ...fetch notice...
    const iv = setInterval(() => { loadStatus(); loadNodes(); }, 4000);
    return () => clearInterval(iv);
  }, [loadStatus, loadNodes, loadUsers, loadSessions, loadContainers, loadLog, loadAdminNodes2]);
```

`saveNotice` 함수 뒤에 `unlockExtend` + `createBehalfSession` 함수 추가:

```typescript
  async function unlockExtend(sessionId: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/sessions?session_id=${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extend_unlocked: true }),
      });
      if (r.ok) {
        toast("연장 허가 완료", "success");
        loadSessions();
      } else {
        const d = await r.json().catch(() => ({}));
        toast(d.error || "허가 실패", "error");
      }
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createBehalfSession() {
    if (!behalfEmail.trim() || !behalfProject.trim()) {
      toast("이메일과 작업 이름을 입력하세요.", "error");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          behalf_of: behalfEmail.trim().toLowerCase(),
          project_name: behalfProject.trim(),
          duration_days: behalfDuration,
          node_id: behalfNodeId || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        toast(`${behalfEmail}의 세션을 생성했습니다.`, "success");
        setBehalfEmail("");
        setBehalfProject("");
        setBehalfDuration(7);
        setBehalfNodeId("");
        loadSessions();
      } else {
        toast(d.error || "생성 실패", "error");
      }
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 4: session 탭 UI 수정 — 40일 초과 허가 + 대리 신청**

`tab === "session"` 분기의 `AdminTable` 내부에서 컬럼 헤더에 `"허가"` 추가하고, 각 행에 허가 버튼 추가:

```typescript
      {tab === "session" && (
        <>
          <AdminTable title="세션 관리" headers={["작업", "사용자", "장비", "상태", "만료", ""]}>
            {sessions.filter((se) => se.status !== "suspended").length === 0 ? (
              <div className={s.adminRow}>
                <span><strong>활성 세션이 없습니다.</strong></span>
              </div>
            ) : (
              sessions
                .filter((se) => se.status !== "suspended")
                .map((se) => (
                  <div className={s.adminRow} key={se.id}>
                    <span>
                      <strong>{se.project_name || "세션"}</strong>
                      {se.extend_blocked && (
                        <small style={{ color: "#d8b365", marginLeft: "6px" }}>40일 초과</small>
                      )}
                    </span>
                    <span>{se.owner || "—"}</span>
                    <span>{se.node_name || se.node_id || "—"}</span>
                    <span>{sessionStatusLabel(se.status)}</span>
                    <span>{formatDateTime(se.expires_at)}</span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {se.extend_blocked && !se.extend_unlocked && (
                        <button
                          onClick={() => unlockExtend(se.id)}
                          disabled={busy}
                          style={{ color: "#a78bfa" }}
                        >
                          연장 허가
                        </button>
                      )}
                      <button
                        onClick={() => setTerminateConfirmId(se.id)}
                        disabled={busy}
                        style={{ color: "#e53e3e" }}
                      >
                        강제 종료
                      </button>
                    </div>
                  </div>
                ))
            )}
          </AdminTable>

          {/* 대리 신청 폼 */}
          <section className={s.opsSheet} style={{ marginTop: "14px", padding: "20px 22px" }}>
            <div className={s.blockHeading}>
              <h2>대리 세션 신청</h2>
            </div>
            <p style={{ margin: "0 0 16px", color: "var(--faint)", fontSize: "12px" }}>
              관리자가 특정 학생 계정으로 세션을 개설합니다.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <Field label="학생 이메일 (@ts.hs.kr)">
                <input
                  value={behalfEmail}
                  onChange={(e) => setBehalfEmail(e.target.value)}
                  placeholder="ts250000@ts.hs.kr"
                />
              </Field>
              <Field label="작업 이름">
                <input
                  value={behalfProject}
                  onChange={(e) => setBehalfProject(e.target.value)}
                  placeholder="프로젝트명"
                />
              </Field>
              <Field label="유지 기간 (일, 0=무한)">
                <input
                  type="number"
                  min={1}
                  max={999}
                  value={behalfDuration}
                  onChange={(e) => setBehalfDuration(Number(e.target.value))}
                />
              </Field>
              <Field label="노드 ID (선택)">
                <select value={behalfNodeId} onChange={(e) => setBehalfNodeId(e.target.value)}>
                  <option value="">자동 배정</option>
                  {adminNodes2.map((n) => (
                    <option key={n.id} value={n.id}>{n.name || n.id}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ marginTop: "14px" }}>
              <button className={s.solidButton} onClick={createBehalfSession} disabled={busy}>
                대리 신청
              </button>
            </div>
          </section>

          {terminateConfirmId && (
            <div className={s.overlay}>
              <section className={s.uploadSheet} style={{ width: "min(440px, 94vw)" }}>
                <header>
                  <div><h2>세션 강제 종료</h2></div>
                  <button onClick={() => setTerminateConfirmId(null)}>닫기</button>
                </header>
                <p style={{ margin: "22px 24px", lineHeight: 1.6 }}>
                  이 세션을 강제로 종료합니다. 저장되지 않은 작업이 손실될 수 있습니다.
                </p>
                <footer>
                  <span style={{ flex: 1 }} />
                  <button className={s.lineButton} onClick={() => setTerminateConfirmId(null)}>취소</button>
                  <button
                    className={s.solidButton}
                    style={{ color: "#e53e3e" }}
                    onClick={() => { doAction("terminate", "세션 강제 종료"); setTerminateConfirmId(null); }}
                  >
                    강제 종료
                  </button>
                </footer>
              </section>
            </div>
          )}
        </>
      )}
```

---

## Task 8: 통합 검증 + hub 서버에 배포

**Files:**
- `hub/main.py` (배포)
- `frontend/` (로컬 개발 서버 확인)

- [ ] **Step 1: hub 배포**

```bash
# 로컬에서 push 후
git push origin main

# 허브 서버에서 pull + restart
ssh admin-swai@100.79.232.71
cd ~/hub && git pull && sudo systemctl restart hub
sudo systemctl status hub
```

- [ ] **Step 2: 프론트엔드 로컬 실행**

```bash
cd /Users/shinmingyu/Project/server_connection/frontend
npm run dev
```

브라우저 http://localhost:3000 접속.

- [ ] **Step 3: 기능 확인 체크리스트**

| 항목 | 확인 방법 |
|------|-----------|
| 1. 유지 기간 1~28일 선택 | RequestSheet 열기 → 28개 버튼 확인 |
| 2. 28+ 선택 → 관리자 안내 표시, 제출 비활성화 | 28+ 클릭 → 노란 안내문 + 배정 요청 버튼 비활성 |
| 3. 관리자 로그인 시 ∞ 무한 옵션 표시 | 관리자 계정으로 로그인 → 무한 버튼 확인 |
| 4. 연장 버튼: 2일 이내에만 활성화 | 세션 남은 시간 2일 이하 시 연장 버튼 표시 |
| 5. 연장 클릭 → 3일 추가, 버튼 비활성화 | 연장 후 남은 시간 증가 확인 |
| 6. 40일 초과 세션 → 관리자 연락 배너 | hub에서 expires_at 수동 조작으로 테스트 |
| 7. 관리자 admin 페이지 → 연장 허가 버튼 | 40일 초과 세션 행에 "연장 허가" 버튼 확인 |
| 8. 보관함 이어하기 → duration sheet 표시 | 이어하기 클릭 → 기간 선택 오버레이 확인 |
| 9. 대리 신청 폼 동작 | 관리자 admin → 세션 탭 → 대리 신청 폼 입력 후 신청 |

- [ ] **Step 4: 커밋**

```bash
cd /Users/shinmingyu/Project/server_connection
git add hub/main.py \
  frontend/app/api/session/[id]/route.ts \
  frontend/app/api/admin/sessions/route.ts \
  frontend/app/portal/RequestSheet.tsx \
  frontend/app/portal/useSession.ts \
  frontend/app/portal/pages/WorkPage.tsx \
  frontend/app/portal/pages/SavedPage.tsx \
  frontend/app/portal/PortalShell.tsx \
  frontend/app/portal/admin/AdminArea.tsx \
  frontend/app/portal/atelier.module.css
git commit -m "feat: 세션 유지기간 1~28일·연장·40일제한·대리신청 구현"
```
