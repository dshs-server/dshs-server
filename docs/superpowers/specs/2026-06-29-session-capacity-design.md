# Session Capacity Policy — Design Spec

**Date:** 2026-06-29  
**Status:** Approved

## Problem

Currently a node is binary: "available" (0 sessions) or "unavailable" (≥1 active session).  
Users can't see node load. No per-node session cap exists.

## Goals

1. Max **2 active sessions per node** simultaneously.
2. Two sessions combined must not exceed **90% of node CPU and RAM** (declared resources).
3. RequestSheet shows **load bar + session count** per PC at a glance.

## Out of Scope

- GPU resource splitting (GPU is always `--gpus all`; only session count limits GPU access).
- Docker-level resource enforcement (`--cpus`, `--memory` flags — not added here).
- Queue system for full nodes.

## Backend Changes (`hub/main.py`)

### `_node_session_state()` — extend states

| Return value | Meaning |
|---|---|
| `"none"` | 0 active/starting sessions |
| `"partial"` | 1 active/starting session (accepts 1 more) |
| `"full"` | 2 active/starting sessions (rejects new) |
| `"suspended"` | 0 active, ≥1 suspended |

### `/nodes` response — 3 new fields

```json
{
  "session_count": 1,
  "resource_used": {"cpu_cores": 8, "ram_gb": 16},
  "load": {"cpu_pct": 34.2, "ram_pct": 51.0, "gpu_pct": 12.0}
}
```

- `session_count`: count of active/starting sessions on this node  
- `resource_used`: sum of `resources.cpu_cores` and `resources.ram_gb` from active sessions  
- `load`: from `_metrics` (10s SSH cache). `null` values if node offline.  
- `available`: `session_count < 2` (was `state != "active"`)

### `POST /session` — capacity validation

Before docker run, after node selection:

```
if session_count >= 2:
    → 503 "해당 PC가 꽉 찼습니다."
if (used_cpu + req_cpu) / node_cpu > 0.9:
    → 503 "CPU 용량 초과 (90% 제한)"
if (used_ram + req_ram) / node_ram > 0.9:
    → 503 "메모리 용량 초과 (90% 제한)"
```

`req_cpu`, `req_ram` come from `body.resources` (already sent by frontend).

### Auto node selection — skip over-capacity nodes

When `node_id` not specified, skip nodes where:
- `session_count >= 2`, OR
- adding requested resources would exceed 90%

Then pick least-loaded remaining node.

## Frontend Changes

### `NodeInfo` — 3 new optional fields

```ts
session_count?: number;
resource_used?: { cpu_cores: number; ram_gb: number };
load?: { cpu_pct: number | null; ram_pct: number | null; gpu_pct: number | null };
```

### `nodeState()` — add "partial"

```
"partial" → 1 session, still selectable
"full"    → maps to "active" behavior (not selectable)
```

### `meets()` in `RequestSheet` — add resource headroom check

```ts
&& (node.resource_used == null || node.cpu_cores == null ||
    (node.resource_used.cpu_cores + cpu) / node.cpu_cores <= 0.9)
&& (node.resource_used == null ||
    (node.resource_used.ram_gb + ram) / node.ram_gb <= 0.9)
```

### `SelectMachine` — load bar + user count

Each node card adds:
- **Load bar**: `load.cpu_pct` (green <50%, yellow <80%, red ≥80%). Hidden if `null`.
- **User count text**: "비어 있음" | "1명 사용 중" | "2명 사용 중 (만석)"

State label:
- `"available"` → "선택 가능"
- `"partial"` → "선택 가능" (+ load bar shows 1 user)
- `"active"` / `"full"` → "사용 중 (2/2)"
- `"suspended"` → "일시중지"
- spec mismatch → "사양 부족"

## Success Criteria

| Test | Expected |
|---|---|
| Node has 2 active sessions; POST /session to same node | 503 "해당 PC가 꽉 찼습니다." |
| Node 8-core/32GB; session1 requests 8cpu+16GB; session2 requests 1cpu+14GB → 90% RAM check | 8+16=24/32=75% ✓; but 16+14=30/32=93.75% → 503 |
| RequestSheet opened; node with 1 active session | Load bar shows cpu%, label "1명 사용 중", still selectable |
| Node with 2 sessions | "2명 사용 중 (만석)", disabled |
| Node offline (_metrics empty) | Load bar hidden, session_count still shows |
