"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ToastProvider, useToast } from "@/components/toast";

type Status = "checking" | "idle" | "starting" | "ready" | "busy" | "queued" | "error";

interface SessionStats {
  cpu_pct?: number;
  ram_pct?: number;
  ram_used?: string;
  ram_total?: string;
  gpu_pct?: number;
  gpu_mem_pct?: number;
  gpu_mem_used_mb?: number;
  gpu_mem_total_mb?: number;
  storage_pct?: number;
  storage_used_gb?: number;
  storage_total_gb?: number;
}

interface SuspendedSession {
  id: string;
  project_name?: string;
  saved_at?: number;
  team_members?: string[];
  resources?: {
    cpu_cores?: number;
    ram_gb?: number;
    storage_gb?: number;
    gpu?: string;
  };
}

interface NewSessionForm {
  project_name: string;
  team_members: string[];
  cpu_cores: number;
  ram_gb: number;
  storage_gb: number;
  duration_days: number;
  node_id?: string;
}

interface NodeInfo {
  id: string;
  name?: string;
  cpu: string;
  gpu: string;
  cpu_cores?: number;
  ram_gb: number;
  storage_gb: number;
  available: boolean;
  session_state?: "none" | "suspended" | "active";
}

interface SessionData {
  status: string;
  session_id?: string;
  url?: string;
  message?: string;
  expires_at?: number;
  owner?: string;
  queue_position?: number;
  suspended_sessions?: SuspendedSession[];
}

interface Me {
  email: string;
  isAdmin: boolean;
}

function Dashboard() {
  const router = useRouter();
  const { toast } = useToast();

  const [status, setStatus] = useState<Status>("checking");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [queuePos, setQueuePos] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suspendedSessions, setSuspendedSessions] = useState<SuspendedSession[]>([]);
  const [showTerminateConfirm, setShowTerminateConfirm] = useState(false);
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [replaceSessionId, setReplaceSessionId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiredRef = useRef(false);

  const clearIntervals = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    if (statsRef.current) clearInterval(statsRef.current);
    pollRef.current = null;
    timerRef.current = null;
    statsRef.current = null;
  }, []);

  const applyData = useCallback((data: SessionData) => {
    if (typeof data.expires_at === "number") setExpiresAt(data.expires_at);
    if (data.owner) setOwner(data.owner);
    if (typeof data.queue_position === "number") setQueuePos(data.queue_position);
    if (Array.isArray(data.suspended_sessions)) setSuspendedSessions(data.suspended_sessions);
  }, []);

  const startStatsPolling = useCallback((sid: string) => {
    if (statsRef.current) clearInterval(statsRef.current);
    const fetchStats = async () => {
      try {
        const r = await fetch(`/api/session/${sid}/stats`);
        if (r.ok) setStats(await r.json());
      } catch {
        // keep polling
      }
    };
    fetchStats();
    statsRef.current = setInterval(fetchStats, 5000);
  }, []);

  const startPolling = useCallback(
    (sid: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/session/${sid}`);
          const data: SessionData = await r.json();
          applyData(data);
          if (data.status === "ready") {
            setUrl(data.url || null);
            if (pollRef.current) clearInterval(pollRef.current);
            try {
              const sr = await fetch(`/api/session/${sid}/stats`);
              if (sr.ok) setStats(await sr.json());
            } catch {}
            setStatus("ready");
            startStatsPolling(sid);
            toast("데스크톱이 준비되었습니다!", "success");
          } else if (data.status === "error") {
            setErrorMsg(data.message || "알 수 없는 오류");
            setStatus("error");
            clearIntervals();
            toast("세션 준비에 실패했습니다.", "error");
          }
        } catch {
          // keep polling
        }
      }, 3000);
    },
    [applyData, clearIntervals, startStatsPolling, toast]
  );

  async function handleStartNew(form: NewSessionForm, replaceId?: string) {
    setShowNewSessionModal(false);
    setReplaceSessionId(null);
    setStatus("starting");
    setErrorMsg(null);
    setUrl(null);
    setElapsed(0);
    setSessionId(null);
    expiredRef.current = false;
    timerRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);

    try {
      const body = {
        project_name: form.project_name,
        team_members: form.team_members,
        node_id: form.node_id,
        resources: {
          cpu_cores: form.cpu_cores,
          ram_gb: form.ram_gb,
          storage_gb: form.storage_gb,
        },
        duration_days: form.duration_days,
        ...(replaceId ? { replace_session_id: replaceId } : {}),
      };

      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          setOwner(data.owner || null);
          setQueuePos(data.queue_position ?? null);
          setStatus("queued");
          clearIntervals();
          toast(
            data.queue_position
              ? `사용 중입니다. 대기열 ${data.queue_position}번째에 등록되었습니다.`
              : "현재 다른 학생이 사용 중입니다.",
            "info"
          );
          return;
        }
        throw new Error(data.error || "세션 생성 실패");
      }

      if (replaceId) {
        setSuspendedSessions((prev) => prev.filter((s) => s.id !== replaceId));
      }
      applyData(data);
      setSessionId(data.session_id);
      startPolling(data.session_id);
      toast("데스크톱을 준비하고 있습니다…", "info");
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "오류 발생");
      clearIntervals();
    }
  }

  async function handleResume(suspendedId: string) {
    setStatus("starting");
    setErrorMsg(null);
    setUrl(null);
    setElapsed(0);
    setSessionId(null);
    expiredRef.current = false;
    timerRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);

    try {
      const extra = suspendedId !== "default" ? `&session_id=${encodeURIComponent(suspendedId)}` : "";
      const res = await fetch(`/api/session?resume=true${extra}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "세션 재시작 실패");
      setSuspendedSessions((prev) => prev.filter((s) => s.id !== suspendedId));
      applyData(data);
      setSessionId(data.session_id);
      startPolling(data.session_id);
      toast("이전 환경을 복원하고 있습니다…", "info");
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "오류 발생");
      clearIntervals();
    }
  }

  const handleTerminate = useCallback(
    async (auto = false) => {
      const sid = sessionId;
      if (!sid) return;
      try {
        await fetch(`/api/session/${sid}`, { method: "DELETE" });
      } catch {
        // ignore
      }
      setSuspendedSessions((prev) =>
        prev.some((s) => s.id === sid) ? prev : [...prev, { id: sid }]
      );
      setStatus("idle");
      setSessionId(null);
      setUrl(null);
      setExpiresAt(null);
      setRemaining(null);
      setStats(null);
      clearIntervals();
      toast(
        auto ? "시간이 만료되어 세션이 종료되었습니다." : "세션을 종료했습니다.",
        auto ? "info" : "success"
      );
    },
    [sessionId, clearIntervals, toast]
  );

  async function handlePermanentDelete(id: string) {
    setPendingDeleteId(null);
    try {
      await fetch(`/api/session/${id}?permanent=true`, { method: "DELETE" });
    } catch {
      // ignore
    }
    setSuspendedSessions((prev) => prev.filter((s) => s.id !== id));
    toast("세션을 완전히 삭제했습니다.", "success");
  }

  async function handleCheckAvailability() {
    try {
      const r = await fetch("/api/session");
      const data: SessionData = await r.json();
      applyData(data);
      if (data.status === "none") {
        setStatus("idle");
        toast("PC를 사용할 수 있습니다!", "success");
      } else if (data.status === "your_turn") {
        setStatus("idle");
        setShowNewSessionModal(true);
      } else {
        toast("아직 사용 중입니다.", "info");
      }
    } catch {
      // ignore
    }
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  }

  useEffect(() => {
    if (status !== "ready" || !expiresAt) {
      setRemaining(null);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.floor(expiresAt - Date.now() / 1000));
      setRemaining(left);
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        handleTerminate(true);
      } else if (left === 300) {
        toast("세션 종료 5분 전입니다. 작업을 저장하세요.", "info");
      }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [status, expiresAt, handleTerminate, toast]);

  useEffect(() => {
    if (status !== "busy" && status !== "queued") return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/session");
        const data: SessionData = await r.json();
        applyData(data);
        if (data.status === "your_turn") {
          clearInterval(iv);
          toast("이제 사용할 수 있습니다!", "success");
          setStatus("idle");
          setShowNewSessionModal(true);
        } else if (data.status === "queued") {
          setStatus("queued");
          setQueuePos(data.queue_position ?? null);
        } else if (data.status === "busy") {
          setOwner(data.owner || null);
        } else if (data.status === "none" || data.status === "suspended") {
          clearInterval(iv);
          if (data.status === "suspended") {
            setSuspendedSessions((prev) =>
              prev.some((s) => s.id === (data.session_id || "default"))
                ? prev
                : [...prev, { id: data.session_id || "default" }]
            );
          }
          setStatus("idle");
        }
      } catch {
        // keep polling
      }
    }, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setMe({ email: d.email, isAdmin: d.isAdmin }))
      .catch(() => {});

    fetch("/api/notice")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.notice && setNotice(d.notice))
      .catch(() => {});

    async function restore() {
      try {
        const res = await fetch("/api/session");
        const data: SessionData = await res.json();
        applyData(data);

        if (data.status === "suspended") {
          if (!Array.isArray(data.suspended_sessions) || data.suspended_sessions.length === 0) {
            setSuspendedSessions([{ id: data.session_id || "default" }]);
          }
          setStatus("idle");
          return;
        }
        if (data.status === "ready" && data.url) {
          setSessionId(data.session_id || null);
          setUrl(data.url);
          if (data.session_id) {
            try {
              const sr = await fetch(`/api/session/${data.session_id}/stats`);
              if (sr.ok) setStats(await sr.json());
            } catch {}
            startStatsPolling(data.session_id);
          }
          setStatus("ready");
          return;
        }
        if (data.status === "starting" && data.session_id) {
          setSessionId(data.session_id);
          setStatus("starting");
          startPolling(data.session_id);
          return;
        }
        if (data.status === "busy") {
          setOwner(data.owner || null);
          setStatus("busy");
          return;
        }
        if (data.status === "queued") {
          setOwner(data.owner || null);
          setQueuePos(data.queue_position ?? null);
          setStatus("queued");
          return;
        }
        if (data.status === "your_turn") {
          setStatus("idle");
          setShowNewSessionModal(true);
          return;
        }
      } catch {
        // fall through to idle
      } finally {
        setStatus((prev) => (prev === "checking" ? "idle" : prev));
      }
    }
    restore();
    return () => clearIntervals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progressPct = Math.min(elapsed * 3, 92);

  return (
    <div className="page">
      <Header me={me} onLogout={handleLogout} />

      <main style={mainWrap}>
        {notice && <NoticeBanner text={notice} />}

        <div className="glass glass-strong fade-in" style={card}>
          <div style={cardHead}>
            <h2 style={{ margin: 0, fontSize: "21px", fontWeight: 800 }}>
              GPU 데스크톱 대여
            </h2>
            <StatusBadge status={status} />
          </div>
          <p style={{ margin: "6px 0 22px", color: "var(--text-dim)", fontSize: "14px" }}>
            브라우저에서 Ubuntu MATE 데스크톱을 그대로 사용할 수 있습니다.
          </p>

          <div style={{ marginTop: "8px" }}>
            {status === "checking" && <CheckingState />}

            {status === "idle" && (
              <button
                className="btn btn-primary btn-block"
                onClick={() => { setReplaceSessionId(null); setShowNewSessionModal(true); }}
              >
                PC 대여하기
              </button>
            )}

            {status === "busy" && (
              <BusyState owner={owner} onRetry={handleCheckAvailability} />
            )}

            {status === "queued" && (
              <QueuedState owner={owner} position={queuePos} />
            )}

            {status === "starting" && (
              <StartingState elapsed={elapsed} progressPct={progressPct} />
            )}

            {status === "ready" && url && (
              <ReadyState
                url={url}
                remaining={remaining}
                expiresAt={expiresAt}
                stats={stats}
                onTerminate={() => setShowTerminateConfirm(true)}
              />
            )}

            {status === "error" && (
              <ErrorState message={errorMsg} onRetry={() => setStatus("idle")} />
            )}
          </div>
        </div>

        {suspendedSessions.length > 0 && (
          <div className="fade-in">
            <h3 style={sectionTitle}>저장된 세션</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {suspendedSessions.map((s) => (
                <SuspendedSessionCard
                  key={s.id}
                  session={s}
                  onResume={handleResume}
                  onDelete={(id) => setPendingDeleteId(id)}
                />
              ))}
            </div>
          </div>
        )}

        <p style={footHint}>
          ※ 학교망에서 접속이 안 되면 VPN을 켜고 다시 시도하세요.
        </p>
      </main>

      {showTerminateConfirm && (
        <ConfirmModal
          title="세션 종료"
          message="세션을 종료하시겠습니까? 현재 환경은 저장된 세션으로 보존되며 나중에 이어서 사용할 수 있습니다."
          onConfirm={() => { setShowTerminateConfirm(false); handleTerminate(false); }}
          onCancel={() => setShowTerminateConfirm(false)}
        />
      )}

      {showNewSessionModal && (
        <NewSessionModal
          onConfirm={(form) => handleStartNew(form, replaceSessionId || undefined)}
          onCancel={() => { setShowNewSessionModal(false); setReplaceSessionId(null); }}
        />
      )}

      {pendingDeleteId && (
        <ConfirmModal
          title="파일 완전히 제거"
          message="저장된 세션의 모든 파일과 설치된 패키지가 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
          confirmLabel="영구 삭제"
          danger
          onConfirm={() => handlePermanentDelete(pendingDeleteId)}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────── 하위 컴포넌트 ─────────────────────── */

function Header({ me, onLogout }: { me: Me | null; onLogout: () => void }) {
  return (
    <header style={header}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span style={brandBadge}>🖥️</span>
        <span style={{ fontWeight: 800, fontSize: "16px", letterSpacing: "-0.3px" }}>
          PC 대여 포털
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {me && (
          <span className="badge" title={me.email}>
            <span className="dot dot-success" />
            {me.email}
          </span>
        )}
        {me?.isAdmin && (
          <a href="/admin" className="btn btn-ghost" style={smallBtn}>
            관리자
          </a>
        )}
        <button className="btn btn-ghost" style={smallBtn} onClick={onLogout}>
          로그아웃
        </button>
      </div>
    </header>
  );
}

function NoticeBanner({ text }: { text: string }) {
  return (
    <div className="glass fade-in" style={noticeBanner}>
      <span style={{ fontSize: "16px" }}>📢</span>
      <span style={{ fontSize: "14px", lineHeight: 1.5 }}>{text}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, { dot: string; label: string; pulse?: boolean }> = {
    checking: { dot: "dot-idle", label: "확인 중" },
    idle:     { dot: "dot-success", label: "사용 가능" },
    starting: { dot: "dot-warning", label: "준비 중", pulse: true },
    ready:    { dot: "dot-success", label: "사용 중", pulse: true },
    busy:     { dot: "dot-danger", label: "다른 사용자 사용 중" },
    queued:   { dot: "dot-warning", label: "대기 중", pulse: true },
    error:    { dot: "dot-danger", label: "오류" },
  };
  const s = map[status];
  return (
    <span className="badge">
      <span className={`dot ${s.dot}${s.pulse ? " dot-pulse" : ""}`} />
      {s.label}
    </span>
  );
}


function SuspendedSessionCard({
  session,
  onResume,
  onDelete,
}: {
  session: SuspendedSession;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="glass glass-strong" style={{ padding: "22px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: "14px",
          gap: "12px",
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: "15px" }}>
            {session.project_name || "저장된 세션"}
          </div>
          {session.saved_at && (
            <div style={{ color: "var(--text-faint)", fontSize: "12px", marginTop: "3px" }}>
              {new Date(session.saved_at * 1000).toLocaleString("ko-KR")} 저장
            </div>
          )}
        </div>
        <span className="badge" style={{ flexShrink: 0 }}>
          <span className="dot dot-warning" />
          저장됨
        </span>
      </div>

      {session.resources && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "14px" }}>
          {session.resources.cpu_cores && (
            <span style={specTagStyle}>CPU {session.resources.cpu_cores}코어</span>
          )}
          {session.resources.ram_gb && (
            <span style={specTagStyle}>RAM {session.resources.ram_gb}GB</span>
          )}
          {session.resources.storage_gb && (
            <span style={specTagStyle}>SSD {session.resources.storage_gb}GB</span>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "10px" }}>
        <button
          className="btn btn-primary"
          style={{ flex: 1, padding: "11px 14px", fontSize: "14px" }}
          onClick={() => onResume(session.id)}
        >
          이어서 사용하기
        </button>
        <button
          className="btn btn-danger"
          style={{ flex: 1, padding: "11px 14px", fontSize: "14px" }}
          onClick={() => onDelete(session.id)}
        >
          파일 완전히 제거
        </button>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel = "확인",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={modalOverlay}>
      <div className="glass glass-strong fade-in" style={{ ...modalCard, maxWidth: "400px" }}>
        <h3 style={{ margin: "0 0 12px", fontSize: "17px", fontWeight: 800 }}>{title}</h3>
        <p style={{ margin: "0 0 24px", color: "var(--text-dim)", fontSize: "14px", lineHeight: 1.6 }}>
          {message}
        </p>
        <div style={{ display: "flex", gap: "12px" }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>취소</button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            style={{ flex: 1 }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function getNodeState(node: NodeInfo): "available" | "suspended" | "active" {
  if (node.session_state === "suspended") return "suspended";
  if (node.session_state === "active") return "active";
  if (node.session_state === "none") return "available";
  return node.available ? "available" : "active";
}

function SliderField({
  value, min, max, step, display, onChange,
}: {
  value: number; min: number; max: number; step: number;
  display: string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>{min}</span>
        <span style={{ fontWeight: 700, fontSize: "13px", color: "var(--accent)" }}>{display}</span>
        <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>{max}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }}
      />
    </div>
  );
}

const minSliderCSS = `
  .min-slider input[type=range] {
    position: absolute; width: 100%; height: 100%; top: 0; left: 0;
    background: transparent; margin: 0; padding: 0;
    -webkit-appearance: none; appearance: none; cursor: pointer;
  }
  .min-slider input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; width: 18px; height: 18px;
    border-radius: 50%; background: var(--accent, #7c8cff);
    border: 2px solid rgba(255,255,255,0.9);
    box-shadow: 0 1px 3px rgba(0,0,0,0.35);
  }
  .min-slider input[type=range]::-moz-range-thumb {
    width: 14px; height: 14px; border-radius: 50%;
    background: var(--accent, #7c8cff);
    border: 2px solid rgba(255,255,255,0.9);
    box-shadow: 0 1px 3px rgba(0,0,0,0.35);
  }
  .min-slider input[type=range]::-webkit-slider-runnable-track { background: transparent; }
  .min-slider input[type=range]::-moz-range-track { background: transparent; }
`;

function MinSliderField({
  label, value, absMin, absMax, step, displayFn, onChange,
}: {
  label: string;
  value: number;
  absMin: number; absMax: number; step: number;
  displayFn: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const pct = ((value - absMin) / (absMax - absMin || 1)) * 100;

  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <span style={{ fontSize: "13px", color: "var(--text-dim)", fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent)" }}>
          {displayFn(value)} 이상
        </span>
      </div>
      <div className="min-slider" style={{ position: "relative", height: "24px" }}>
        <div style={{
          position: "absolute", top: "50%", left: 0, right: 0,
          height: "4px", transform: "translateY(-50%)", borderRadius: "2px", pointerEvents: "none",
          background: `linear-gradient(to right, rgba(255,255,255,0.12) ${pct}%, var(--accent) ${pct}% 100%)`,
        }} />
        <input type="range" min={absMin} max={absMax} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

function NewSessionModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (form: NewSessionForm) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<NewSessionForm>({
    project_name: "",
    team_members: [],
    cpu_cores: 2,
    ram_gb: 8,
    storage_gb: 50,
    duration_days: 7,
  });
  const [memberInput, setMemberInput] = useState("");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [allNodes, setAllNodes] = useState<NodeInfo[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodesLoading, setNodesLoading] = useState(true);

  useEffect(() => {
    fetch("/api/nodes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const nodes: NodeInfo[] = d.nodes || [];
        setAllNodes(nodes);
        const selectable = nodes.filter((n) => getNodeState(n) !== "active");
        if (selectable.length === 1) setSelectedNodeId(selectable[0].id);
      })
      .catch(() => {})
      .finally(() => setNodesLoading(false));
  }, []);

  function addMember() {
    const email = memberInput.trim().toLowerCase();
    if (!email) return;
    if (!email.endsWith("@ts.hs.kr")) {
      setMemberError("@ts.hs.kr 이메일만 추가할 수 있습니다.");
      return;
    }
    if (form.team_members.includes(email)) {
      setMemberError("이미 추가된 팀원입니다.");
      return;
    }
    setForm((f) => ({ ...f, team_members: [...f.team_members, email] }));
    setMemberInput("");
    setMemberError(null);
  }

  const selectedNode = allNodes.find((n) => n.id === selectedNodeId);
  const selectedMeetsSpecs = selectedNode
    ? (selectedNode.cpu_cores == null || selectedNode.cpu_cores >= form.cpu_cores) &&
      selectedNode.ram_gb >= form.ram_gb &&
      selectedNode.storage_gb >= form.storage_gb
    : false;
  const canStart = !!form.project_name.trim() && !!selectedNodeId && selectedMeetsSpecs;

  return (
    <div style={modalOverlay} onClick={onCancel}>
      <div
        className="glass glass-strong fade-in"
        style={modalCard}
        onClick={(e) => e.stopPropagation()}
      >
        <style>{minSliderCSS}</style>
        <h3 style={{ margin: "0 0 20px", fontSize: "18px", fontWeight: 800 }}>새 세션 시작</h3>

        <label style={formLabel}>프로젝트 이름 *</label>
        <input
          className="input"
          value={form.project_name}
          onChange={(e) => setForm((f) => ({ ...f, project_name: e.target.value }))}
          placeholder="예: ML 실습 프로젝트"
          style={{ marginBottom: "18px" }}
          autoFocus
        />

        <label style={formLabel}>팀원 추가 (@ts.hs.kr)</label>
        <div style={{ display: "flex", gap: "8px", marginBottom: "6px" }}>
          <input
            className="input"
            value={memberInput}
            onChange={(e) => { setMemberInput(e.target.value); setMemberError(null); }}
            onKeyDown={(e) => e.key === "Enter" && addMember()}
            placeholder="ts000000@ts.hs.kr"
            style={{ flex: 1 }}
          />
          <button className="btn btn-ghost" onClick={addMember}
            style={{ padding: "10px 16px", flexShrink: 0 }}>추가</button>
        </div>
        {memberError && (
          <p style={{ color: "var(--danger)", fontSize: "12px", margin: "0 0 8px" }}>{memberError}</p>
        )}
        <div style={{ minHeight: "8px", marginBottom: form.team_members.length ? "14px" : "6px" }}>
          {form.team_members.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {form.team_members.map((m) => (
                <span key={m} className="badge" style={{ fontSize: "12px" }}>
                  {m}
                  <button
                    onClick={() => setForm((f) => ({ ...f, team_members: f.team_members.filter((x) => x !== m) }))}
                    style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: "0 0 0 4px", fontSize: "11px" }}
                  >✕</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--glass-border)", margin: "6px 0 18px" }} />
        <p style={{ margin: "0 0 14px", fontSize: "13px", color: "var(--text-dim)", fontWeight: 600 }}>
          최소 사양
        </p>

        <MinSliderField
          label="CPU" value={form.cpu_cores}
          absMin={1} absMax={32} step={1}
          displayFn={(v) => `${v}코어`}
          onChange={(v) => setForm((f) => ({ ...f, cpu_cores: v }))}
        />
        <MinSliderField
          label="RAM" value={form.ram_gb}
          absMin={4} absMax={64} step={4}
          displayFn={(v) => `${v}GB`}
          onChange={(v) => setForm((f) => ({ ...f, ram_gb: v }))}
        />
        <MinSliderField
          label="SSD" value={form.storage_gb}
          absMin={50} absMax={500} step={50}
          displayFn={(v) => `${v}GB`}
          onChange={(v) => setForm((f) => ({ ...f, storage_gb: v }))}
        />

        <label style={formLabel}>유지 기간</label>
        <SliderField value={form.duration_days} min={1} max={30} step={1}
          display={`${form.duration_days}일`}
          onChange={(v) => setForm((f) => ({ ...f, duration_days: v }))} />

        <div style={{ borderTop: "1px solid var(--glass-border)", margin: "6px 0 18px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--text-dim)", fontWeight: 600 }}>PC 목록</p>
          {nodesLoading && (
            <span className="spinner" style={{ width: "13px", height: "13px", borderWidth: "2px" }} />
          )}
        </div>

        {!nodesLoading && allNodes.length === 0 ? (
          <div style={{ ...infoBox("danger"), marginBottom: "18px" }}>
            연결된 PC가 없습니다. 잠시 후 다시 시도해 주세요.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "18px", minHeight: nodesLoading ? "80px" : undefined }}>
            {allNodes.map((node) => {
              const nodeState = getNodeState(node);
              const meetsSpecs =
                (node.cpu_cores == null || node.cpu_cores >= form.cpu_cores) &&
                node.ram_gb >= form.ram_gb &&
                node.storage_gb >= form.storage_gb;
              const isSelectable = nodeState !== "active" && meetsSpecs;
              const selected = selectedNodeId === node.id;
              return (
                <button key={node.id}
                  onClick={() => isSelectable && setSelectedNodeId(node.id)}
                  style={{
                    textAlign: "left", padding: "14px", borderRadius: "12px",
                    background: selected ? "rgba(124,140,255,0.18)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${selected ? "rgba(124,140,255,0.6)" : "var(--glass-border)"}`,
                    color: "var(--text)", cursor: isSelectable ? "pointer" : "not-allowed",
                    opacity: meetsSpecs ? (nodeState === "active" ? 0.5 : 1) : 0.35,
                    width: "100%",
                    transition: "background 0.15s, border-color 0.15s, opacity 0.2s",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <span style={{ fontWeight: 700, fontSize: "14px" }}>{node.name || node.id}</span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      {!meetsSpecs && (
                        <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>사양 범위 외</span>
                      )}
                      <span className="badge">
                        <span className={`dot ${nodeState === "available" ? "dot-success" : nodeState === "suspended" ? "dot-warning" : "dot-danger"}`} />
                        {nodeState === "available" ? "사용 가능" : nodeState === "suspended" ? "저장된 세션 있음" : "사용 중"}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {[
                      { label: "CPU", value: node.cpu },
                      { label: "GPU", value: node.gpu },
                      { label: "RAM", value: `${node.ram_gb}GB` },
                      { label: "SSD", value: `${node.storage_gb}GB` },
                    ].map((s) => (
                      <span key={s.label} style={specTagStyle}>{s.label} {s.value}</span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", gap: "12px" }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>취소</button>
          <button
            className="btn btn-primary" style={{ flex: 1 }}
            disabled={!canStart}
            onClick={() => onConfirm({ ...form, node_id: selectedNodeId ?? undefined })}
          >
            시작하기
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckingState() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", color: "var(--text-dim)" }}>
      <span className="spinner" />
      <span>세션 상태를 확인하는 중…</span>
    </div>
  );
}

function BusyState({ owner, onRetry }: { owner: string | null; onRetry: () => void }) {
  return (
    <div className="fade-in">
      <div style={infoBox("danger")}>
        현재 <b>{owner || "다른 학생"}</b> 님이 사용 중입니다. 잠시 후 다시 시도해 주세요.
      </div>
      <button className="btn btn-ghost btn-block" onClick={onRetry}>다시 확인하기</button>
    </div>
  );
}

function QueuedState({ owner, position }: { owner: string | null; position: number | null }) {
  return (
    <div className="fade-in">
      <div style={{ textAlign: "center", padding: "8px 0 18px" }}>
        <div style={{ fontSize: "13px", color: "var(--text-dim)", marginBottom: "8px" }}>대기 순번</div>
        <div style={{ fontSize: "44px", fontWeight: 800, lineHeight: 1 }}>
          {position ?? "—"}
          <span style={{ fontSize: "18px", color: "var(--text-dim)", fontWeight: 600 }}> 번째</span>
        </div>
      </div>
      <div style={infoBox("warning")}>
        현재 <b>{owner || "다른 학생"}</b> 님이 사용 중입니다. 자리가 나면 자동으로 알림이 오며, 이 화면을 열어두기만 하면 됩니다.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", justifyContent: "center", color: "var(--text-dim)", fontSize: "13px" }}>
        <span className="spinner" /> 자리를 기다리는 중…
      </div>
    </div>
  );
}

function StartingState({ elapsed, progressPct }: { elapsed: number; progressPct: number }) {
  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
        <span className="spinner" />
        <span style={{ fontWeight: 600 }}>데스크톱 환경을 준비하는 중…</span>
      </div>
      <div className="progress-track" style={{ marginBottom: "12px" }}>
        <div className="progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: "13.5px", margin: 0 }}>
        경과 시간 {elapsed}초 · 보통 15~30초 소요됩니다.
      </p>
    </div>
  );
}

function StatRing({ label, pct, sub }: { label: string; pct: number; sub?: string }) {
  const color = pct >= 80 ? "var(--danger)" : pct >= 60 ? "var(--warning)" : "var(--accent)";
  const clampedPct = Math.min(Math.max(pct, 0), 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "5px" }}>
      <div style={{
        width: 68, height: 68, borderRadius: "50%", padding: "6px",
        background: `conic-gradient(${color} ${clampedPct}%, rgba(255,255,255,0.07) ${clampedPct}%)`,
        boxShadow: `0 0 12px ${clampedPct > 10 ? color : "transparent"}44`,
        transition: "background 0.6s ease, box-shadow 0.6s ease",
      }}>
        <div style={{
          width: "100%", height: "100%", borderRadius: "50%",
          background: "rgba(11,16,49,0.96)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ fontSize: "13px", fontWeight: 800, fontVariantNumeric: "tabular-nums", color }}>
            {clampedPct.toFixed(0)}%
          </span>
        </div>
      </div>
      <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-dim)" }}>{label}</span>
      {sub && <span style={{ fontSize: "10px", color: "var(--text-faint)", textAlign: "center", lineHeight: 1.3 }}>{sub}</span>}
    </div>
  );
}

function ReadyState({
  url,
  remaining,
  expiresAt,
  stats,
  onTerminate,
}: {
  url: string;
  remaining: number | null;
  expiresAt?: number | null;
  stats?: SessionStats | null;
  onTerminate: () => void;
}) {
  const hasStats = stats && (
    stats.cpu_pct !== undefined ||
    stats.gpu_pct !== undefined ||
    stats.ram_pct !== undefined ||
    stats.storage_pct !== undefined
  );

  return (
    <div className="fade-in">
      {remaining !== null && <Timer remaining={remaining} expiresAt={expiresAt} />}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-success btn-block"
        style={{ marginBottom: "12px" }}
      >
        🚀 데스크톱 열기
      </a>
      <p style={{ fontSize: "12.5px", color: "var(--text-faint)", margin: "0 0 16px" }}>
        ※ 처음 접속 시 바탕화면 로딩에 1~2분이 걸릴 수 있습니다.
      </p>

      {hasStats && (
        <div className="glass" style={{ padding: "16px", marginBottom: "16px" }}>
          <div style={{ fontSize: "10.5px", color: "var(--text-faint)", fontWeight: 600, marginBottom: "14px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            내 PC 사용량
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(68px, 1fr))", gap: "6px" }}>
            {stats!.cpu_pct !== undefined && (
              <StatRing label="CPU" pct={stats!.cpu_pct} />
            )}
            {stats!.gpu_pct !== undefined && (
              <StatRing label="GPU" pct={stats!.gpu_pct} />
            )}
            {stats!.ram_pct !== undefined && (
              <StatRing
                label="RAM"
                pct={stats!.ram_pct}
                sub={stats!.ram_used && stats!.ram_total
                  ? `${stats!.ram_used.replace("GiB", "G")} / ${stats!.ram_total.replace("GiB", "G")}`
                  : undefined}
              />
            )}
            {stats!.storage_pct !== undefined && (
              <StatRing
                label="SSD"
                pct={stats!.storage_pct}
                sub={stats!.storage_total_gb != null
                  ? `${stats!.storage_used_gb}G / ${stats!.storage_total_gb}G`
                  : undefined}
              />
            )}
          </div>
        </div>
      )}

      <button className="btn btn-danger" onClick={onTerminate}>세션 종료</button>
    </div>
  );
}

function formatRemaining(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d}일 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Timer({ remaining, expiresAt }: { remaining: number; expiresAt?: number | null }) {
  const low = remaining <= 300;
  const expiryStr = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString("ko-KR", {
        month: "numeric", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : null;
  return (
    <div
      className="glass"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        marginBottom: "14px",
        borderColor: low ? "rgba(251,113,133,0.45)" : undefined,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span style={{ fontSize: "13px", color: "var(--text-dim)" }}>남은 사용 시간</span>
        {expiryStr && (
          <span style={{ fontSize: "11px", color: "var(--text-faint)" }}>
            만료: {expiryStr}
          </span>
        )}
      </div>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 800, fontSize: "18px", color: low ? "var(--danger)" : "var(--text)" }}>
        {formatRemaining(remaining)}
      </span>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="fade-in">
      <div style={infoBox("danger")}>오류: {message}</div>
      <button className="btn btn-primary" onClick={onRetry}>다시 시도</button>
    </div>
  );
}

/* ─────────────────────── 스타일 ─────────────────────── */

const header: React.CSSProperties = {
  position: "sticky", top: 0, zIndex: 50,
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "0 22px", height: "62px",
  background: "rgba(11, 16, 49, 0.55)",
  borderBottom: "1px solid var(--glass-border)",
  backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
};
const brandBadge: React.CSSProperties = {
  width: "32px", height: "32px", borderRadius: "10px",
  display: "flex", alignItems: "center", justifyContent: "center", fontSize: "17px",
  background: "linear-gradient(135deg, rgba(124,140,255,0.35), rgba(99,102,241,0.18))",
  border: "1px solid var(--glass-border-strong)",
};
const smallBtn: React.CSSProperties = { padding: "7px 13px", fontSize: "13px" };
const mainWrap: React.CSSProperties = {
  maxWidth: "560px", margin: "0 auto", padding: "32px 20px 60px",
  display: "flex", flexDirection: "column", gap: "16px",
};
const card: React.CSSProperties = { padding: "30px" };
const cardHead: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  gap: "12px", flexWrap: "wrap",
};

const noticeBanner: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "11px", padding: "13px 16px",
  background: "rgba(124,140,255,0.12)", borderColor: "rgba(124,140,255,0.35)",
};
const footHint: React.CSSProperties = {
  textAlign: "center", color: "var(--text-faint)", fontSize: "12.5px", margin: 0,
};
const sectionTitle: React.CSSProperties = {
  margin: "0 0 12px", fontSize: "15px", fontWeight: 700, color: "var(--text-dim)",
};
const specTagStyle: React.CSSProperties = {
  padding: "3px 9px", borderRadius: "999px", fontSize: "11.5px", fontWeight: 600,
  background: "rgba(124,140,255,0.15)", border: "1px solid rgba(124,140,255,0.3)",
  color: "var(--text-dim)",
};
const modalOverlay: React.CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: "20px",
};
const modalCard: React.CSSProperties = {
  width: "100%", maxWidth: "480px", padding: "30px", maxHeight: "90vh", overflowY: "auto",
};
const formLabel: React.CSSProperties = {
  display: "block", fontSize: "13px", fontWeight: 600,
  color: "var(--text-dim)", marginBottom: "6px",
};

function infoBox(kind: "warning" | "danger"): React.CSSProperties {
  const colors = {
    warning: { bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.4)", text: "#fde68a" },
    danger:  { bg: "rgba(244,63,94,0.12)",  border: "rgba(251,113,133,0.4)", text: "#fecdd3" },
  }[kind];
  return {
    background: colors.bg, border: `1px solid ${colors.border}`, color: colors.text,
    borderRadius: "12px", padding: "14px 16px", marginBottom: "16px",
    fontSize: "14px", lineHeight: 1.55,
  };
}

export default function DashboardPage() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}
