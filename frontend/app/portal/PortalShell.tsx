"use client";

import { useEffect, useState } from "react";
import s from "./atelier.module.css";
import { useSession } from "./useSession";
import { useNodes, isOffline } from "./useNodes";
import WorkPage from "./pages/WorkPage";
import SavedPage from "./pages/SavedPage";
import HistoryPage from "./pages/HistoryPage";
import GuidePage from "./pages/GuidePage";
import AdminArea from "./admin/AdminArea";
import RequestSheet from "./RequestSheet";
import { ConfirmSheet } from "./ui";

export type Page = "work" | "saved" | "history" | "guide" | "admin";

const NAV: { key: Page; no: string; label: string }[] = [
  { key: "work", no: "01", label: "내 작업" },
  { key: "saved", no: "02", label: "보관함" },
  { key: "history", no: "03", label: "사용 기록" },
  { key: "guide", no: "04", label: "이용 안내" },
];


export default function PortalShell({ initialPage = "work" }: { initialPage?: Page }) {
  const ctrl = useSession();
  const { nodes } = useNodes();
  const [page, setPage] = useState<Page>(initialPage);
  const [navWarn, setNavWarn] = useState(false);

  const onLogout = () => {
    if (ctrl.status === "starting") setNavWarn(true);
    else ctrl.handleLogout();
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    if (view && ["work", "saved", "history", "guide", "admin"].includes(view)) {
      setPage(view as Page);
    } else if (params.get("view") === "admin-session") {
      setPage("admin");
    }
  }, []);

  const isAdmin = !!ctrl.me?.isAdmin;
  const onlineCount = nodes.filter((n) => !isOffline(n)).length;
  const nonOfflineCount = nodes.filter((n) => !isOffline(n)).length;

  return (
    <div className={s.root} data-variant="ivory" data-modal={ctrl.showNewSessionModal || undefined}>
      <div className={s.field} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <div className={s.shell}>
        <aside className={s.side}>
          <button className={s.wordmark} onClick={() => setPage("work")}>
            <span>DSHS</span>
            <strong>전산실</strong>
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
            <div className={s.sideAccount}>
              <span title={ctrl.me?.email ?? undefined}>{ctrl.me?.email ?? "—"}</span>
              <button className={s.logoutBtn} onClick={onLogout}>로그아웃</button>
            </div>
            <span>
              <i /> 운영 중
            </span>
            <strong>
              {onlineCount} / {nonOfflineCount || "—"}
            </strong>
            <small>온라인 장비</small>
          </div>
        </aside>

        <section className={s.stage}>
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
          isAdmin={isAdmin}
          onClose={() => {
            ctrl.setShowNewSessionModal(false);
            ctrl.setReplaceSessionId(null);
          }}
          onSubmit={(form) =>
            ctrl.handleStartNew(form, ctrl.replaceSessionId || undefined)
          }
        />
      )}

      {navWarn && (
        <ConfirmSheet
          title="세션 준비 중"
          message="데스크톱이 아직 준비 중입니다. 지금 나가면 준비가 중단될 수 있습니다. 그래도 로그아웃할까요?"
          confirmLabel="로그아웃"
          danger
          onConfirm={() => {
            setNavWarn(false);
            ctrl.handleLogout();
          }}
          onCancel={() => setNavWarn(false)}
        />
      )}
    </div>
  );
}

