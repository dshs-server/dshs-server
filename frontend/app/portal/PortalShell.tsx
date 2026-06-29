"use client";

import { useEffect, useState } from "react";
import s from "./atelier.module.css";
import { useSession } from "./useSession";
import { useNodes, type NodeInfo } from "./useNodes";
import WorkPage from "./pages/WorkPage";
import SavedPage from "./pages/SavedPage";
import HistoryPage from "./pages/HistoryPage";
import GuidePage from "./pages/GuidePage";
import AdminArea from "./admin/AdminArea";
import RequestSheet from "./RequestSheet";

export type Page = "work" | "saved" | "history" | "guide" | "admin";

const NAV: { key: Page; no: string; label: string }[] = [
  { key: "work", no: "01", label: "내 작업" },
  { key: "saved", no: "02", label: "보관함" },
  { key: "history", no: "03", label: "사용 기록" },
  { key: "guide", no: "04", label: "이용 안내" },
];

function todayLabel() {
  try {
    return new Date().toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    });
  } catch {
    return "";
  }
}

export default function PortalShell({ initialPage = "work" }: { initialPage?: Page }) {
  const ctrl = useSession();
  const { nodes } = useNodes();
  const [page, setPage] = useState<Page>(initialPage);
  const [date, setDate] = useState("");

  useEffect(() => {
    setDate(todayLabel());
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    if (view && ["work", "saved", "history", "guide", "admin"].includes(view)) {
      setPage(view as Page);
    } else if (params.get("view") === "admin-session") {
      setPage("admin");
    }
  }, []);

  const isAdmin = !!ctrl.me?.isAdmin;
  const onlineCount = nodes.filter((n) => nodeOnline(n)).length;

  const headerTitle =
    page === "admin" ? "관리" : NAV.find((n) => n.key === page)?.label ?? "내 작업";

  return (
    <div className={s.root} data-variant="ivory">
      <div className={s.field} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <div className={s.shell}>
        <aside className={s.side}>
          <button className={s.wordmark} onClick={() => setPage("work")}>
            <span>DSHS</span>
            <strong>GPU 전산실</strong>
          </button>

          <nav>
            {NAV.map((item) => (
              <button
                key={item.key}
                data-on={page === item.key}
                onClick={() => setPage(item.key)}
              >
                <span>{item.no}</span>
                {item.label}
              </button>
            ))}
          </nav>

          {isAdmin && (
            <button
              className={s.adminEntry}
              data-on={page === "admin"}
              onClick={() => setPage("admin")}
            >
              <span>05</span>관리
            </button>
          )}

          <div className={s.sideFoot}>
            <span>
              <i /> 운영 중
            </span>
            <strong>
              {onlineCount} / {nodes.length || "—"}
            </strong>
            <small>온라인 장비</small>
          </div>
        </aside>

        <section className={s.stage}>
          <header className={s.header}>
            <div>
              <strong>{headerTitle}</strong>
              <span>{date}</span>
            </div>
            <div className={s.account}>
              <span>{ctrl.me?.email ?? "—"}</span>
              <button onClick={ctrl.handleLogout}>로그아웃</button>
            </div>
          </header>

          <main className={s.main}>
            {page === "work" && <WorkPage ctrl={ctrl} nodes={nodes} onNavigate={setPage} />}
            {page === "saved" && <SavedPage ctrl={ctrl} onNavigate={setPage} />}
            {page === "history" && <HistoryPage />}
            {page === "guide" && <GuidePage />}
            {page === "admin" && isAdmin && <AdminArea />}
          </main>
        </section>
      </div>

      {ctrl.showNewSessionModal && (
        <RequestSheet
          nodes={nodes}
          onClose={() => {
            ctrl.setShowNewSessionModal(false);
            ctrl.setReplaceSessionId(null);
          }}
          onSubmit={(form) =>
            ctrl.handleStartNew(form, ctrl.replaceSessionId || undefined)
          }
        />
      )}
    </div>
  );
}

function nodeOnline(n: NodeInfo): boolean {
  // available 또는 세션이 도는 노드 = 온라인. offline 표식만 제외.
  return n.session_state !== undefined ? true : n.available !== false;
}
