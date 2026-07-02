"use client";

import { useEffect, useRef, useState } from "react";

export interface NodeInfo {
  id: string;
  name?: string;
  cpu: string;
  gpu: string;
  cpu_cores?: number;
  ram_gb: number;
  storage_gb: number;
  available: boolean;
  offline?: boolean;
  session_state?: "none" | "partial" | "full" | "suspended";
  session_count?: number;
  resource_used?: { cpu_cores: number; ram_gb: number };
  load?: { cpu_pct: number | null; ram_pct: number | null; gpu_pct: number | null } | null;
}

/* 학생용 노드 목록 (/api/nodes). MachineLedger·신청서·사이드 푸터 카운트에 사용. */
export function useNodes(pollMs = 8000) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const prevKeyRef = useRef<string>("");

  useEffect(() => {
    let alive = true;
    const fetchNodes = async () => {
      try {
        const r = await fetch("/api/nodes");
        if (r.ok) {
          const d = await r.json();
          const fresh: NodeInfo[] = d.nodes || [];
          // 실제 변경이 있을 때만 state 업데이트 — 폴링마다 새 배열 참조 생성 방지
          const key = JSON.stringify(fresh.map((n) => ({
            id: n.id, av: n.available, ss: n.session_state, sc: n.session_count, off: n.offline,
            cpu: n.load?.cpu_pct ?? null,
          })));
          if (alive && key !== prevKeyRef.current) {
            prevKeyRef.current = key;
            setNodes(fresh);
          }
        }
      } catch {
        // keep last
      } finally {
        if (alive) setLoading(false);
      }
    };
    fetchNodes();
    const iv = setInterval(fetchNodes, pollMs);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [pollMs]);

  return { nodes, loading };
}

export function isOffline(n: NodeInfo): boolean {
  return !!n.offline || n.load === null;
}

export function nodeState(n: NodeInfo): "available" | "partial" | "suspended" | "active" | "offline" {
  if (isOffline(n)) return "offline";
  if (n.session_state === "full") return "active";
  if (n.session_state === "partial") return "partial";
  if (n.session_state === "suspended") return "suspended";
  if (n.session_state === "none") return "available";
  return n.available ? "available" : "active";
}
