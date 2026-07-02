"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import s from "../atelier.module.css";
import { HelpTip, Field, formatDateTime } from "../ui";
import { useToast } from "@/components/toast";

type AdminTab = "status" | "session" | "people" | "notice" | "clean" | "security" | "log";

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
  uptime_seconds?: number;
}

interface AdminStatusData {
  active: { owner?: string; since?: number; expires_at?: number; status?: string } | null;
  queue: string[];
}

interface AdminUser {
  email: string;
  max_sessions: number;
  active_sessions?: number;
  blocked?: boolean;
  is_admin?: boolean;
}

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

interface StoppedContainer {
  name: string;
  status: string;
  finished_at?: string | null;
  is_saved_session: boolean;
}

interface SecurityAlertFile {
  path: string;
  size: number;
  mtime: number;
  reason: string;
  severity: "high" | "critical";
}

interface SecurityAlert {
  id: string;
  created_at: number;
  session_id: string;
  owner?: string;
  project_name?: string;
  node_id?: string;
  node_name?: string;
  severity: "high" | "critical";
  files: SecurityAlertFile[];
  has_screenshot: boolean;
  acknowledged: boolean;
}

const TABS: { key: AdminTab; label: string }[] = [
  { key: "status", label: "운영 현황" },
  { key: "session", label: "세션" },
  { key: "people", label: "사용자" },
  { key: "notice", label: "공지" },
  { key: "clean", label: "정리" },
  { key: "security", label: "보안 경고" },
  { key: "log", label: "로그" },
];

export default function AdminArea() {
  const { toast } = useToast();
  const [tab, setTab] = useState<AdminTab>("status");
  const [status, setStatus] = useState<AdminStatusData | null>(null);
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [nodesUpdatedAt, setNodesUpdatedAt] = useState<number | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [containers, setContainers] = useState<StoppedContainer[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingContainer, setDeletingContainer] = useState<string | null>(null);
  const [containersLoading, setContainersLoading] = useState(false);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [logDate, setLogDate] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityScanEnabled, setSecurityScanEnabled] = useState(true);
  const [terminateConfirmId, setTerminateConfirmId] = useState<string | null>(null);
  const [behalfEmail, setBehalfEmail] = useState("");
  const [behalfProject, setBehalfProject] = useState("");
  const [behalfDuration, setBehalfDuration] = useState(7);
  const [behalfNodeId, setBehalfNodeId] = useState("");
  const [adminNodes2, setAdminNodes2] = useState<{ id: string; name?: string }[]>([]);
  const [terminateUserEmail, setTerminateUserEmail] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/admin");
      if (r.ok) setStatus(await r.json());
    } catch {}
  }, []);
  const loadNodes = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/nodes");
      if (r.ok) {
        const d = await r.json();
        setNodes(d.nodes || []);
        if (d.collected_at) setNodesUpdatedAt(d.collected_at);
      }
    } catch {}
  }, []);
  const loadUsers = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/users");
      if (r.ok) setUsers((await r.json()).users || []);
    } catch {}
  }, []);
  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/sessions");
      if (r.ok) setSessions((await r.json()).sessions || []);
    } catch {}
  }, []);
  const loadContainers = useCallback(async () => {
    setContainersLoading(true);
    try {
      const r = await fetch("/api/admin/containers");
      if (r.ok) setContainers((await r.json()).containers || []);
    } catch {
    } finally {
      setContainersLoading(false);
    }
  }, []);
  const loadAdminNodes2 = useCallback(async () => {
    try {
      const r = await fetch("/api/nodes");
      if (r.ok) {
        const d = await r.json();
        setAdminNodes2((d.nodes || []).map((n: { id: string; name?: string }) => ({ id: n.id, name: n.name })));
      }
    } catch {}
  }, []);
  const loadLog = useCallback(async (date?: string) => {
    setLogLoading(true);
    try {
      const url = date ? `/api/admin/log?date=${encodeURIComponent(date)}` : "/api/admin/log";
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        setLogContent(d.content ?? null);
        setLogDate(d.date ?? "");
      }
    } catch {
    } finally {
      setLogLoading(false);
    }
  }, []);
  const loadSecurityAlerts = useCallback(async () => {
    setSecurityLoading(true);
    try {
      const r = await fetch("/api/admin/security-alerts");
      if (r.ok) {
        const d = await r.json();
        setSecurityAlerts(d.alerts || []);
        setSecurityScanEnabled(d.scan_enabled !== false);
      }
    } catch {
    } finally {
      setSecurityLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadNodes();
    loadUsers();
    loadSessions();
    loadContainers();
    loadLog();
    loadSecurityAlerts();
    loadAdminNodes2();
    fetch("/api/notice")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.notice && setNotice(d.notice))
      .catch(() => {});
    const iv = setInterval(() => {
      loadStatus();
      loadNodes();
    }, 4000);
    return () => clearInterval(iv);
  }, [loadStatus, loadNodes, loadUsers, loadSessions, loadContainers, loadLog, loadSecurityAlerts, loadAdminNodes2]);

  async function doAction(action: string, label: string) {
    setBusy(true);
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (r.ok) {
        toast(`${label} 완료`, "success");
        loadStatus();
        loadNodes();
        loadSessions();
      } else toast(`${label} 실패`, "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

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
      if (r.ok) {
        toast("저장했습니다.", "success");
        loadUsers();
      } else toast("저장 실패", "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

  async function patchUser(email: string, fields: Partial<Pick<AdminUser, "blocked" | "is_admin">>) {
    setBusy(true);
    try {
      const r = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ...fields }),
      });
      if (r.ok) {
        toast("저장했습니다.", "success");
        loadUsers();
      } else toast("저장 실패", "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setBusy(false);
    }
  }

  async function terminateUserSessions(email: string) {
    const targets = sessions.filter((se) => se.owner === email && se.status !== "suspended");
    if (!targets.length) return;
    setBusy(true);
    try {
      await Promise.all(
        targets.map((se) =>
          fetch(`/api/admin/sessions?session_id=${encodeURIComponent(se.id)}`, { method: "DELETE" })
        )
      );
      toast(`${email}의 세션 ${targets.length}개를 종료했습니다.`, "success");
      loadSessions();
      loadUsers();
    } catch {
      toast("종료 실패", "error");
    } finally {
      setBusy(false);
    }
    setTerminateUserEmail(null);
  }

  async function deleteContainer(name: string) {
    setDeletingContainer(name);
    try {
      const r = await fetch(`/api/admin/containers/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (r.ok) {
        toast(`${name} 삭제 완료`, "success");
        setContainers((prev) => prev.filter((c) => c.name !== name));
      } else toast("삭제 실패", "error");
    } catch {
      toast("백엔드 연결 실패", "error");
    } finally {
      setDeletingContainer(null);
    }
  }

  async function acknowledgeSecurityAlert(id: string) {
    try {
      const r = await fetch(`/api/admin/security-alerts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      });
      if (!r.ok) throw new Error();
      setSecurityAlerts((prev) =>
        prev.map((alert) => (alert.id === id ? { ...alert, acknowledged: true } : alert))
      );
      toast("보안 경고를 확인 처리했습니다.", "success");
    } catch {
      toast("확인 처리에 실패했습니다.", "error");
    }
  }

  const online = nodes.filter((n) => n.status !== "offline").length;
  const inUse = nodes.filter((n) => n.status === "in_use").length;
  const avgStorage =
    nodes.length === 0
      ? 0
      : Math.round(
          nodes.reduce(
            (a, n) => a + (n.storage_total_gb ? ((n.storage_used_gb ?? 0) / n.storage_total_gb) * 100 : 0),
            0
          ) / nodes.length
        );
  const unacknowledgedAlerts = securityAlerts.filter((alert) => !alert.acknowledged).length;

  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>관리</h1>
          <HelpTip text="장비 배정과 사용자 세션을 관리합니다." />
        </div>
        <span className={s.operating}>
          <i />
          전체 서비스 정상
        </span>
      </div>

      <nav className={s.adminTabs}>
        {TABS.map((t) => (
          <button key={t.key} data-on={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === "security" && unacknowledgedAlerts > 0 ? ` ${unacknowledgedAlerts}` : ""}
          </button>
        ))}
      </nav>

      {tab === "status" && (
        <>
          <div className={s.adminCounts}>
            <Count label="온라인" value={online} unit={`/ ${nodes.length}대`} />
            <Count label="사용 중" value={inUse} unit="대" />
            <Count label="대기" value={status?.queue?.length ?? 0} unit="명" />
            <Count label="저장 공간" value={avgStorage} unit="%" />
          </div>
          <div className={s.adminGrid}>
            <section className={s.opsSheet}>
              <div className={s.blockHeading}>
                <h2>장비 상태</h2>
                {nodesUpdatedAt && (
                  <small style={{ color: "var(--faint)", fontSize: "11px", fontWeight: 400 }}>
                    업데이트 {formatTimeOnly(nodesUpdatedAt)}
                  </small>
                )}
              </div>
              {(() => {
                let nodeCounter = 0;
                return nodes.map((n) => {
                  const isHub = n.id === "hub";
                  if (!isHub) nodeCounter++;
                  const label = isHub ? "HUB" : String(nodeCounter).padStart(2, "0");
                  return (
                    <div className={s.opsMachine} key={n.id}>
                      <span style={isHub ? { fontWeight: 700, fontSize: "10px", color: "var(--faint)" } : undefined}>{label}</span>
                      <div>
                        <strong>{n.name || n.id}</strong>
                        <small>{isHub ? "관리 서버" : (n.top_process || "—")}</small>
                      </div>
                      <em data-state={isHub ? "available" : n.status === "idle" ? "available" : n.status === "in_use" ? "busy" : "offline"}>
                        {isHub ? "온라인" : n.status === "idle" ? "대기" : n.status === "in_use" ? "사용 중" : "오프라인"}
                      </em>
                      <div>
                        <strong>{isHub ? "—" : (n.owner || "—")}</strong>
                        <small>{isHub ? "" : (n.project_name || "작업 없음")}</small>
                      </div>
                      <dl>
                        <div>
                          <dt>CPU</dt>
                          <dd>{(n.cpu_usage ?? 0).toFixed(0)}%</dd>
                        </div>
                        <div>
                          <dt>GPU</dt>
                          <dd>{isHub ? "—" : `${(n.gpu_usage ?? 0).toFixed(0)}%`}</dd>
                        </div>
                        <div>
                          <dt>SSD</dt>
                          <dd>{n.storage_total_gb ? `${(n.storage_used_gb ?? 0).toFixed(0)}/${Math.round(n.storage_total_gb)}G` : "—"}</dd>
                        </div>
                        <div>
                          <dt>가동</dt>
                          <dd>{formatUptime(n.uptime_seconds)}</dd>
                        </div>
                      </dl>
                    </div>
                  );
                });
              })()}
            </section>
            <aside className={s.waitSheet}>
              <h2>대기열</h2>
              {status?.queue?.length ? (
                status.queue.map((email, i) => (
                  <article key={i}>
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{email}</strong>
                    </div>
                  </article>
                ))
              ) : (
                <p style={{ color: "var(--dim)" }}>대기 중인 학생이 없습니다.</p>
              )}
              {status?.active && (
                <dl>
                  <div>
                    <dt>현재 사용</dt>
                    <dd>{status.active.owner || "—"}</dd>
                  </div>
                  <div>
                    <dt>만료 예정</dt>
                    <dd>{formatDateTime(status.active.expires_at)}</dd>
                  </div>
                </dl>
              )}
            </aside>
          </div>
        </>
      )}

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

      {tab === "people" && (
        <>
          <AdminTable title="사용자 관리" headers={["계정", "활성 세션", "최대 허용", "블랙리스트", "관리자", ""]}>
            {users.length === 0 ? (
              <div className={s.adminRow}>
                <span>
                  <strong>사용자가 없습니다.</strong>
                </span>
              </div>
            ) : (
              users.map((u) => {
                const activeSessions = sessions.filter(
                  (se) => se.owner === u.email && se.status !== "suspended"
                );
                return (
                  <div className={s.adminRow} key={u.email}>
                    <span>
                      <strong>
                        {u.email}
                        {u.is_admin && (
                          <span style={{
                            marginLeft: "6px",
                            padding: "1px 6px",
                            background: "rgba(167,139,250,.18)",
                            border: "1px solid rgba(167,139,250,.4)",
                            borderRadius: "4px",
                            color: "#a78bfa",
                            fontSize: "7px",
                            fontWeight: 600,
                            letterSpacing: ".04em",
                            verticalAlign: "middle",
                          }}>관리자</span>
                        )}
                        {u.blocked && (
                          <span style={{
                            marginLeft: "6px",
                            padding: "1px 6px",
                            background: "rgba(229,62,62,.13)",
                            border: "1px solid rgba(229,62,62,.35)",
                            borderRadius: "4px",
                            color: "#e53e3e",
                            fontSize: "7px",
                            fontWeight: 600,
                            letterSpacing: ".04em",
                            verticalAlign: "middle",
                          }}>차단됨</span>
                        )}
                      </strong>
                      {activeSessions.length > 0 && (
                        <small>
                          {activeSessions.map((se) => se.node_name || se.node_id).join(", ")}
                        </small>
                      )}
                    </span>
                    <span>{u.active_sessions ?? 0}개</span>
                    <span>
                      <select
                        defaultValue={u.max_sessions}
                        onChange={(e) => updateUserLimit(u.email, Number(e.target.value))}
                        disabled={busy}
                      >
                        {[1, 2, 3, 4, 5].map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                      대
                    </span>
                    <span>
                      <button
                        onClick={() => patchUser(u.email, { blocked: !u.blocked })}
                        disabled={busy}
                        style={u.blocked ? { color: "#e53e3e" } : {}}
                      >
                        {u.blocked ? "해제" : "차단"}
                      </button>
                    </span>
                    <span>
                      <button
                        onClick={() => patchUser(u.email, { is_admin: !u.is_admin })}
                        disabled={busy}
                        style={u.is_admin ? { color: "#a78bfa" } : {}}
                      >
                        {u.is_admin ? "제거" : "부여"}
                      </button>
                    </span>
                    <button
                      onClick={() => setTerminateUserEmail(u.email)}
                      disabled={busy || activeSessions.length === 0}
                      style={activeSessions.length > 0 ? { color: "#e53e3e" } : {}}
                    >
                      {activeSessions.length > 0 ? "종료" : "—"}
                    </button>
                  </div>
                );
              })
            )}
          </AdminTable>

          {terminateUserEmail && (
            <div className={s.overlay}>
              <section className={s.uploadSheet} style={{ width: "min(440px, 94vw)" }}>
                <header>
                  <div><h2>세션 강제 종료</h2></div>
                  <button onClick={() => setTerminateUserEmail(null)}>닫기</button>
                </header>
                <p style={{ margin: "22px 24px", lineHeight: 1.6 }}>
                  <strong>{terminateUserEmail}</strong>의 활성 세션을 모두 종료합니다.
                  저장되지 않은 작업이 손실될 수 있습니다.
                </p>
                <footer>
                  <span style={{ flex: 1 }} />
                  <button className={s.lineButton} onClick={() => setTerminateUserEmail(null)}>취소</button>
                  <button
                    className={s.solidButton}
                    style={{ color: "#e53e3e" }}
                    onClick={() => terminateUserSessions(terminateUserEmail)}
                  >
                    강제 종료
                  </button>
                </footer>
              </section>
            </div>
          )}
        </>
      )}

      {tab === "notice" && (
        <div className={s.settings}>
          <section>
            <div className={s.titleLine}>
              <h2>학생 공지</h2>
              <HelpTip text="내 작업 화면 상단의 공지 영역에 표시됩니다." />
            </div>
            <Field label="내용">
              <textarea
                rows={7}
                value={notice}
                onChange={(e) => setNotice(e.target.value)}
                placeholder="학생에게 표시할 공지를 입력하세요. (비우면 숨김)"
              />
            </Field>
            <button className={s.solidButton} onClick={saveNotice} disabled={busy}>
              저장
            </button>
          </section>
          <aside>
            <span>미리 보기</span>
            <h3>{notice ? "공지" : "표시할 공지 없음"}</h3>
            <p>{notice || "내용을 입력하면 이곳에 미리 표시됩니다."}</p>
          </aside>
        </div>
      )}

      {tab === "clean" && (
        <div className={s.cleanGrid}>
          <section>
            <div className={s.titleLine}>
              <h2>중단된 컨테이너</h2>
              <HelpTip text="종료 후 남아 있는 컨테이너입니다." />
            </div>
            {sessions.filter((se) => se.status === "suspended").length > 0 && (
              <>
                <p style={{ color: "var(--faint)", fontSize: "13px", margin: "0 0 8px" }}>보관된 세션</p>
                {sessions
                  .filter((se) => se.status === "suspended")
                  .map((se) => (
                    <article key={se.id}>
                      <div>
                        <strong>{se.project_name || se.id}</strong>
                        <small>{se.owner || "—"} · {formatDateTime(se.suspended_at)}</small>
                      </div>
                      <span style={{ color: "var(--faint)", fontSize: "12px" }}>보관됨</span>
                    </article>
                  ))}
              </>
            )}
            {containers.filter((c) => !c.is_saved_session).length > 0 && (
              <p style={{ color: "var(--faint)", fontSize: "13px", margin: "12px 0 8px" }}>미분류 컨테이너</p>
            )}
            {containers.length === 0 ? (
              <p style={{ color: "var(--dim)" }}>{containersLoading ? "조회 중…" : "중단된 컨테이너 없음"}</p>
            ) : (
              containers
                .filter((c) => !c.is_saved_session)
                .map((c) => (
                  <article key={c.name}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>{c.status}</small>
                    </div>
                    <button onClick={() => deleteContainer(c.name)} disabled={deletingContainer === c.name}>
                      {deletingContainer === c.name ? "삭제 중…" : "삭제"}
                    </button>
                  </article>
                ))
            )}
            <button
              className={s.lineButton}
              onClick={() => {
                doAction("cleanup", "중단 컨테이너 전체 정리");
                loadContainers();
              }}
              disabled={busy}
            >
              전체 정리
            </button>
          </section>
          <section>
            <div className={s.titleLine}>
              <h2>서비스 확인</h2>
            </div>
            {["프론트엔드", "중앙 허브", "Firebase", "노드 SSH"].map((name) => (
              <article key={name}>
                <span>
                  <i />
                  {name}
                </span>
                <strong>정상</strong>
              </article>
            ))}
            <button className={s.lineButton} onClick={loadNodes}>
              다시 확인
            </button>
          </section>
        </div>
      )}

      {tab === "security" && (
        <section className={s.opsSheet}>
          <div className={s.blockHeading}>
            <div>
              <h2>보안 경고</h2>
              <p className={s.securitySummary}>
                {securityScanEnabled ? `미확인 ${unacknowledgedAlerts}건` : "파일 감시 꺼짐"}
              </p>
            </div>
            <button onClick={loadSecurityAlerts} disabled={securityLoading}>
              {securityLoading ? "불러오는 중…" : "새로고침"}
            </button>
          </div>
          {securityAlerts.length === 0 ? (
            <p className={s.securityEmpty}>
              {securityLoading ? "경고를 확인하고 있습니다…" : "감지된 위험 파일이 없습니다."}
            </p>
          ) : (
            <div className={s.securityAlertGrid}>
              {securityAlerts.map((alert) => (
                <article key={alert.id} data-acknowledged={alert.acknowledged}>
                  <header>
                    <span data-severity={alert.severity}>
                      {alert.severity === "critical" ? "위험" : "주의"}
                    </span>
                    <strong>{alert.project_name || alert.session_id}</strong>
                    <time>{formatDateTime(alert.created_at)}</time>
                  </header>
                  <div className={s.securityMeta}>
                    <span>{alert.owner || "소유자 미상"}</span>
                    <span>{alert.node_name || alert.node_id || "노드 미상"}</span>
                    <span>세션 {alert.session_id}</span>
                  </div>
                  <ul>
                    {alert.files.map((file) => (
                      <li key={`${file.path}-${file.mtime}`}>
                        <strong>{file.path}</strong>
                        <small>
                          {file.reason} · {Math.max(1, Math.ceil(file.size / 1024)).toLocaleString()} KB
                        </small>
                      </li>
                    ))}
                  </ul>
                  {alert.has_screenshot ? (
                    <a
                      className={s.securityScreenshot}
                      href={`/api/admin/security-alerts/${encodeURIComponent(alert.id)}/screenshot`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={`/api/admin/security-alerts/${encodeURIComponent(alert.id)}/screenshot`}
                        alt={`${alert.project_name || alert.session_id} 감지 당시 화면`}
                      />
                      <span>감지 당시 화면 크게 보기</span>
                    </a>
                  ) : (
                    <p className={s.securityNoScreenshot}>화면 캡처 실패 · 파일 정보는 정상 기록됨</p>
                  )}
                  <footer>
                    <span>{alert.acknowledged ? "관리자 확인 완료" : "관리자 확인 필요"}</span>
                    {!alert.acknowledged && (
                      <button onClick={() => acknowledgeSecurityAlert(alert.id)}>확인 처리</button>
                    )}
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "log" && (
        <section className={s.opsSheet}>
          <div className={s.blockHeading}>
            <h2>모니터링 로그 {logDate && `· ${logDate}`}</h2>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="date"
                value={logDate}
                onChange={(e) => {
                  setLogDate(e.target.value);
                  loadLog(e.target.value || undefined);
                }}
                style={{
                  height: "36px",
                  padding: "0 10px",
                  border: "1px solid var(--hair)",
                  borderRadius: "8px",
                  background: "rgba(255,255,255,.6)",
                  color: "var(--paper)",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              />
              <button onClick={() => loadLog(logDate || undefined)} disabled={logLoading}>
                {logLoading ? "불러오는 중…" : "새로고침"}
              </button>
            </div>
          </div>
          {logContent ? (
            <pre
              style={{
                margin: "12px 0 0",
                padding: "16px",
                maxHeight: "60vh",
                overflow: "auto",
                fontSize: "12px",
                lineHeight: 1.6,
                fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                color: "#20242a",
                background: "rgba(255,255,255,.5)",
                border: "1px solid rgba(25,31,39,.1)",
                borderRadius: "12px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {logContent}
            </pre>
          ) : (
            <p style={{ color: "var(--dim)", marginTop: "12px" }}>
              {logLoading ? "불러오는 중…" : `${logDate || "오늘"} 로그 없음 (10분마다 기록)`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Count({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
    </div>
  );
}

function AdminTable({
  title,
  headers,
  children,
}: {
  title: string;
  headers: string[];
  children: ReactNode;
}) {
  return (
    <section className={s.adminTable}>
      <div className={s.blockHeading}>
        <h2>{title}</h2>
      </div>
      <div className={s.adminHead}>
        {headers.map((h, i) => (
          <span key={i}>{h}</span>
        ))}
      </div>
      {children}
    </section>
  );
}

function sessionStatusLabel(st?: string) {
  if (st === "active") return "사용 중";
  if (st === "starting") return "준비 중";
  if (st === "suspended") return "보관됨";
  return st || "—";
}

function formatTimeOnly(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}일 ${h}h`;
  return `${h}시간`;
}
