"use client";

import type { ReactNode } from "react";
import s from "./atelier.module.css";

export function HelpTip({ text }: { text: string }) {
  return (
    <span className={s.helpTip}>
      <button aria-label="도움말" type="button">
        ?
      </button>
      <span role="tooltip">{text}</span>
    </span>
  );
}

export function PowerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 2v10" />
      <path d="M6.3 5.3a8 8 0 1 0 11.4 0" />
    </svg>
  );
}

export function Overlay({ children }: { children: ReactNode }) {
  return <div className={s.overlay}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className={s.fieldLabel}>
      <span>{label}</span>
      <div>{children}</div>
    </label>
  );
}

export function ConfirmSheet({
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
    <Overlay>
      <section className={s.uploadSheet} style={{ width: "min(440px, 94vw)" }}>
        <header>
          <div>
            <h2>{title}</h2>
          </div>
          <button onClick={onCancel}>닫기</button>
        </header>
        <p style={{ margin: "22px 24px", lineHeight: 1.6 }}>{message}</p>
        <footer>
          <span style={{ flex: 1 }} />
          <button className={s.lineButton} onClick={onCancel}>
            취소
          </button>
          <button className={s.solidButton} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </Overlay>
  );
}

export function formatRemaining(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const sec = seconds % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  return `${d}일 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatDateTime(epoch?: number | null): string {
  if (!epoch) return "—";
  try {
    return new Date(epoch * 1000).toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
