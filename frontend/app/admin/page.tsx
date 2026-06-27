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
  containers?: { name: string; status: string }[];
}

function fmtTime(epoch?: number) {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function AdminPanel() {
  const router = useRouter();
  const { toast } = useToast();
  const [data, setData] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    load();
    fetch("/api/notice")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.notice && setNotice(d.notice))
      .catch(() => {});
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [load]);

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
        load();
      } else {
        toast(`${label} 실패`, "error");
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

  return (
    <div className="page">
      <header style={header}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={brandBadge}>🛠️</span>
          <span style={{ fontWeight: 800, fontSize: "16px" }}>관리자 패널</span>
        </div>
        <a href="/dashboard" className="btn btn-ghost" style={{ padding: "7px 13px", fontSize: "13px" }}>
          대시보드로
        </a>
      </header>

      <main style={mainWrap}>
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
                <Info label="사용자" value={data.active.owner || "—"} />
                <Info label="상태" value={data.active.status || "ready"} />
                <Info label="시작" value={fmtTime(data.active.since)} />
                <Info label="만료 예정" value={fmtTime(data.active.expires_at)} />
              </div>
              <button
                className="btn btn-danger"
                style={{ marginTop: "16px" }}
                disabled={busy}
                onClick={() => doAction("terminate", "세션 강제 종료")}
              >
                세션 강제 종료
              </button>
            </div>
          ) : (
            <p style={{ color: "var(--text-dim)", margin: 0 }}>
              현재 활성 세션이 없습니다. PC가 비어 있습니다.
            </p>
          )}
        </section>

        {/* 대기열 */}
        <section className="glass glass-strong fade-in" style={card}>
          <h3 style={h3}>대기열 {data?.queue?.length ? `(${data.queue.length})` : ""}</h3>
          {data?.queue?.length ? (
            <ol style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.9 }}>
              {data.queue.map((e, i) => (
                <li key={i} style={{ color: "var(--text-dim)" }}>
                  {e}
                </li>
              ))}
            </ol>
          ) : (
            <p style={{ color: "var(--text-dim)", margin: 0 }}>대기 중인 학생이 없습니다.</p>
          )}
        </section>

        {/* 공지 */}
        <section className="glass glass-strong fade-in" style={card}>
          <h3 style={h3}>공지사항</h3>
          <textarea
            className="input"
            value={notice}
            onChange={(e) => setNotice(e.target.value)}
            placeholder="학생에게 표시할 공지를 입력하세요. (비우면 배너 숨김)"
            rows={3}
            style={{ resize: "vertical", marginBottom: "12px" }}
          />
          <button className="btn btn-primary" disabled={busy} onClick={saveNotice}>
            공지 저장
          </button>
        </section>

        {/* 유지보수 */}
        <section className="glass glass-strong fade-in" style={card}>
          <h3 style={h3}>유지보수</h3>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => doAction("cleanup", "중단 컨테이너 정리")}
          >
            중단된 컨테이너 정리
          </button>
        </section>
      </main>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass" style={{ padding: "12px 14px" }}>
      <div style={{ color: "var(--text-faint)", fontSize: "12px", marginBottom: "3px" }}>
        {label}
      </div>
      <div style={{ fontWeight: 700, fontSize: "14px", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

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
  fontSize: "16px",
  background: "linear-gradient(135deg, rgba(124,140,255,0.35), rgba(99,102,241,0.18))",
  border: "1px solid var(--glass-border-strong)",
};
const mainWrap: React.CSSProperties = {
  maxWidth: "640px",
  margin: "0 auto",
  padding: "28px 20px 60px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};
const card: React.CSSProperties = { padding: "24px" };
const h3: React.CSSProperties = {
  margin: "0 0 16px",
  fontSize: "16px",
  fontWeight: 700,
};
const rowGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, 1fr)",
  gap: "10px",
};

export default function AdminPage() {
  return (
    <ToastProvider>
      <AdminPanel />
    </ToastProvider>
  );
}
