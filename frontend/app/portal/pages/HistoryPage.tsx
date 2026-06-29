"use client";

import { useEffect, useState } from "react";
import s from "../atelier.module.css";
import { HelpTip } from "../ui";

interface HistoryEvent {
  ts: number;
  type: string;
  title: string;
  detail?: string;
}

interface HistoryData {
  summary: { usage_seconds: number; sessions_started: number; upload_bytes: number };
  events: HistoryEvent[];
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}분`;
  return `${h}시간 ${m}분`;
}

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)}KB`;
  return `${b}B`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

export default function HistoryPage() {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const summary = data?.summary ?? { usage_seconds: 0, sessions_started: 0, upload_bytes: 0 };
  const events = data?.events ?? [];

  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>사용 기록</h1>
          <HelpTip text="최근 30일간의 세션과 파일 전송 기록입니다." />
        </div>
      </div>

      <section className={s.fullSheet}>
        <div className={s.historySummary}>
          <div>
            <span>이번 달 사용</span>
            <strong>{fmtDuration(summary.usage_seconds)}</strong>
          </div>
          <div>
            <span>시작한 작업</span>
            <strong>{summary.sessions_started}회</strong>
          </div>
          <div>
            <span>파일 전송</span>
            <strong>{fmtBytes(summary.upload_bytes)}</strong>
          </div>
        </div>

        <div className={s.historyList}>
          {loading ? (
            <article>
              <time />
              <span />
              <div>
                <strong>불러오는 중…</strong>
              </div>
            </article>
          ) : events.length === 0 ? (
            <article>
              <time />
              <span />
              <div>
                <strong>아직 기록이 없습니다.</strong>
                <p>세션을 시작하거나 파일을 전송하면 이곳에 기록됩니다.</p>
              </div>
            </article>
          ) : (
            events.map((ev, index) => (
              <article key={`${ev.ts}-${index}`}>
                <time>{fmtTime(ev.ts)}</time>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{ev.title}</strong>
                  {ev.detail && <p>{ev.detail}</p>}
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
