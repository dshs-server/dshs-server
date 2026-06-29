"use client";

import { useState } from "react";
import s from "../atelier.module.css";
import { HelpTip, ConfirmSheet, formatDateTime } from "../ui";
import type { SessionController } from "../useSession";
import type { Page } from "../PortalShell";

export default function SavedPage({
  ctrl,
  onNavigate,
}: {
  ctrl: SessionController;
  onNavigate: (p: Page) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const items = ctrl.suspendedSessions;

  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>보관함</h1>
          <HelpTip text="종료한 작업 환경은 30일간 보관됩니다." />
        </div>
      </div>

      <section className={s.fullSheet}>
        <div className={s.sheetTools}>
          <strong>{items.length}개 작업</strong>
        </div>

        {items.length === 0 ? (
          <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--dim)" }}>
            보관 중인 작업이 없습니다. 세션을 종료하면 이곳에 저장됩니다.
          </div>
        ) : (
          items.map((item, index) => (
            <article className={s.savedItem} key={item.id}>
              <span className={s.savedIndex}>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{item.project_name || "저장된 세션"}</h2>
                <p>{item.saved_at ? `${formatDateTime(item.saved_at)} 저장` : "저장됨"}</p>
              </div>
              <dl>
                <div>
                  <dt>환경</dt>
                  <dd>{specSummary(item.resources)}</dd>
                </div>
                <div>
                  <dt>저장 용량</dt>
                  <dd>{item.resources?.storage_gb ? `${item.resources.storage_gb}GB` : "—"}</dd>
                </div>
                <div>
                  <dt>자동 삭제</dt>
                  <dd>{item.delete_after ? formatDateTime(item.delete_after) : "—"}</dd>
                </div>
              </dl>
              <button
                className={s.solidButton}
                onClick={() => {
                  ctrl.handleResume(item.id);
                  onNavigate("work");
                }}
              >
                이어하기
              </button>
              <button className={s.quietButton} onClick={() => setPendingDelete(item.id)}>
                삭제
              </button>
            </article>
          ))
        )}
      </section>

      {pendingDelete && (
        <ConfirmSheet
          title="파일 완전히 제거"
          message="저장된 세션의 모든 파일과 설치된 패키지가 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
          confirmLabel="영구 삭제"
          danger
          onConfirm={() => {
            ctrl.handlePermanentDelete(pendingDelete);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function specSummary(r?: { cpu_cores?: number; ram_gb?: number; gpu?: string }) {
  if (!r) return "—";
  const parts = [r.gpu, r.cpu_cores ? `${r.cpu_cores} Core` : null, r.ram_gb ? `${r.ram_gb}GB` : null].filter(
    Boolean
  );
  return parts.length ? parts.join(" · ") : "—";
}
