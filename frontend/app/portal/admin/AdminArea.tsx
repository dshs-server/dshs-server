"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import s from "../atelier.module.css";
import { HelpTip, Field, formatDateTime } from "../ui";
import { useToast } from "@/components/toast";

type AdminTab = "status" | "pc" | "session" | "people" | "notice" | "clean" | "security" | "log";

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

interface AdminStatusData {
  active: { owner?: string; since?: number; expires_at?: number; status?: string } | null;
  queue: string[];
}

interface AdminUser {
  email: string;
  max_sessions: number;
  active_sessions?: number;
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
  { key: "pc", label: "PC" },
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

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/admin");
      if (r.ok) setStatus(await r.json());
    } catch {}
  }, []);
  const loadNodes = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/nodes");
      if (r.ok) setNodes((await r.json()).nodes || []);
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
    fetch("/api/notice")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.notice && setNotice(d.notice))
      .catch(() => {});
    const iv = setInterval(() => {
      loadStatus();
      loadNodes();
    }, 4000);
    return () => clearInterval(iv);
  }, [loadStatus, loadNodes, loadUsers, loadSessions, loadContainers, loadLog, loadSecurityAlerts]);

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
                <button onClick={() => setTab("pc")}>전체 보기</button>
              </div>
              {nodes.map((n, i) => (
                <div className={s.opsMachine} key={n.id}>
                  <span>{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <strong>{n.name || n.id}</strong>
                    <small>{n.top_process || "—"}</small>
                  </div>
                  <em data-state={n.status === "idle" ? "available" : n.status === "in_use" ? "busy" : "offline"}>
                    {n.status === "idle" ? "대기" : n.status === "in_use" ? "사용 중" : "오프라인"}
                  </em>
                  <p>{n.project_name || "—"}</p>
                  <dl>
                    <div>
                      <dt>CPU</dt>
                      <dd>{(n.cpu_usage ?? 0).toFixed(0)}%</dd>
                    </div>
                    <div>
                      <dt>GPU</dt>
                      <dd>{(n.gpu_usage ?? 0).toFixed(0)}%</dd>
                    </div>
                  </dl>
                </div>
              ))}
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

      {tab === "pc" && (
        <AdminTable title="PC 관리" headers={["장비", "상태", "사용자 / 작업", "CPU", "GPU", "저장 공간", ""]}>
          {nodes.map((n, i) => (
            <div className={s.adminRow} key={n.id}>
              <span>
                <b>{String(i + 1).padStart(2, "0")}</b>
                {n.name || n.id}
              </span>
              <span>{n.status === "idle" ? "대기" : n.status === "in_use" ? "사용 중" : "오프라인"}</span>
              <span>
                {n.owner || "—"}
                <small>{n.project_name || ""}</small>
              </span>
              <span>{(n.cpu_usage ?? 0).toFixed(0)}%</span>
              <span>{(n.gpu_usage ?? 0).toFixed(0)}%</span>
              <span>
                {n.storage_total_gb
                  ? `${(n.storage_used_gb ?? 0).toFixed(0)}/${n.storage_total_gb}GB`
                  : "—"}
              </span>
              <button
                disabled={n.status !== "in_use" || busy}
                onClick={() => doAction("terminate", "세션 강제 종료")}
              >
                종료
              </button>
            </div>
          ))}
        </AdminTable>
      )}

      {tab === "session" && (
        <AdminTable title="세션 관리" headers={["작업", "사용자", "장비", "상태", "만료/삭제", ""]}>
          {sessions.length === 0 ? (
            <div className={s.adminRow}>
              <span>
                <strong>활성/보관 세션이 없습니다.</strong>
              </span>
            </div>
          ) : (
            sessions.map((se) => (
              <div className={s.adminRow} key={se.id}>
                <span>
                  <strong>{se.project_name || "세션"}</strong>
                </span>
                <span>{se.owner || "—"}</span>
                <span>{se.node_name || se.node_id || "—"}</span>
                <span>{sessionStatusLabel(se.status)}</span>
                <span>{formatDateTime(se.status === "suspended" ? se.suspended_at : se.expires_at)}</span>
                <button onClick={() => doAction("terminate", "세션 강제 종료")} disabled={busy}>
                  관리
                </button>
              </div>
            ))
          )}
        </AdminTable>
      )}

      {tab === "people" && (
        <AdminTable title="사용자 관리" headers={["계정", "활성 세션", "최대 허용", ""]}>
          {users.length === 0 ? (
            <div className={s.adminRow}>
              <span>
                <strong>등록된 사용자가 없습니다.</strong>
              </span>
            </div>
          ) : (
            users.map((u) => (
              <div className={s.adminRow} key={u.email}>
                <span>
                  <strong>{u.email}</strong>
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
                <button disabled>—</button>
              </div>
            ))
          )}
        </AdminTable>
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
            {containers.length === 0 ? (
              <p style={{ color: "var(--dim)" }}>{containersLoading ? "조회 중…" : "중단된 컨테이너 없음"}</p>
            ) : (
              containers.map((c) => (
                <article key={c.name}>
                  <div>
                    <strong>{c.name}</strong>
                    <small>
                      {c.status}
                      {c.is_saved_session ? " · 저장된 세션" : ""}
                    </small>
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
            <button onClick={() => loadLog()} disabled={logLoading}>
              {logLoading ? "불러오는 중…" : "새로고침"}
            </button>
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
