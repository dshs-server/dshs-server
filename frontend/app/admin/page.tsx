"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ToastProvider, useToast } from "@/components/toast";

interface AdminStatus {
  active: {
    owner?: string;
    since?: number;
    expires_at?: number;
    url?: string;
    status?: string;
  } | null;
  queue: string[];
}

interface AdminUser {
  email: string;
  max_sessions: number;
  active_sessions?: number;
}

interface NodeStatus {
  id: string;
  name?: string;
  status: "idle" | "in_use" | "offline";
  project_name?: string;
  owner?: string;
  cpu_usage?: number;
  gpu_usage?: number;
  ram_used_gb?: number;
  ram_total_gb?: number;
  storage_used_gb?: number;
  storage_total_gb?: number;
  top_process?: string;
}

function fmtTime(epoch?: number) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function usageColor(pct: number) {
  if (pct >= 80) return "var(--danger)";
  if (pct >= 60) return "var(--warning)";
  return "var(--success)";
}

/* ─── PC 모니터링 타일 ─── */
function NodeTile({ node }: { node: NodeStatus }) {
  const statusMap = {
    idle:    { dot: "dot-success", label: "사용 가능" },
    in_use:  { dot: "dot-warning dot-pulse", label: "사용 중" },
    offline: { dot: "dot-idle", label: "오프라인" },
  };
  const st = statusMap[node.status] ?? statusMap.idle;

  const cpu  = node.cpu_usage  ?? 0;
  const gpu  = node.gpu_usage  ?? 0;
  const ramPct = node.ram_total_gb
    ? Math.round(((node.ram_used_gb ?? 0) / node.ram_total_gb) * 100)
    : 0;
  const storagePct = node.storage_total_gb
    ? Math.round(((node.storage_used_gb ?? 0) / node.storage_total_gb) * 100)
    : 0;

  return (
    <div
      className="glass"
      style={{
        padding: "16px",
        borderRadius: "16px",
        opacity: node.status === "offline" ? 0.55 : 1,
        transition: "opacity 0.3s",
      }}
    >
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
        <span style={{ fontWeight: 800, fontSize: "14px" }}>{node.name || node.id}</span>
        <span className="badge" style={{ fontSize: "11px", padding: "3px 8px" }}>
          <span className={`dot ${st.dot}`} />
          {st.label}
        </span>
      </div>

      {/* 프로젝트 / 사용자 */}
      <div style={{ minHeight: "32px", marginBottom: "12px" }}>
        {node.project_name ? (
          <>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--accent)", marginBottom: "2px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {node.project_name}
            </div>
            {node.owner && (
              <div style={{ fontSize: "11px", color: "var(--text-faint)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {node.owner}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: "12px", color: "var(--text-faint)" }}>—</div>
        )}
      </div>

      {/* 사용률 바 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
        <UsageBar label="CPU" pct={cpu} text={`${cpu.toFixed(0)}%`} />
        <UsageBar label="GPU" pct={gpu} text={`${gpu.toFixed(0)}%`} />
        <UsageBar
          label="RAM"
          pct={ramPct}
          text={node.ram_total_gb ? `${(node.ram_used_gb ?? 0).toFixed(0)}/${node.ram_total_gb}GB` : `${ramPct}%`}
        />
        <UsageBar
          label="저장"
          pct={storagePct}
          text={node.storage_total_gb ? `${(node.storage_used_gb ?? 0).toFixed(0)}/${node.storage_total_gb}GB` : `${storagePct}%`}
        />
      </div>

      {/* 상위 프로세스 */}
      {node.top_process && (
        <div style={{ marginTop: "10px", padding: "6px 9px", borderRadius: "8px", background: "rgba(255,255,255,0.05)", fontSize: "11.5px" }}>
          <span style={{ color: "var(--text-faint)" }}>상위 프로세스 </span>
          <span style={{ fontWeight: 700, fontFamily: "monospace" }}>{node.top_process}</span>
        </div>
      )}
    </div>
  );
}

function UsageBar({ label, pct, text }: { label: string; pct: number; text: string }) {
  const color = usageColor(pct);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px" }}>
        <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>{label}</span>
        <span style={{ fontSize: "11px", color, fontWeight: 600 }}>{text}</span>
      </div>
      <div style={{ height: "4px", borderRadius: "999px", background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, borderRadius: "999px", transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

/* ─── 메인 패널 ─── */
function AdminPanel() {
  const router = useRouter();
  const { toast } = useToast();

  const [data, setData] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [editingUser, setEditingUser] = useState<{ email: string; value: string } | null>(null);
  const [nodes, setNodes] = useState<NodeStatus[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin");
      if (r.status === 403) {
        router.push("/dashboard");
        return;
      }
      const d = await r.json();
      if (r.ok) setData(d);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [router]);

  const loadNodes = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/nodes");
      if (r.ok) {
        const d = await r.json();
        setNodes(d.nodes || []);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/users");
      if (r.ok) {
        const d = await r.json();
        setUsers(d.users || []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    load();
    loadNodes();
    loadUsers();
    fetch("/api/notice")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.notice && setNotice(d.notice))
      .catch(() => {});

    const ivSession = setInterval(load, 5000);
    const ivNodes   = setInterval(loadNodes, 3000);
    return () => { clearInterval(ivSession); clearInterval(ivNodes); };
  }, [load, loadNodes, loadUsers]);

  async function doAction(action: string, label: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (r.ok) { toast(`${label} 완료`, "success"); load(); }
      else        toast(`${label} 실패`, "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveNotice() {
    setBusy(true);
    try {
      const r = await fetch("/api/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notice }),
      });
      toast(r.ok ? "공지를 저장했습니다." : "공지 저장 실패", r.ok ? "success" : "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateUserLimit(email: string, max_sessions: number) {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, max_sessions }),
      });
      if (r.ok) { toast("저장했습니다.", "success"); setEditingUser(null); loadUsers(); }
      else        toast("저장 실패", "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

  const inUse  = nodes.filter((n) => n.status === "in_use").length;
  const idle   = nodes.filter((n) => n.status === "idle").length;

  return (
    <div className="page">
      <header style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={brandBadge}>🛠️</span>
          <span style={{ fontWeight: 800, fontSize: "16px" }}>관리자 패널</span>
        </div>
        <a href="/dashboard" className="btn btn-ghost" style={{ padding: "7px 13px", fontSize: "13px" }}>
          대시보드로
        </a>
      </header>

      <main style={mainWrap}>

        {/* ── PC 모니터링 ── */}
        <section className="glass glass-strong fade-in" style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
            <h3 style={{ ...h3, margin: 0 }}>PC 모니터링</h3>
            <div style={{ display: "flex", gap: "10px" }}>
              <span className="badge"><span className="dot dot-warning dot-pulse" />{inUse}대 사용 중</span>
              <span className="badge"><span className="dot dot-success" />{idle}대 사용 가능</span>
            </div>
          </div>

          {nodes.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: "13px", padding: "20px 0", textAlign: "center" }}>
              {loading ? (
                <div style={{ display: "flex", gap: "10px", alignItems: "center", justifyContent: "center" }}>
                  <span className="spinner" /> 불러오는 중…
                </div>
              ) : (
                "백엔드에서 노드 정보를 조회하지 못했습니다. GET /admin/nodes 구현 후 표시됩니다."
              )}
            </div>
          ) : (
            <div style={nodeGrid}>
              {nodes.map((n) => <NodeTile key={n.id} node={n} />)}
            </div>
          )}
        </section>

        {/* 좁은 섹션들 */}
        <div style={narrowWrap}>
          {/* 현재 세션 */}
          <section className="glass glass-strong fade-in" style={card}>
            <h3 style={h3}>현재 세션</h3>
            {loading ? (
              <div style={{ display: "flex", gap: "10px", alignItems: "center", color: "var(--text-dim)" }}>
                <span className="spinner" /> 불러오는 중…
              </div>
            ) : data?.active ? (
              <div>
                <div style={rowGrid}>
                  <Info label="사용자"    value={data.active.owner  || "—"} />
                  <Info label="상태"      value={data.active.status || "ready"} />
                  <Info label="시작"      value={fmtTime(data.active.since)} />
                  <Info label="만료 예정" value={fmtTime(data.active.expires_at)} />
                </div>
                <button className="btn btn-danger" style={{ marginTop: "16px" }} disabled={busy}
                  onClick={() => doAction("terminate", "세션 강제 종료")}>
                  세션 강제 종료
                </button>
              </div>
            ) : (
              <p style={{ color: "var(--text-dim)", margin: 0 }}>현재 활성 세션이 없습니다.</p>
            )}
          </section>

          {/* 대기열 */}
          <section className="glass glass-strong fade-in" style={card}>
            <h3 style={h3}>대기열 {data?.queue?.length ? `(${data.queue.length})` : ""}</h3>
            {data?.queue?.length ? (
              <ol style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.9 }}>
                {data.queue.map((e, i) => (
                  <li key={i} style={{ color: "var(--text-dim)", fontSize: "13px" }}>{e}</li>
                ))}
              </ol>
            ) : (
              <p style={{ color: "var(--text-dim)", margin: 0 }}>대기 중인 학생이 없습니다.</p>
            )}
          </section>

          {/* 공지 */}
          <section className="glass glass-strong fade-in" style={card}>
            <h3 style={h3}>공지사항</h3>
            <textarea className="input" value={notice} onChange={(e) => setNotice(e.target.value)}
              placeholder="학생에게 표시할 공지를 입력하세요. (비우면 배너 숨김)"
              rows={3} style={{ resize: "vertical", marginBottom: "12px" }} />
            <button className="btn btn-primary" disabled={busy} onClick={saveNotice}>공지 저장</button>
          </section>

          {/* 유지보수 */}
          <section className="glass glass-strong fade-in" style={card}>
            <h3 style={h3}>유지보수</h3>
            <button className="btn btn-ghost" disabled={busy}
              onClick={() => doAction("cleanup", "중단 컨테이너 정리")}>
              중단된 컨테이너 정리
            </button>
          </section>

          {/* 사용자 관리 */}
          <section className="glass glass-strong fade-in" style={card}>
            <h3 style={h3}>사용자 관리</h3>
            <p style={{ color: "var(--text-dim)", fontSize: "13px", margin: "0 0 16px" }}>
              사용자별 최대 활성 PC 수. 기본값 1대.
            </p>
            {users.length === 0 ? (
              <p style={{ color: "var(--text-dim)", margin: 0, fontSize: "13px" }}>
                등록된 사용자가 없습니다. 백엔드 GET /admin/users 구현 후 표시됩니다.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {users.map((u) => (
                  <div key={u.email} className="glass"
                    style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <span style={{ flex: 1, fontSize: "13px", wordBreak: "break-all" }}>{u.email}</span>
                    {u.active_sessions !== undefined && (
                      <span style={{ fontSize: "12px", color: "var(--text-faint)", flexShrink: 0 }}>
                        활성 {u.active_sessions}대
                      </span>
                    )}
                    {editingUser?.email === u.email ? (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
                        <input type="number" min={1} max={10} value={editingUser.value}
                          onChange={(e) => setEditingUser({ email: u.email, value: e.target.value })}
                          style={{ width: "60px", padding: "6px 8px", borderRadius: "8px", background: "rgba(255,255,255,0.08)", border: "1px solid var(--glass-border)", color: "var(--text)", fontSize: "13px", textAlign: "center" }} />
                        <button className="btn btn-primary" style={{ padding: "6px 12px", fontSize: "12px" }}
                          disabled={busy} onClick={() => updateUserLimit(u.email, Number(editingUser.value))}>
                          저장
                        </button>
                        <button className="btn btn-ghost" style={{ padding: "6px 10px", fontSize: "12px" }}
                          onClick={() => setEditingUser(null)}>취소</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: "13px", fontWeight: 700 }}>최대 {u.max_sessions}대</span>
                        <button className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: "12px" }}
                          onClick={() => setEditingUser({ email: u.email, value: String(u.max_sessions) })}>변경</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

/* ─── 공통 컴포넌트 ─── */
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass" style={{ padding: "12px 14px" }}>
      <div style={{ color: "var(--text-faint)", fontSize: "12px", marginBottom: "3px" }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: "14px", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

/* ─── 스타일 ─── */
const headerStyle: React.CSSProperties = {
  position: "sticky", top: 0, zIndex: 50,
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "0 22px", height: "62px",
  background: "rgba(11, 16, 49, 0.55)",
  borderBottom: "1px solid var(--glass-border)",
  backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
};
const brandBadge: React.CSSProperties = {
  width: "32px", height: "32px", borderRadius: "10px",
  display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px",
  background: "linear-gradient(135deg, rgba(124,140,255,0.35), rgba(99,102,241,0.18))",
  border: "1px solid var(--glass-border-strong)",
};
const mainWrap: React.CSSProperties = {
  maxWidth: "1280px", margin: "0 auto", padding: "28px 20px 60px",
  display: "flex", flexDirection: "column", gap: "16px",
};
const narrowWrap: React.CSSProperties = {
  maxWidth: "640px", display: "flex", flexDirection: "column", gap: "16px",
};
const card: React.CSSProperties = { padding: "24px" };
const h3: React.CSSProperties = { margin: "0 0 16px", fontSize: "16px", fontWeight: 700 };
const rowGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" };
const nodeGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
  gap: "12px",
};

export default function AdminPage() {
  return (
    <ToastProvider>
      <AdminPanel />
    </ToastProvider>
  );
}
