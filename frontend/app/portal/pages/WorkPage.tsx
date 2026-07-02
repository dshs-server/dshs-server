"use client";

import { useState, useEffect } from "react";
import s from "../atelier.module.css";
import { HelpTip, PowerIcon, ConfirmSheet, formatRemaining } from "../ui";
import { nodeState, isOffline, type NodeInfo } from "../useNodes";
import type { SessionController, Status, SessionStats } from "../useSession";
import type { Page } from "../PortalShell";
import { UploadButton } from "@/components/upload";

type WorkMark = "ready" | "idle" | "starting" | "queued" | "error" | "migrating";

const markFor: Record<Status, WorkMark> = {
  checking: "starting",
  idle: "idle",
  starting: "starting",
  ready: "ready",
  busy: "error",
  queued: "queued",
  error: "error",
  migrating: "migrating",
};

const markLabel: Record<WorkMark, string> = {
  ready: "사용 중",
  idle: "배정 가능",
  starting: "준비 중",
  queued: "대기 중",
  error: "연결 오류",
  migrating: "이전 중",
};


export default function WorkPage({
  ctrl,
  nodes,
  onModalChange,
}: {
  ctrl: SessionController;
  nodes: NodeInfo[];
  onNavigate: (p: Page) => void;
  onModalChange?: (open: boolean) => void;
}) {
  const { status } = ctrl;
  const [confirmTerminate, setConfirmTerminate] = useState(false);

  const openConfirm = () => { setConfirmTerminate(true); onModalChange?.(true); };
  const closeConfirm = () => { setConfirmTerminate(false); onModalChange?.(false); };
  const [date, setDate] = useState("");

  useEffect(() => {
    try {
      setDate(new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }));
    } catch {}
  }, []);

  const openNew = () => {
    ctrl.setReplaceSessionId(null);
    ctrl.setShowNewSessionModal(true);
  };

  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>내 작업</h1>
          <HelpTip text="배정된 PC와 보관 중인 환경을 확인합니다." />
        </div>
        {date && <span className={s.pageTitleDate}>{date}</span>}
      </div>

      <div className={s.workLayout}>
        <section className={s.assignment}>
          <div className={s.assignmentHead}>
            <span>현재 배정</span>
            <span className={s.stateMark} data-state={markFor[status]}>
              <i />
              {markLabel[markFor[status]]}
            </span>
          </div>

          {status === "ready" && (
            <ReadyAssignment ctrl={ctrl} nodes={nodes} onTerminate={openConfirm} />
          )}
          {status === "idle" && <IdleAssignment nodes={nodes} onRequest={openNew} />}
          {(status === "starting" || status === "checking") && (
            <StartingAssignment nodeName={ctrl.activeMeta.node_name} />
          )}
          {status === "queued" && <QueuedAssignment ctrl={ctrl} />}
          {status === "busy" && <BusyAssignment ctrl={ctrl} />}
          {status === "migrating" && <MigratingAssignment message={ctrl.migratingMsg} />}
          {status === "error" && <ErrorAssignment ctrl={ctrl} />}
        </section>

        <MachineLedger nodes={nodes} />
      </div>

      {confirmTerminate && (
        <ConfirmSheet
          title="작업 종료"
          message="세션을 종료하시겠습니까? 현재 환경은 보관함에 저장되어 나중에 이어서 사용할 수 있습니다."
          confirmLabel="종료"
          onConfirm={() => {
            closeConfirm();
            ctrl.handleTerminate(false);
          }}
          onCancel={closeConfirm}
        />
      )}
    </div>
  );
}

function ReadyAssignment({
  ctrl,
  nodes,
  onTerminate,
}: {
  ctrl: SessionController;
  nodes: NodeInfo[];
  onTerminate: () => void;
}) {
  const { activeMeta, remaining, expiresAt, stats, url, terminalUrl, extendBlocked } = ctrl;
  const timeLevel =
    remaining == null ? "normal" : remaining <= 300 ? "critical" : remaining <= 1800 ? "warning" : "normal";
  const idx = nodes.findIndex((n) => n.id === activeMeta.node_id);
  const nodeNo = idx >= 0 ? String(idx + 1).padStart(2, "0") : "PC";
  const expiryStr = expiresAt
    ? new Date(expiresAt * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " 종료"
    : "";

  const canExtend = remaining != null && remaining <= 2 * 86400 && !extendBlocked;
  const showExtendRow = (remaining != null && remaining <= 2 * 86400) || extendBlocked;

  return (
    <div className={s.readyAssignment}>
      <div className={s.projectLine}>
        <div>
          <small>작업 이름</small>
          <h2>{activeMeta.project_name || "작업 환경"}</h2>
        </div>
        <div className={s.timeReadout} data-level={timeLevel}>
          <small>남은 시간</small>
          <strong>{remaining != null ? formatRemaining(remaining) : "—"}</strong>
          <p>{expiryStr}</p>
        </div>
      </div>

      <div className={s.machineIdentity}>
        <span>{nodeNo}</span>
        <div>
          <small>배정 장비</small>
          <strong>
            {activeMeta.node_name || "—"}
            {activeMeta.node_gpu ? ` / ${activeMeta.node_gpu}` : ""}
          </strong>
        </div>
        <p>{activeMeta.node_ip || ""}</p>
      </div>

      <div className={s.numbers}>
        <Metric label="CPU" stat={stats?.cpu_pct} unit="%" cool="blue" note={stats?.top_process || undefined} />
        <Metric label="GPU" stat={stats?.gpu_pct} unit="%" cool="green" />
        <Metric
          label="메모리"
          stat={stats?.ram_pct}
          unit="%"
          cool="green"
          note={stats?.ram_used && stats?.ram_total ? `${stats.ram_used} / ${stats.ram_total}` : undefined}
        />
        <Metric
          label="저장 공간"
          stat={stats?.storage_pct}
          unit="%"
          cool="blue"
          note={
            stats?.storage_total_gb != null
              ? `${stats?.storage_used_gb ?? 0}G / ${stats.storage_total_gb}G`
              : undefined
          }
        />
      </div>

      <div className={s.actionLine}>
        <a
          className={s.solidButton}
          href={url || "#"}
          target="_blank"
          rel="noopener noreferrer"
        >
          데스크톱 열기 <span>↗</span>
        </a>
        {terminalUrl && (
          <a
            className={s.lineButton}
            href={terminalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            터미널 <span>↗</span>
          </a>
        )}
        <span />
        <button className={s.powerButton} aria-label="작업 종료" title="작업 종료" onClick={onTerminate}>
          <PowerIcon />
        </button>
      </div>

      <div className={s.keyboardHint} role="note" aria-label="한영 전환 안내">
        <span>한/영 전환</span>
        <strong>
          <kbd>Shift</kbd>
          <i>+</i>
          <kbd>Space</kbd>
        </strong>
        <small>데스크톱 화면을 먼저 클릭하세요</small>
      </div>

      {showExtendRow && !extendBlocked && (
        <div className={s.extendRow}>
          <span>세션 종료 2일 이내 · 3일 연장 가능</span>
          <button className={s.lineButton} onClick={ctrl.handleExtend} disabled={!canExtend}>
            + 3일 연장
          </button>
        </div>
      )}

      {extendBlocked && (
        <div className={s.extendBanner}>
          <span>이 세션은 총 이용 기간 40일을 초과해 연장이 제한됩니다.</span>
          <a href={`mailto:ts250024@ts.hs.kr?subject=[PC대여] 세션 연장 허가 요청`} className={s.lineButton}>
            관리자에게 연락하기
          </a>
        </div>
      )}

      <div className={s.uploadRow}>
        <UploadButton />
      </div>
    </div>
  );
}

function Metric({
  label,
  stat,
  unit,
  note,
  cool,
}: {
  label: string;
  stat?: number;
  unit: string;
  note?: string;
  cool: "blue" | "green";
}) {
  const percent = stat ?? 0;
  const level =
    stat == null
      ? cool
      : percent >= 90
      ? "critical"
      : percent >= 80
      ? "hot"
      : percent >= 65
      ? "warm"
      : cool;
  return (
    <div className={s.metric} data-level={level}>
      <span>{label}</span>
      <strong>
        {stat != null ? Math.round(percent) : "—"}
        <small>{unit}</small>
      </strong>
      <p>{note || " "}</p>
    </div>
  );
}

function IdleAssignment({ nodes, onRequest }: { nodes: NodeInfo[]; onRequest: () => void }) {
  const free = nodes.filter((n) => { const st = nodeState(n); return st === "available" || st === "partial"; }).length;
  return (
    <div className={s.plainState}>
      <span className={s.stateCode}>00</span>
      <div>
        <h2>배정된 PC가 없습니다.</h2>
        <p>현재 {free}대를 바로 사용할 수 있습니다.</p>
      </div>
      <button className={s.solidButton} onClick={onRequest}>
        작업 신청
      </button>
    </div>
  );
}

function StartingAssignment({ nodeName }: { nodeName?: string }) {
  return (
    <div className={s.prepState}>
      <span className={s.stateCode}>01</span>
      <div>
        <h2>{nodeName ? `${nodeName}를 준비하고 있습니다.` : "PC를 준비하고 있습니다."}</h2>
        <p>저장 공간을 연결한 뒤 원격 데스크톱을 시작합니다.</p>
        <ol>
          <li data-done="true">
            장비 배정 <span>완료</span>
          </li>
          <li data-now="true">
            작업 환경 시작 <span>진행 중</span>
          </li>
          <li>
            원격 접속 확인 <span>대기</span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function MigratingAssignment({ message }: { message?: string | null }) {
  return (
    <div className={s.prepState}>
      <span className={s.stateCode}>02</span>
      <div>
        <h2>다른 PC로 환경을 이전하고 있습니다.</h2>
        <p>{message || "저장된 환경을 전송하고 있습니다. 수 분이 소요될 수 있습니다."}</p>
        <ol>
          <li data-done="true">
            PC 선택 <span>완료</span>
          </li>
          <li data-now="true">
            환경 이미지 전송 <span>진행 중</span>
          </li>
          <li>
            새 PC에서 시작 <span>대기</span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function QueuedAssignment({ ctrl }: { ctrl: SessionController }) {
  return (
    <div className={s.queueState}>
      <div>
        <span>대기 순번</span>
        <strong>{ctrl.queuePos ?? "—"}</strong>
      </div>
      <section>
        <h2>현재 사용 가능한 장비가 없습니다.</h2>
        <p>순번은 페이지를 닫아도 유지됩니다. 자리가 나면 자동으로 배정됩니다.</p>
        <dl>
          <div>
            <dt>사용 중</dt>
            <dd>{ctrl.owner || "다른 학생"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function BusyAssignment({ ctrl }: { ctrl: SessionController }) {
  return (
    <div className={s.plainState} data-error="true">
      <span className={s.stateCode}>!</span>
      <div>
        <h2>다른 학생이 사용 중입니다.</h2>
        <p>
          현재 {ctrl.owner || "다른 학생"} 님이 사용하고 있습니다. 잠시 후 다시 확인해 주세요.
        </p>
      </div>
      <button className={s.solidButton} onClick={ctrl.handleCheckAvailability}>
        다시 확인
      </button>
    </div>
  );
}

function ErrorAssignment({ ctrl }: { ctrl: SessionController }) {
  return (
    <div className={s.plainState} data-error="true">
      <span className={s.stateCode}>!</span>
      <div>
        <h2>세션을 시작하지 못했습니다.</h2>
        <p>작업 파일은 안전합니다. 잠시 후 다시 시도하거나 학교망/VPN 상태를 확인하세요.</p>
        {ctrl.errorMsg && <code>{ctrl.errorMsg}</code>}
      </div>
      <button className={s.solidButton} onClick={() => ctrl.setStatus("idle")}>
        다시 시도
      </button>
    </div>
  );
}

function MachineLedger({ nodes }: { nodes: NodeInfo[] }) {
  const free = nodes.filter((n) => { const st = nodeState(n); return st === "available" || st === "partial"; }).length;
  const stateLabel = (st: "available" | "partial" | "suspended" | "active" | "offline") => {
    if (st === "active") return "사용 중";
    if (st === "offline") return "오프라인";
    return "가능";
  };
  const stateAttr = (st: "available" | "partial" | "suspended" | "active" | "offline") => {
    if (st === "active") return "busy";
    if (st === "offline") return "offline";
    return "available";
  };

  const total = nodes.filter((n) => !isOffline(n)).length;

  return (
    <aside className={s.machineLedger}>
      <div className={s.machineLedgerHead}>
        <h2>PC 배정 현황</h2>
        <span>
          {free} / {total} 사용 가능
        </span>
      </div>
      <div>
        {nodes.map((node, index) => {
          const st = nodeState(node);
          return (
            <article key={node.id} data-state={stateAttr(st)}>
              <span className={s.nodeNo}>{index + 1}</span>
              <div>
                <strong>{node.name || node.id}</strong>
                <small>{node.gpu}</small>
              </div>
              <em>{stateLabel(st)}</em>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

function relDays(deleteAfter?: number): string {
  if (!deleteAfter) return "—";
  const days = Math.ceil((deleteAfter - Date.now() / 1000) / 86400);
  if (days <= 0) return "곧 삭제";
  return `${days}일 후`;
}

export type { SessionStats };
