"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ToastProvider, useToast } from "@/components/toast";

type Status =
  | "checking"
  | "idle"
  | "suspended"
  | "starting"
  | "ready"
  | "busy"
  | "queued"
  | "error";

interface SessionData {
  status: string;
  session_id?: string;
  url?: string;
  message?: string;
  expires_at?: number; // epoch seconds
  owner?: string; // 마스킹된 점유자 (다른 사용자)
  queue_position?: number;
  queue_length?: number;
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
  const [notice, setNotice] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiredRef = useRef(false);

  const clearIntervals = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    pollRef.current = null;
    timerRef.current = null;
  }, []);

  const applyData = useCallback((data: SessionData) => {
    if (typeof data.expires_at === "number") setExpiresAt(data.expires_at);
    if (data.owner) setOwner(data.owner);
    if (typeof data.queue_position === "number") setQueuePos(data.queue_position);
  }, []);

  const startPolling = useCallback(
    (session_id: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(`/api/session/${session_id}`);
          const data: SessionData = await r.json();
          applyData(data);
          if (data.status === "ready") {
            setUrl(data.url || null);
            setStatus("ready");
            if (pollRef.current) clearInterval(pollRef.current);
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
    [applyData, clearIntervals, toast]
  );

  async function handleRent() {
    setStatus("starting");
    setErrorMsg(null);
    setUrl(null);
    setElapsed(0);
    setSessionId(null);
    expiredRef.current = false;
    timerRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);

    try {
      const res = await fetch("/api/session", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          // 다른 사용자가 사용 중 → 대기열 등록됨
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

  async function handleResume() {
    setStatus("starting");
    setErrorMsg(null);
    setUrl(null);
    setElapsed(0);
    setSessionId(null);
    expiredRef.current = false;
    timerRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);

    try {
      const res = await fetch("/api/session?resume=true", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "세션 재시작 실패");
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
      setStatus("suspended");
      setSessionId(null);
      setUrl(null);
      setExpiresAt(null);
      setRemaining(null);
      clearIntervals();
      toast(
        auto ? "시간이 만료되어 세션이 종료되었습니다." : "세션을 종료했습니다.",
        auto ? "info" : "success"
      );
    },
    [sessionId, clearIntervals, toast]
  );

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  }

  // 남은 시간 카운트다운 (expires_at 기반)
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

  // busy/queued 상태일 때 자리·순번을 주기적으로 확인
  useEffect(() => {
    if (status !== "busy" && status !== "queued") return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/session");
        const data: SessionData = await r.json();
        applyData(data);
        if (data.status === "your_turn") {
          clearInterval(iv);
          toast("이제 사용할 수 있습니다! 데스크톱을 준비합니다.", "success");
          handleRent();
        } else if (data.status === "queued") {
          setStatus("queued");
          setQueuePos(data.queue_position ?? null);
        } else if (data.status === "busy") {
          setOwner(data.owner || null);
        } else if (data.status === "none" || data.status === "suspended") {
          clearInterval(iv);
          setStatus(data.status === "suspended" ? "suspended" : "idle");
        }
      } catch {
        // keep polling
      }
    }, 5000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // 초기 로드: 사용자 정보 + 공지 + 세션 복원
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
        if (data.status === "ready" && data.url) {
          setSessionId(data.session_id || null);
          setUrl(data.url);
          setStatus("ready");
          return;
        }
        if (data.status === "starting" && data.session_id) {
          setSessionId(data.session_id);
          setStatus("starting");
          startPolling(data.session_id);
          return;
        }
        if (data.status === "suspended") {
          setStatus("suspended");
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
          handleRent();
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
      <Header me={me} onLogout={handleLogout} status={status} />

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

          <SpecRow />

          <div style={{ marginTop: "24px" }}>
            {status === "checking" && <CheckingState />}

            {status === "idle" && (
              <button className="btn btn-primary btn-block" onClick={handleRent}>
                PC 대여하기
              </button>
            )}

            {status === "suspended" && (
              <SuspendedState onResume={handleResume} onFresh={handleRent} />
            )}

            {status === "busy" && (
              <BusyState owner={owner} onRetry={handleRent} />
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
                onTerminate={() => handleTerminate(false)}
              />
            )}

            {status === "error" && (
              <ErrorState message={errorMsg} onRetry={() => setStatus("idle")} />
            )}
          </div>
        </div>

        <p style={footHint}>
          ※ 학교망에서 접속이 안 되면 VPN을 켜고 다시 시도하세요.
        </p>
      </main>
    </div>
  );
}

/* ----------------------------- 하위 컴포넌트 ----------------------------- */

function Header({
  me,
  onLogout,
  status,
}: {
  me: Me | null;
  onLogout: () => void;
  status: Status;
}) {
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
    idle: { dot: "dot-success", label: "사용 가능" },
    suspended: { dot: "dot-warning", label: "저장됨" },
    starting: { dot: "dot-warning", label: "준비 중", pulse: true },
    ready: { dot: "dot-success", label: "사용 중", pulse: true },
    busy: { dot: "dot-danger", label: "다른 사용자 사용 중" },
    queued: { dot: "dot-warning", label: "대기 중", pulse: true },
    error: { dot: "dot-danger", label: "오류" },
  };
  const s = map[status];
  return (
    <span className="badge">
      <span className={`dot ${s.dot}${s.pulse ? " dot-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

function SpecRow() {
  const specs = [
    { label: "GPU", value: "NVIDIA GTX 1660", icon: "🎮" },
    { label: "OS", value: "Ubuntu MATE", icon: "🐧" },
    { label: "접속", value: "웹 브라우저", icon: "🌐" },
  ];
  return (
    <div style={specGrid}>
      {specs.map((s) => (
        <div key={s.label} className="glass" style={specCell}>
          <div style={{ fontSize: "18px", marginBottom: "4px" }}>{s.icon}</div>
          <div style={{ color: "var(--text-faint)", fontSize: "12px" }}>
            {s.label}
          </div>
          <div style={{ fontWeight: 700, fontSize: "13.5px" }}>{s.value}</div>
        </div>
      ))}
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

function SuspendedState({
  onResume,
  onFresh,
}: {
  onResume: () => void;
  onFresh: () => void;
}) {
  return (
    <div className="fade-in">
      <div style={infoBox("warning")}>
        이전에 사용하던 데스크톱 환경이 저장되어 있습니다. 이어서 사용하거나 새로
        시작할 수 있습니다.
      </div>
      <div style={{ display: "flex", gap: "12px" }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={onResume}>
          이어서 사용하기
        </button>
        <button className="btn btn-danger" style={{ flex: 1 }} onClick={onFresh}>
          새로 시작하기
        </button>
      </div>
    </div>
  );
}

function BusyState({ owner, onRetry }: { owner: string | null; onRetry: () => void }) {
  return (
    <div className="fade-in">
      <div style={infoBox("danger")}>
        현재 <b>{owner || "다른 학생"}</b> 님이 사용 중입니다. 잠시 후 다시
        시도해 주세요.
      </div>
      <button className="btn btn-ghost btn-block" onClick={onRetry}>
        다시 확인하기
      </button>
    </div>
  );
}

function QueuedState({
  owner,
  position,
}: {
  owner: string | null;
  position: number | null;
}) {
  return (
    <div className="fade-in">
      <div
        style={{
          textAlign: "center",
          padding: "8px 0 18px",
        }}
      >
        <div style={{ fontSize: "13px", color: "var(--text-dim)", marginBottom: "8px" }}>
          대기 순번
        </div>
        <div style={{ fontSize: "44px", fontWeight: 800, lineHeight: 1 }}>
          {position ?? "—"}
          <span style={{ fontSize: "18px", color: "var(--text-dim)", fontWeight: 600 }}>
            {" "}
            번째
          </span>
        </div>
      </div>
      <div style={infoBox("warning")}>
        현재 <b>{owner || "다른 학생"}</b> 님이 사용 중입니다. 자리가 나면
        자동으로 시작되며, 이 화면을 열어두기만 하면 됩니다.
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          justifyContent: "center",
          color: "var(--text-dim)",
          fontSize: "13px",
        }}
      >
        <span className="spinner" /> 자리를 기다리는 중…
      </div>
    </div>
  );
}

function StartingState({
  elapsed,
  progressPct,
}: {
  elapsed: number;
  progressPct: number;
}) {
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

function ReadyState({
  url,
  remaining,
  onTerminate,
}: {
  url: string;
  remaining: number | null;
  onTerminate: () => void;
}) {
  return (
    <div className="fade-in">
      {remaining !== null && <Timer remaining={remaining} />}

      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-success btn-block"
        style={{ marginBottom: "12px" }}
      >
        🚀 데스크톱 열기
      </a>

      <div className="glass" style={urlBox}>
        <span style={{ color: "var(--text-faint)", fontSize: "12px", flexShrink: 0 }}>
          URL
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ wordBreak: "break-all", fontSize: "13px" }}
        >
          {url}
        </a>
      </div>

      <p style={{ fontSize: "12.5px", color: "var(--text-faint)", margin: "12px 0 16px" }}>
        ※ 처음 접속 시 바탕화면 로딩에 1~2분이 걸릴 수 있습니다.
      </p>

      <button className="btn btn-danger" onClick={onTerminate}>
        세션 종료
      </button>
    </div>
  );
}

function Timer({ remaining }: { remaining: number }) {
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const low = remaining <= 300;
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
      <span style={{ fontSize: "13px", color: "var(--text-dim)" }}>남은 사용 시간</span>
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          fontWeight: 800,
          fontSize: "18px",
          color: low ? "var(--danger)" : "var(--text)",
        }}
      >
        {m}:{String(s).padStart(2, "0")}
      </span>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="fade-in">
      <div style={infoBox("danger")}>오류: {message}</div>
      <button className="btn btn-primary" onClick={onRetry}>
        다시 시도
      </button>
    </div>
  );
}

/* ----------------------------- 스타일 ----------------------------- */

const header: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 22px",
  height: "62px",
  background: "rgba(11, 16, 49, 0.55)",
  borderBottom: "1px solid var(--glass-border)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
};
const brandBadge: React.CSSProperties = {
  width: "32px",
  height: "32px",
  borderRadius: "10px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "17px",
  background: "linear-gradient(135deg, rgba(124,140,255,0.35), rgba(99,102,241,0.18))",
  border: "1px solid var(--glass-border-strong)",
};
const smallBtn: React.CSSProperties = {
  padding: "7px 13px",
  fontSize: "13px",
};
const mainWrap: React.CSSProperties = {
  maxWidth: "560px",
  margin: "0 auto",
  padding: "32px 20px 60px",
};
const card: React.CSSProperties = {
  padding: "30px",
};
const cardHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
};
const specGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: "10px",
};
const specCell: React.CSSProperties = {
  padding: "14px 10px",
  textAlign: "center",
};
const urlBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "11px 14px",
};
const noticeBanner: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "11px",
  padding: "13px 16px",
  marginBottom: "16px",
  background: "rgba(124,140,255,0.12)",
  borderColor: "rgba(124,140,255,0.35)",
};
const footHint: React.CSSProperties = {
  textAlign: "center",
  color: "var(--text-faint)",
  fontSize: "12.5px",
  marginTop: "20px",
};

function infoBox(kind: "warning" | "danger"): React.CSSProperties {
  const colors = {
    warning: {
      bg: "rgba(251,191,36,0.12)",
      border: "rgba(251,191,36,0.4)",
      text: "#fde68a",
    },
    danger: {
      bg: "rgba(244,63,94,0.12)",
      border: "rgba(251,113,133,0.4)",
      text: "#fecdd3",
    },
  }[kind];
  return {
    background: colors.bg,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    borderRadius: "12px",
    padding: "14px 16px",
    marginBottom: "16px",
    fontSize: "14px",
    lineHeight: 1.55,
  };
}

export default function DashboardPage() {
  return (
    <ToastProvider>
      <Dashboard />
    </ToastProvider>
  );
}
