"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/components/toast";

/* 운영 세션 상태머신 — 기존 app/dashboard/page.tsx 로직을 그대로 이식한 훅.
   ivory UI(WorkPage/SavedPage 등)가 이 훅을 소비한다. */

export type Status =
  | "checking"
  | "idle"
  | "starting"
  | "ready"
  | "busy"
  | "queued"
  | "error"
  | "migrating";

export interface SessionStats {
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
  top_process?: string;
}

export interface SuspendedSession {
  id: string;
  node_id?: string;
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

export interface NewSessionForm {
  project_name: string;
  team_members: string[];
  cpu_cores: number;
  ram_gb: number;
  storage_gb: number;
  duration_days: number;
  work_type?: string;
  node_id?: string;
}

export interface SessionData {
  status: string;
  session_id?: string;
  url?: string;
  terminal_url?: string;
  message?: string;
  expires_at?: number;
  owner?: string;
  queue_position?: number;
  suspended_sessions?: SuspendedSession[];
  project_name?: string;
  work_type?: string;
  node_id?: string;
  node_name?: string;
  node_gpu?: string;
  node_ip?: string;
  original_created_at?: number;
  extend_blocked?: boolean;
}

export interface ActiveMeta {
  project_name?: string;
  work_type?: string;
  node_id?: string;
  node_name?: string;
  node_gpu?: string;
  node_ip?: string;
}

export interface Me {
  email: string;
  isAdmin: boolean;
}

export function useSession() {
  const { toast } = useToast();

  const [status, setStatus] = useState<Status>("checking");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const elapsedRef = useRef(0); // state로 두면 1초마다 전체 리렌더링 유발
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [queuePos, setQueuePos] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suspendedSessions, setSuspendedSessions] = useState<SuspendedSession[]>([]);
  const [migratingMsg, setMigratingMsg] = useState<string | null>(null);
  const [activeMeta, setActiveMeta] = useState<ActiveMeta>({});
  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [replaceSessionId, setReplaceSessionId] = useState<string | null>(null);
  const [extendBlocked, setExtendBlocked] = useState(false);

  const captureMeta = useCallback((data: SessionData) => {
    setActiveMeta({
      project_name: data.project_name,
      work_type: data.work_type,
      node_id: data.node_id,
      node_name: data.node_name,
      node_gpu: data.node_gpu,
      node_ip: data.node_ip,
    });
  }, []);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiredRef = useRef(false);

  const clearIntervals = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    if (statsRef.current) clearInterval(statsRef.current);
    if (queuePollRef.current) clearInterval(queuePollRef.current);
    pollRef.current = null;
    timerRef.current = null;
    statsRef.current = null;
    queuePollRef.current = null;
  }, []);

  const applyData = useCallback((data: SessionData) => {
    if (typeof data.expires_at === "number") setExpiresAt(data.expires_at);
    if (data.owner) setOwner(data.owner);
    if (typeof data.queue_position === "number") setQueuePos(data.queue_position);
    if (Array.isArray(data.suspended_sessions)) setSuspendedSessions(data.suspended_sessions);
    if (typeof data.extend_blocked === "boolean") setExtendBlocked(data.extend_blocked);
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
            setTerminalUrl(data.terminal_url || null);
            captureMeta(data);
            if (pollRef.current) clearInterval(pollRef.current);
            try {
              const sr = await fetch(`/api/session/${sid}/stats`);
              if (sr.ok) setStats(await sr.json());
            } catch {}
            setMigratingMsg(null);
            setStatus("ready");
            startStatsPolling(sid);
            toast("데스크톱이 준비되었습니다!", "success");
          } else if (data.status === "error") {
            setErrorMsg(data.message || "알 수 없는 오류");
            setStatus("error");
            clearIntervals();
            toast("세션 준비에 실패했습니다.", "error");
          } else if (data.status === "migrating") {
            if (data.message) setMigratingMsg(data.message);
          } else if (data.status === "starting") {
            setStatus((prev) => (prev === "migrating" ? "starting" : prev));
          }
        } catch {
          // keep polling
        }
      }, 3000);
    },
    [applyData, captureMeta, clearIntervals, startStatsPolling, toast]
  );

  const handleStartNew = useCallback(
    async (form: NewSessionForm, replaceId?: string) => {
      setShowNewSessionModal(false);
      setReplaceSessionId(null);
      setStatus("starting");
      setErrorMsg(null);
      setUrl(null);
      elapsedRef.current = 0;
      setSessionId(null);
      expiredRef.current = false;
      timerRef.current = setInterval(() => { elapsedRef.current += 1; }, 1000);

      try {
        const body = {
          project_name: form.project_name,
          team_members: form.team_members,
          node_id: form.node_id,
          work_type: form.work_type,
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
        setActiveMeta({
          project_name: form.project_name,
          work_type: form.work_type,
          node_id: form.node_id,
        });
        setSessionId(data.session_id);
        startPolling(data.session_id);
        toast("데스크톱을 준비하고 있습니다…", "info");
      } catch (e) {
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "오류 발생");
        clearIntervals();
      }
    },
    [applyData, clearIntervals, startPolling, toast]
  );

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

  const handleTerminate = useCallback(
    async (auto = false) => {
      const sid = sessionId;
      if (!sid) return;
      let deleteAfter: number | undefined;
      try {
        const response = await fetch(`/api/session/${sid}`, { method: "DELETE" });
        if (response.ok) {
          const data = await response.json();
          deleteAfter = data.delete_after;
        }
      } catch {
        // ignore
      }
      setSuspendedSessions((prev) =>
        prev.some((s) => s.id === sid)
          ? prev
          : [...prev, { id: sid, saved_at: Date.now() / 1000, delete_after: deleteAfter }]
      );
      setStatus("idle");
      setSessionId(null);
      setUrl(null);
      setTerminalUrl(null);
      setExpiresAt(null);
      setRemaining(null);
      setStats(null);
      setActiveMeta({});
      clearIntervals();
      toast(
        auto ? "시간이 만료되어 세션이 종료되었습니다." : "세션을 종료했습니다.",
        auto ? "info" : "success"
      );
    },
    [sessionId, clearIntervals, toast]
  );

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

  const handlePermanentDelete = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/session/${id}?permanent=true`, { method: "DELETE" });
      } catch {
        // ignore
      }
      setSuspendedSessions((prev) => prev.filter((s) => s.id !== id));
      toast("세션을 완전히 삭제했습니다.", "success");
    },
    [toast]
  );

  const handleMigrate = useCallback(
    async (suspendedId: string, targetNodeId: string, durationDays: number) => {
      setStatus("migrating");
      setMigratingMsg("컨테이너 스냅샷 생성 중…");
      setErrorMsg(null);
      setUrl(null);
      elapsedRef.current = 0;
      setSessionId(suspendedId);
      expiredRef.current = false;
      timerRef.current = setInterval(() => { elapsedRef.current += 1; }, 1000);

      try {
        const res = await fetch(`/api/session/${suspendedId}/migrate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_node_id: targetNodeId, duration_days: durationDays }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "이전 요청 실패");
        }
        setSuspendedSessions((prev) => prev.filter((x) => x.id !== suspendedId));
        startPolling(suspendedId);
        toast("환경을 다른 PC로 이전하고 있습니다…", "info");
      } catch (e) {
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "오류 발생");
        clearIntervals();
      }
    },
    [clearIntervals, startPolling, toast]
  );

  const handleCheckAvailability = useCallback(async () => {
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
  }, [applyData, toast]);

  const handleLogout = useCallback(async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }, []);

  // 세션 준비 중 페이지 이탈 경고 (origin/main showNavWarning 포팅)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (status === "starting") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [status]);

  // 남은 시간 카운트다운 + 만료 자동 종료
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

  // busy/queued 동안 자리 확인 폴링
  useEffect(() => {
    if (status !== "busy" && status !== "queued") return;
    queuePollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/session");
        const data: SessionData = await r.json();
        applyData(data);
        if (data.status === "your_turn") {
          if (queuePollRef.current) clearInterval(queuePollRef.current);
          queuePollRef.current = null;
          toast("이제 사용할 수 있습니다!", "success");
          setStatus("idle");
          setShowNewSessionModal(true);
        } else if (data.status === "queued") {
          setStatus("queued");
          setQueuePos(data.queue_position ?? null);
        } else if (data.status === "busy") {
          setOwner(data.owner || null);
        } else if (data.status === "none" || data.status === "suspended") {
          if (queuePollRef.current) clearInterval(queuePollRef.current);
          queuePollRef.current = null;
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
    return () => {
      if (queuePollRef.current) clearInterval(queuePollRef.current);
      queuePollRef.current = null;
    };
  }, [status, applyData, toast]);

  // 최초 진입: me / notice / 세션 복원
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
          setTerminalUrl(data.terminal_url || null);
          captureMeta(data);
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
          captureMeta(data);
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

  return {
    status,
    setStatus,
    sessionId,
    url,
    terminalUrl,
    errorMsg,
    expiresAt,
    remaining,
    owner,
    queuePos,
    me,
    stats,
    notice,
    suspendedSessions,
    activeMeta,
    showNewSessionModal,
    setShowNewSessionModal,
    replaceSessionId,
    setReplaceSessionId,
    handleStartNew,
    handleResume,
    handleMigrate,
    handleTerminate,
    handleExtend,
    handlePermanentDelete,
    handleCheckAvailability,
    handleLogout,
    extendBlocked,
    migratingMsg,
  };
}

export type SessionController = ReturnType<typeof useSession>;
