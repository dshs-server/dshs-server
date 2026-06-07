"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type Status = "checking" | "idle" | "suspended" | "starting" | "ready" | "error";

export default function DashboardPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearIntervals() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  function startPolling(session_id: string) {
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/session/${session_id}`);
        const data = await r.json();
        if (data.status === "ready") {
          setUrl(data.url);
          setStatus("ready");
          clearIntervals();
        } else if (data.status === "error") {
          setErrorMsg(data.message || "알 수 없는 오류");
          setStatus("error");
          clearIntervals();
        }
      } catch {
        // keep polling
      }
    }, 3000);
  }

  async function handleRent() {
    setStatus("starting");
    setErrorMsg(null);
    setUrl(null);
    setElapsed(0);
    setSessionId(null);

    timerRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);

    try {
      const res = await fetch("/api/session", { method: "POST" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "세션 생성 실패");
      }
      const { session_id } = await res.json();
      setSessionId(session_id);
      startPolling(session_id);
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

    timerRef.current = setInterval(() => setElapsed((n) => n + 1), 1000);

    try {
      const res = await fetch("/api/session?resume=true", { method: "POST" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "세션 재시작 실패");
      }
      const { session_id } = await res.json();
      setSessionId(session_id);
      startPolling(session_id);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "오류 발생");
      clearIntervals();
    }
  }

  async function handleTerminate() {
    if (!sessionId) return;
    try {
      await fetch(`/api/session/${sessionId}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    setStatus("suspended");
    setSessionId(null);
    setUrl(null);
    clearIntervals();
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  }

  // 페이지 로드 시 활성 세션 복원
  useEffect(() => {
    async function restoreSession() {
      try {
        const res = await fetch("/api/session");
        const data = await res.json();
        if (data.status === "ready" && data.url) {
          setSessionId(data.session_id);
          setUrl(data.url);
          setStatus("ready");
          return;
        } else if (data.status === "starting" && data.session_id) {
          setSessionId(data.session_id);
          setStatus("starting");
          startPolling(data.session_id);
        } else if (data.status === "suspended") {
          setStatus("suspended");
        }
      } catch {
        // 복원 실패 시 idle로
      } finally {
        setStatus((prev) => (prev === "checking" ? "idle" : prev));
      }
    }
    restoreSession();
    return () => clearIntervals();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progressPct = Math.min(elapsed * 3, 92);

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f5" }}>
      {/* Header */}
      <div
        style={{
          background: "white",
          borderBottom: "1px solid #e2e8f0",
          padding: "0 32px",
          height: "56px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontWeight: 700, fontSize: "18px" }}>PC 대여 포털</span>
        <button
          onClick={handleLogout}
          style={{
            padding: "6px 14px",
            background: "transparent",
            border: "1px solid #cbd5e0",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "14px",
          }}
        >
          로그아웃
        </button>
      </div>

      {/* Main */}
      <div
        style={{
          maxWidth: "600px",
          margin: "48px auto",
          padding: "0 24px",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "12px",
            padding: "40px",
            boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: "22px" }}>
            GPU 데스크톱 대여
          </h2>
          <p style={{ margin: "0 0 28px", color: "#718096", fontSize: "14px" }}>
            브라우저에서 Ubuntu MATE 데스크톱을 사용할 수 있습니다.
          </p>

          {/* Spec info */}
          <div
            style={{
              background: "#f7fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "16px",
              marginBottom: "28px",
              fontSize: "14px",
            }}
          >
            <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
              <div>
                <span style={{ color: "#718096" }}>GPU</span>
                <div style={{ fontWeight: 600 }}>NVIDIA RTX 3080</div>
              </div>
              <div>
                <span style={{ color: "#718096" }}>OS</span>
                <div style={{ fontWeight: 600 }}>Ubuntu MATE</div>
              </div>
              <div>
                <span style={{ color: "#718096" }}>접속 방식</span>
                <div style={{ fontWeight: 600 }}>웹 브라우저</div>
              </div>
            </div>
          </div>

          {/* Checking state: 아무것도 표시하지 않음 */}

          {/* Suspended state */}
          {status === "suspended" && (
            <div>
              <div
                style={{
                  background: "#fffbeb",
                  border: "1px solid #f6e05e",
                  borderRadius: "8px",
                  padding: "16px",
                  marginBottom: "20px",
                  fontSize: "14px",
                  color: "#744210",
                }}
              >
                이전에 사용하던 데스크톱 환경이 저장되어 있습니다.
                이어서 사용하거나 새로 시작할 수 있습니다.
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <button
                  onClick={handleResume}
                  style={{
                    flex: 1,
                    padding: "12px",
                    background: "#3182ce",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    fontSize: "15px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  이어서 사용하기
                </button>
                <button
                  onClick={handleRent}
                  style={{
                    flex: 1,
                    padding: "12px",
                    background: "transparent",
                    color: "#e53e3e",
                    border: "1px solid #fc8181",
                    borderRadius: "8px",
                    fontSize: "15px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  새로 시작하기
                </button>
              </div>
            </div>
          )}

          {/* Idle state */}
          {status === "idle" && (
            <button
              onClick={handleRent}
              style={{
                width: "100%",
                padding: "14px",
                background: "#3182ce",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontSize: "16px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              PC 대여하기
            </button>
          )}

          {/* Starting state */}
          {status === "starting" && (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  marginBottom: "16px",
                }}
              >
                <Spinner />
                <span style={{ fontWeight: 500 }}>
                  데스크톱 환경을 준비하는 중...
                </span>
              </div>

              {/* Progress bar */}
              <div
                style={{
                  background: "#e2e8f0",
                  borderRadius: "8px",
                  height: "8px",
                  overflow: "hidden",
                  marginBottom: "12px",
                }}
              >
                <div
                  style={{
                    width: `${progressPct}%`,
                    height: "100%",
                    background: "#3182ce",
                    borderRadius: "8px",
                    transition: "width 1s linear",
                  }}
                />
              </div>

              <p style={{ color: "#718096", fontSize: "14px", margin: 0 }}>
                경과 시간: {elapsed}초 &nbsp;·&nbsp; 보통 15~30초 소요됩니다.
              </p>
            </div>
          )}

          {/* Ready state */}
          {status === "ready" && url && (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "16px",
                  color: "#276749",
                  fontWeight: 600,
                }}
              >
                <span style={{ fontSize: "20px" }}>✓</span>
                <span>데스크톱이 준비되었습니다!</span>
              </div>

              <div
                style={{
                  background: "#f0fff4",
                  border: "1px solid #9ae6b4",
                  borderRadius: "8px",
                  padding: "16px",
                  marginBottom: "16px",
                }}
              >
                <p style={{ margin: "0 0 8px", fontSize: "13px", color: "#276749" }}>
                  접속 URL
                </p>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    wordBreak: "break-all",
                    color: "#2b6cb0",
                    fontSize: "15px",
                    fontWeight: 500,
                  }}
                >
                  {url}
                </a>
              </div>

              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "block",
                  width: "100%",
                  padding: "12px",
                  background: "#38a169",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "15px",
                  fontWeight: 600,
                  textAlign: "center",
                  textDecoration: "none",
                  marginBottom: "12px",
                  boxSizing: "border-box",
                }}
              >
                데스크톱 열기
              </a>

              <p
                style={{
                  fontSize: "13px",
                  color: "#718096",
                  margin: "0 0 16px",
                }}
              >
                ※ 처음 접속 시 바탕화면 로딩에 1~2분이 걸릴 수 있습니다.
              </p>

              <button
                onClick={handleTerminate}
                style={{
                  padding: "8px 16px",
                  background: "transparent",
                  border: "1px solid #fc8181",
                  color: "#e53e3e",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                세션 종료
              </button>
            </div>
          )}

          {/* Error state */}
          {status === "error" && (
            <div>
              <div
                style={{
                  background: "#fff5f5",
                  border: "1px solid #feb2b2",
                  borderRadius: "8px",
                  padding: "16px",
                  marginBottom: "16px",
                  color: "#c53030",
                }}
              >
                오류: {errorMsg}
              </div>
              <button
                onClick={() => setStatus("idle")}
                style={{
                  padding: "10px 20px",
                  background: "#3182ce",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                다시 시도
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: "20px",
        height: "20px",
        border: "3px solid #e2e8f0",
        borderTop: "3px solid #3182ce",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
        flexShrink: 0,
      }}
    >
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
