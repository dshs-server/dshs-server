"use client";

import { useState, useEffect } from "react";

/* =========================================================
   사용 가이드 / 도움말
   - HelpButton  : 헤더에 두는 "도움말" 버튼
   - GuideBanner : 첫 방문 시 보여주는 안내 배너 (닫기 가능)
   - GuideModal  : 단계별 사용법 + 팁 + 자주 묻는 질문
   ========================================================= */

const GUIDE_DISMISS_KEY = "pc_rental_guide_dismissed";

interface Step {
  icon: string;
  title: string;
  desc: string;
}

const STEPS: Step[] = [
  {
    icon: "🖱️",
    title: "PC 대여하기",
    desc: "“PC 대여하기” 버튼을 눌러 새 세션을 시작합니다. 사용 가능한 상태일 때만 활성화됩니다.",
  },
  {
    icon: "⚙️",
    title: "프로젝트·사양 설정",
    desc: "프로젝트 이름과 팀원(@ts.hs.kr)을 입력하고, 필요한 최소 사양(CPU·RAM·저장공간)과 유지 기간을 정한 뒤 사용할 PC를 고릅니다.",
  },
  {
    icon: "🚀",
    title: "데스크톱 열기",
    desc: "준비가 끝나면 “데스크톱 열기”를 눌러 브라우저에서 Ubuntu MATE 환경을 그대로 사용합니다. 첫 로딩에 1~2분 걸릴 수 있어요.",
  },
  {
    icon: "💾",
    title: "저장하고 이어서 쓰기",
    desc: "세션을 종료하면 작업 환경이 “저장된 세션”으로 보존됩니다. 다음에 “이어서 사용하기”로 그대로 복원할 수 있습니다.",
  },
];

interface Tip {
  icon: string;
  text: string;
}

const TIPS: Tip[] = [
  { icon: "⏰", text: "종료 5분 전 알림이 표시됩니다. 알림이 오면 작업을 꼭 저장하세요." },
  { icon: "🌐", text: "학교망에서 접속이 안 되면 VPN을 켜고 다시 시도하세요." },
  { icon: "👥", text: "팀원도 같은 @ts.hs.kr 계정만 추가할 수 있습니다." },
  { icon: "🗑️", text: "“파일 완전히 제거”는 모든 파일·패키지를 영구 삭제하며 되돌릴 수 없습니다." },
];

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: "세션 시간이 만료되면 작업한 파일은 어떻게 되나요?",
    a: "자동으로 “저장된 세션”에 보존됩니다. 대시보드의 “이어서 사용하기”를 누르면 마지막 상태 그대로 복원됩니다.",
  },
  {
    q: "다른 학생이 PC를 사용 중이면 어떻게 하나요?",
    a: "대기열에 자동으로 등록됩니다. 이 화면을 열어두기만 하면 자리가 났을 때 알림이 표시됩니다.",
  },
  {
    q: "사양은 어떻게 정하면 되나요?",
    a: "슬라이더로 정하는 값은 “최소 사양”입니다. 그 이상을 만족하는 PC만 선택할 수 있도록 자동으로 걸러집니다.",
  },
  {
    q: "여러 PC 중 무엇을 골라야 하나요?",
    a: "각 PC 카드에 CPU·GPU·RAM·저장공간이 표시됩니다. 작업에 맞는 사양과 “사용 가능” 상태인 PC를 선택하세요.",
  },
];

/* ─────────────────────── 도움말 버튼 ─────────────────────── */

export function HelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="btn btn-ghost"
      style={{ padding: "7px 13px", fontSize: "13px" }}
      onClick={onClick}
      aria-label="사용 가이드 열기"
    >
      <span aria-hidden style={{ fontSize: "14px" }}>❓</span>
      도움말
    </button>
  );
}

/* ─────────────────────── 첫 방문 배너 ─────────────────────── */

export function GuideBanner({ onOpen }: { onOpen: () => void }) {
  // 서버/클라이언트 hydration 불일치를 막기 위해 항상 숨김으로 시작하고,
  // 마운트 후 localStorage 를 확인해 닫은 적이 없을 때만 표시한다.
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(GUIDE_DISMISS_KEY) !== "1") {
        setHidden(false);
      }
    } catch {
      setHidden(false);
    }
  }, []);

  if (hidden) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(GUIDE_DISMISS_KEY, "1");
    } catch {
      /* localStorage 사용 불가 시 무시 */
    }
    setHidden(true);
  }

  return (
    <div className="glass fade-in" style={banner}>
      <span style={{ fontSize: "20px", flexShrink: 0 }}>👋</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "2px" }}>
          PC 대여 포털 처음이신가요?
        </div>
        <div style={{ fontSize: "13px", color: "var(--text-dim)", lineHeight: 1.5 }}>
          사용 방법을 단계별로 알려드릴게요.
        </div>
      </div>
      <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
        <button
          className="btn btn-primary"
          style={{ padding: "8px 14px", fontSize: "13px" }}
          onClick={onOpen}
        >
          사용법 보기
        </button>
        <button
          className="btn btn-ghost"
          style={{ padding: "8px 12px", fontSize: "13px" }}
          onClick={dismiss}
          aria-label="배너 닫기"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────── 가이드 모달 ─────────────────────── */

export function GuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  if (!open) return null;

  return (
    <div style={overlay} onClick={onClose}>
      <div
        className="glass glass-strong fade-in"
        style={modalCard}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="사용 가이드"
      >
        {/* 헤더 */}
        <div style={modalHead}>
          <div>
            <h3 style={{ margin: 0, fontSize: "19px", fontWeight: 800 }}>사용 가이드</h3>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "var(--text-dim)" }}>
              GPU 데스크톱을 빌려 쓰는 방법을 안내합니다.
            </p>
          </div>
          <button
            className="btn btn-ghost"
            style={{ padding: "7px 12px", fontSize: "14px", flexShrink: 0 }}
            onClick={onClose}
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        {/* 단계 */}
        <section style={{ marginBottom: "26px" }}>
          <h4 style={sectionLabel}>이용 순서</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {STEPS.map((s, i) => (
              <div key={s.title} style={stepRow}>
                <div style={stepNum}>{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "3px" }}>
                    <span aria-hidden style={{ fontSize: "15px" }}>{s.icon}</span>
                    <span style={{ fontWeight: 700, fontSize: "14.5px" }}>{s.title}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: "13px", color: "var(--text-dim)", lineHeight: 1.55 }}>
                    {s.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 팁 */}
        <section style={{ marginBottom: "26px" }}>
          <h4 style={sectionLabel}>알아두면 좋아요</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {TIPS.map((t) => (
              <div key={t.text} style={tipRow}>
                <span aria-hidden style={{ fontSize: "15px", flexShrink: 0 }}>{t.icon}</span>
                <span style={{ fontSize: "13px", color: "var(--text-dim)", lineHeight: 1.55 }}>
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section>
          <h4 style={sectionLabel}>자주 묻는 질문</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {FAQS.map((f, i) => {
              const isOpen = openFaq === i;
              return (
                <div key={f.q} style={faqItem}>
                  <button
                    onClick={() => setOpenFaq(isOpen ? null : i)}
                    style={faqQuestion}
                    aria-expanded={isOpen}
                  >
                    <span style={{ fontSize: "13.5px", fontWeight: 600, textAlign: "left" }}>
                      {f.q}
                    </span>
                    <span
                      aria-hidden
                      style={{
                        flexShrink: 0,
                        transition: "transform 0.2s ease",
                        transform: isOpen ? "rotate(180deg)" : "none",
                        color: "var(--text-faint)",
                      }}
                    >
                      ⌄
                    </span>
                  </button>
                  {isOpen && (
                    <p style={faqAnswer} className="fade-in">
                      {f.a}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: "26px" }}
          onClick={onClose}
        >
          확인했어요
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────── 스타일 ─────────────────────── */

const banner: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "13px",
  padding: "14px 16px",
  background: "rgba(124,140,255,0.12)",
  borderColor: "rgba(124,140,255,0.35)",
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.65)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
  padding: "20px",
};

const modalCard: React.CSSProperties = {
  width: "100%",
  maxWidth: "520px",
  padding: "28px",
  maxHeight: "90vh",
  overflowY: "auto",
};

const modalHead: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
  marginBottom: "24px",
};

const sectionLabel: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: "13px",
  fontWeight: 700,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const stepRow: React.CSSProperties = {
  display: "flex",
  gap: "13px",
  padding: "14px",
  borderRadius: "14px",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid var(--glass-border)",
};

const stepNum: React.CSSProperties = {
  width: "26px",
  height: "26px",
  flexShrink: 0,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "13px",
  fontWeight: 800,
  color: "#fff",
  background: "linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%)",
  boxShadow: "0 4px 12px -4px var(--accent-glow)",
};

const tipRow: React.CSSProperties = {
  display: "flex",
  gap: "10px",
  alignItems: "flex-start",
  padding: "11px 13px",
  borderRadius: "12px",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid var(--glass-border)",
};

const faqItem: React.CSSProperties = {
  borderRadius: "12px",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid var(--glass-border)",
  overflow: "hidden",
};

const faqQuestion: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "13px 15px",
  background: "none",
  border: "none",
  color: "var(--text)",
  cursor: "pointer",
  font: "inherit",
};

const faqAnswer: React.CSSProperties = {
  margin: 0,
  padding: "0 15px 14px",
  fontSize: "13px",
  color: "var(--text-dim)",
  lineHeight: 1.6,
};
