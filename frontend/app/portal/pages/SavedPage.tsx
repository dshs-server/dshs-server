"use client";

import { useState } from "react";
import s from "../atelier.module.css";
import { HelpTip, ConfirmSheet, Overlay, formatDateTime } from "../ui";
import { DurationPicker } from "../RequestSheet";
import type { SessionController } from "../useSession";
import type { Page } from "../PortalShell";

const ADMIN_EMAIL = "ts250024@ts.hs.kr";

export default function SavedPage({
  ctrl,
  onNavigate,
}: {
  ctrl: SessionController;
  onNavigate: (p: Page) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingResumeId, setPendingResumeId] = useState<string | null>(null);
  const [resumeDuration, setResumeDuration] = useState(7);
  const items = ctrl.suspendedSessions;
  const isAdmin = !!ctrl.me?.isAdmin;

  function openResume(id: string) {
    setResumeDuration(7);
    setPendingResumeId(id);
  }

  function confirmResume() {
    if (!pendingResumeId) return;
    ctrl.handleResume(pendingResumeId, resumeDuration);
    setPendingResumeId(null);
    onNavigate("work");
  }

  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>보관함</h1>
          <HelpTip text="종료한 작업 환경은 보관됩니다. 이어하기 시 종료 기한을 선택합니다." />
        </div>
        <span className={s.pageTitleDate}>{items.length}개 저장됨</span>
      </div>

      {items.length === 0 ? (
        <div className={s.savedEmpty}>
          보관 중인 작업이 없습니다. 세션을 종료하면 이곳에 저장됩니다.
        </div>
      ) : (
        <div className={s.savedCards}>
          {items.map((item, index) => {
            const blocked = !!item.extend_blocked;
            return (
              <article className={s.savedCard} key={item.id}>
                <header className={s.savedCardHead}>
                  <span className={s.savedIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h2>{item.project_name || "저장된 세션"}</h2>
                    <p>{item.saved_at ? `${formatDateTime(item.saved_at)} 저장` : "저장됨"}</p>
                  </div>
                </header>
                <dl className={s.savedCardMeta}>
                  <div>
                    <dt>환경</dt>
                    <dd>{specSummary(item.resources)}</dd>
                  </div>
                  <div>
                    <dt>저장 용량</dt>
                    <dd>
                      {item.resources?.storage_used_gb != null
                        ? `${item.resources.storage_used_gb}/${item.resources.storage_gb ?? "—"}GB`
                        : item.resources?.storage_gb
                        ? `—/${item.resources.storage_gb}GB`
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>자동 삭제</dt>
                    <dd>{item.delete_after ? formatDateTime(item.delete_after) : "—"}</dd>
                  </div>
                </dl>
                <footer className={s.savedCardFoot}>
                  {blocked ? (
                    <>
                      <a
                        href={`mailto:${ADMIN_EMAIL}?subject=[PC대여] 세션 재개 허가 요청`}
                        className={s.lineButton}
                      >
                        관리자에게 연락하기
                      </a>
                      <span style={{ fontSize: "9px", color: "var(--faint)", alignSelf: "center" }}>
                        총 이용 40일 초과
                      </span>
                    </>
                  ) : (
                    <>
                      <button className={s.solidButton} onClick={() => openResume(item.id)}>
                        이어하기
                      </button>
                      <button className={s.quietButton} onClick={() => setPendingDelete(item.id)}>
                        삭제
                      </button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {pendingResumeId && (
        <Overlay>
          <section className={`${s.uploadSheet} ${s.durationSheet}`}>
            <header>
              <div>
                <span>이어하기</span>
                <h2>종료 기한 선택</h2>
              </div>
              <button onClick={() => setPendingResumeId(null)}>닫기</button>
            </header>
            <div className={s.formMain} style={{ padding: "24px" }}>
              <p style={{ margin: "0 0 16px", color: "var(--dim)", fontSize: "13px" }}>
                이어서 사용할 기간을 선택하세요. 이전 세션 생성 시점부터 총 40일을 초과할 수 없습니다.
              </p>
              <DurationPicker value={resumeDuration} onChange={setResumeDuration} isAdmin={isAdmin} />
            </div>
            <footer>
              <span style={{ flex: 1 }} />
              <button className={s.lineButton} onClick={() => setPendingResumeId(null)}>취소</button>
              <button
                className={s.solidButton}
                disabled={resumeDuration === -1}
                onClick={confirmResume}
              >
                이어하기
              </button>
            </footer>
          </section>
        </Overlay>
      )}

      {pendingDelete && (
        <ConfirmSheet
          title="파일 완전히 제거"
          message="저장된 세션의 모든 파일과 설치된 패키지가 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
          confirmLabel="영구 삭제"
          danger
          onConfirm={() => { ctrl.handlePermanentDelete(pendingDelete); setPendingDelete(null); }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function specSummary(r?: { cpu_cores?: number; ram_gb?: number; gpu?: string }) {
  if (!r) return "—";
  const parts = [r.gpu, r.cpu_cores ? `${r.cpu_cores} Core` : null, r.ram_gb ? `${r.ram_gb}GB` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}
