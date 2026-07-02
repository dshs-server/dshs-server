"use client";

import { useState } from "react";
import s from "../atelier.module.css";
import { HelpTip, ConfirmSheet, Overlay, formatDateTime } from "../ui";
import { DurationPicker } from "../RequestSheet";
import { nodeState, isOffline, type NodeInfo } from "../useNodes";
import type { SessionController } from "../useSession";
import type { Page } from "../PortalShell";

const ADMIN_EMAIL = "ts250024@ts.hs.kr";

export default function SavedPage({
  ctrl,
  nodes,
  onNavigate,
  onModalChange,
}: {
  ctrl: SessionController;
  nodes: NodeInfo[];
  onNavigate: (p: Page) => void;
  onModalChange?: (open: boolean) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingResumeId, setPendingResumeId] = useState<string | null>(null);
  const [pendingResumeNodeId, setPendingResumeNodeId] = useState<string | null>(null);
  const [resumeDuration, setResumeDuration] = useState(7);
  const [migrateMode, setMigrateMode] = useState<"same" | "different">("same");
  const [selectedMigrateNode, setSelectedMigrateNode] = useState<string | null>(null);
  const items = ctrl.suspendedSessions;
  const isAdmin = !!ctrl.me?.isAdmin;

  function openResume(id: string, currentNodeId?: string) {
    setResumeDuration(7);
    setMigrateMode("same");
    setSelectedMigrateNode(null);
    setPendingResumeNodeId(currentNodeId ?? null);
    setPendingResumeId(id);
    onModalChange?.(true);
  }

  function closeResume() {
    setPendingResumeId(null);
    onModalChange?.(false);
  }

  function confirmResume() {
    if (!pendingResumeId) return;
    if (migrateMode === "different" && selectedMigrateNode) {
      ctrl.handleMigrate(pendingResumeId, selectedMigrateNode, resumeDuration);
    } else {
      ctrl.handleResume(pendingResumeId, resumeDuration);
    }
    closeResume();
    onNavigate("work");
  }

  const canConfirm =
    migrateMode === "same"
      ? resumeDuration !== -1
      : !!selectedMigrateNode && resumeDuration !== -1;

  // 이전 대상 노드: 오프라인 제외, 현재 노드 제외, 꽉 찬 노드 제외
  const migrateTargets = nodes.filter((n) => {
    if (n.id === pendingResumeNodeId) return false;
    const st = nodeState(n);
    return st !== "offline" && st !== "active";
  });

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
                      <button className={s.solidButton} onClick={() => openResume(item.id, item.node_id)}>
                        이어하기
                      </button>
                      <button className={s.quietButton} onClick={() => { setPendingDelete(item.id); onModalChange?.(true); }}>
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
            </header>
            <div className={s.formMain} style={{ padding: "24px" }}>
              <p style={{ margin: "0 0 16px", color: "var(--dim)", fontSize: "13px" }}>
                이어서 사용할 기간을 선택하세요. 이전 세션 생성 시점부터 총 40일을 초과할 수 없습니다.
              </p>
              <DurationPicker value={resumeDuration} onChange={setResumeDuration} isAdmin={isAdmin} />

              {/* PC 선택 */}
              <div style={{ marginTop: "24px" }}>
                <p style={{ margin: "0 0 10px", fontSize: "13px", fontWeight: 600, color: "var(--fg)" }}>
                  사용할 PC
                </p>
                <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "13px" }}>
                    <input
                      type="radio"
                      name="migrateMode"
                      checked={migrateMode === "same"}
                      onChange={() => { setMigrateMode("same"); setSelectedMigrateNode(null); }}
                    />
                    같은 PC에서 이어하기
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "13px" }}>
                    <input
                      type="radio"
                      name="migrateMode"
                      checked={migrateMode === "different"}
                      onChange={() => setMigrateMode("different")}
                    />
                    다른 PC로 이전
                  </label>
                </div>

                {migrateMode === "different" && (
                  <div>
                    {migrateTargets.length === 0 ? (
                      <p style={{ fontSize: "12px", color: "var(--dim)", margin: 0 }}>
                        이전 가능한 PC가 없습니다.
                      </p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "240px", overflowY: "auto" }}>
                        {migrateTargets.map((node, idx) => {
                          const st = nodeState(node);
                          const sc = node.session_count ?? 0;
                          const label =
                            st === "partial" ? `${sc}명 사용 중` : "비어 있음";
                          return (
                            <button
                              key={node.id}
                              onClick={() => setSelectedMigrateNode(node.id)}
                              data-on={selectedMigrateNode === node.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                padding: "8px 12px",
                                border: `1.5px solid ${selectedMigrateNode === node.id ? "var(--accent, #3b82f6)" : "var(--border, #e5e7eb)"}`,
                                borderRadius: "8px",
                                background: selectedMigrateNode === node.id ? "var(--accent-subtle, #eff6ff)" : "var(--card-bg, #fff)",
                                cursor: "pointer",
                                textAlign: "left",
                              }}
                            >
                              <span style={{ fontVariantNumeric: "tabular-nums", fontSize: "12px", color: "var(--dim)", minWidth: "20px" }}>
                                {String(nodes.findIndex((n) => n.id === node.id) + 1).padStart(2, "0")}
                              </span>
                              <div style={{ flex: 1 }}>
                                <strong style={{ fontSize: "13px" }}>{node.name || node.id}</strong>
                                <small style={{ display: "block", fontSize: "11px", color: "var(--dim)" }}>
                                  {node.gpu} · {node.ram_gb}GB
                                </small>
                              </div>
                              <span style={{ fontSize: "11px", color: "var(--dim)" }}>{label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <p style={{ fontSize: "11px", color: "var(--dim)", margin: "10px 0 0" }}>
                      이전 시 설치된 소프트웨어와 파일이 그대로 옮겨집니다. 수 분이 소요됩니다.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <footer>
              <span style={{ flex: 1 }} />
              <button className={s.lineButton} onClick={closeResume}>취소</button>
              <button
                className={s.solidButton}
                disabled={!canConfirm}
                onClick={confirmResume}
              >
                {migrateMode === "different" ? "이전 시작" : "이어하기"}
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
          onConfirm={() => { ctrl.handlePermanentDelete(pendingDelete); setPendingDelete(null); onModalChange?.(false); }}
          onCancel={() => { setPendingDelete(null); onModalChange?.(false); }}
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
