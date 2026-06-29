"use client";

import { memo, useEffect, useState } from "react";
import s from "./atelier.module.css";
import { Overlay, Field, HelpTip } from "./ui";
import { nodeState, type NodeInfo } from "./useNodes";
import type { NewSessionForm } from "./useSession";

const WORK_TYPES: { key: string; label: string; sub: string }[] = [
  { key: "general", label: "일반 연산", sub: "코딩·자료 처리" },
  { key: "gpu", label: "GPU 학습", sub: "비전·딥러닝" },
  { key: "custom", label: "직접 지정", sub: "사양 개별 선택" },
];

const CPU_OPTS = [2, 4, 8, 16, 32];
const RAM_OPTS = [4, 8, 16, 32, 64];
const STORAGE_OPTS = [50, 100, 250, 500];

const ADMIN_EMAIL = "ts250024@ts.hs.kr";

// 1~28 + 특수값: -1 = 28+, 0 = 무한
const DURATION_DAYS: number[] = Array.from({ length: 28 }, (_, i) => i + 1);

export default function RequestSheet({
  nodes,
  isAdmin = false,
  onClose,
  onSubmit,
}: {
  nodes: NodeInfo[];
  isAdmin?: boolean;
  onClose: () => void;
  onSubmit: (form: NewSessionForm) => void;
}) {
  const [projectName, setProjectName] = useState("");
  const [workType, setWorkType] = useState("gpu");
  const [members, setMembers] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState("");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [cpu, setCpu] = useState(8);
  const [ram, setRam] = useState(16);
  const [storage, setStorage] = useState(100);
  const [duration, setDuration] = useState(7); // -1 = 28+, 0 = 무한
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedNodeId !== null) return;
    const selectable = nodes.filter((n) => nodeState(n) !== "active" && nodeState(n) !== "offline");
    if (selectable.length === 1) setSelectedNodeId(selectable[0].id);
  }, [nodes, selectedNodeId]);

  function addMember() {
    const email = memberInput.trim().toLowerCase();
    if (!email) return;
    if (!email.endsWith("@ts.hs.kr")) {
      setMemberError("@ts.hs.kr 이메일만 추가할 수 있습니다.");
      return;
    }
    if (members.includes(email)) {
      setMemberError("이미 추가된 팀원입니다.");
      return;
    }
    setMembers((m) => [...m, email]);
    setMemberInput("");
    setMemberError(null);
  }

  const meets = (node: NodeInfo) =>
    (node.cpu_cores == null || node.cpu_cores >= cpu) &&
    node.ram_gb >= ram &&
    node.storage_gb >= storage;

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const selectedOk = selectedNode ? meets(selectedNode) && nodeState(selectedNode) !== "active" && nodeState(selectedNode) !== "offline" : false;
  const isOverLimit = duration === -1;
  const canStart = !!projectName.trim() && !!selectedNodeId && selectedOk && !isOverLimit;
  const selectedNo = selectedNode ? nodes.findIndex((n) => n.id === selectedNode.id) + 1 : null;

  const durationLabel = duration === 0 ? "무한" : duration === -1 ? "28+" : `${duration}일`;

  function submit() {
    if (!canStart) return;
    onSubmit({
      project_name: projectName.trim(),
      team_members: members,
      cpu_cores: cpu,
      ram_gb: ram,
      storage_gb: storage,
      duration_days: duration,
      work_type: workType,
      node_id: selectedNodeId ?? undefined,
    });
  }

  return (
    <Overlay>
      <section className={s.requestSheet}>
        <header>
          <div>
            <span>작업 신청서</span>
            <h2>새 PC 배정</h2>
          </div>
          <button onClick={onClose}>닫기</button>
        </header>

        <div className={s.formGrid}>
          <div className={s.formMain}>
            <Field label="작업 이름">
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="예: 실시간 교통 객체 인식"
                autoFocus
              />
            </Field>

            <Field label="함께 사용할 학생">
              <div className={s.inlineInput}>
                <input
                  value={memberInput}
                  onChange={(e) => { setMemberInput(e.target.value); setMemberError(null); }}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addMember())}
                  placeholder="@ts.hs.kr 계정"
                />
                <button type="button" onClick={addMember}>추가</button>
              </div>
            </Field>
            {memberError && (
              <p style={{ color: "#963e4c", fontSize: "13px", margin: "-10px 0 12px" }}>{memberError}</p>
            )}
            {members.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", margin: "-6px 0 16px" }}>
                {members.map((m) => (
                  <span key={m} className={s.stateMark} style={{ cursor: "default" }}>
                    {m}
                    <button
                      type="button"
                      onClick={() => setMembers((x) => x.filter((y) => y !== m))}
                      style={{ border: 0, background: "none", cursor: "pointer", padding: "0 0 0 6px" }}
                    >✕</button>
                  </span>
                ))}
              </div>
            )}

            <fieldset>
              <legend>작업 성격</legend>
              <div className={s.workTypes}>
                {WORK_TYPES.map((t) => (
                  <label key={t.key}>
                    <input type="radio" name="type" checked={workType === t.key} onChange={() => setWorkType(t.key)} />
                    <span>{t.label}<small>{t.sub}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={s.specFields}>
              <Field label="CPU">
                <select value={cpu} onChange={(e) => setCpu(Number(e.target.value))}>
                  {CPU_OPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <small>코어 이상</small>
              </Field>
              <Field label="메모리">
                <select value={ram} onChange={(e) => setRam(Number(e.target.value))}>
                  {RAM_OPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <small>GB 이상</small>
              </Field>
              <Field label="저장 공간">
                <select value={storage} onChange={(e) => setStorage(Number(e.target.value))}>
                  {STORAGE_OPTS.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <small>GB</small>
              </Field>
            </div>

            <Field label="유지 기간">
              <DurationPicker value={duration} onChange={setDuration} isAdmin={isAdmin} />
            </Field>
          </div>

          <SelectMachine
            nodes={nodes}
            cpu={cpu}
            ram={ram}
            storage={storage}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
          />
        </div>

        <footer>
          <div>
            <span>선택</span>
            <strong>
              {selectedNo ? `${selectedNo}호기` : "장비 미선택"} · {workTypeLabel(workType)} · {durationLabel}
            </strong>
          </div>
          <button className={s.lineButton} onClick={onClose}>취소</button>
          <button className={s.solidButton} disabled={!canStart} onClick={submit}>배정 요청</button>
        </footer>
      </section>
    </Overlay>
  );
}

export function DurationPicker({
  value,
  onChange,
  isAdmin = false,
}: {
  value: number;
  onChange: (v: number) => void;
  isAdmin?: boolean;
}) {
  return (
    <>
      <div className={s.durationGrid}>
        {DURATION_DAYS.map((d) => (
          <button
            key={d}
            type="button"
            className={s.durationBtn}
            data-on={value === d}
            onClick={() => onChange(d)}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          className={s.durationBtn}
          data-on={value === -1}
          data-special="true"
          onClick={() => onChange(-1)}
        >
          28+
        </button>
        {isAdmin && (
          <button
            type="button"
            className={s.durationBtn}
            data-on={value === 0}
            data-infinite="true"
            onClick={() => onChange(0)}
          >
            ∞ 무한
          </button>
        )}
      </div>
      {value === -1 && (
        <p className={s.durationOverNotice}>
          28일 초과 이용은 관리자 승인이 필요합니다.
          관리자({ADMIN_EMAIL})에게 직접 문의해 주세요.
        </p>
      )}
      {value === 0 && isAdmin && (
        <p className={s.durationAdminNotice}>
          무한 기간: 999일로 설정됩니다. (관리자 전용)
        </p>
      )}
    </>
  );
}

function workTypeLabel(key: string) {
  return WORK_TYPES.find((t) => t.key === key)?.label ?? "일반";
}

const SelectMachine = memo(function SelectMachine({
  nodes, cpu, ram, storage, selectedNodeId, onSelect,
}: {
  nodes: NodeInfo[];
  cpu: number;
  ram: number;
  storage: number;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}) {
  const meets = (node: NodeInfo) =>
    (node.cpu_cores == null || node.cpu_cores >= cpu) &&
    node.ram_gb >= ram &&
    node.storage_gb >= storage;

  return (
    <aside className={s.selectMachine}>
      <div className={s.titleLine}>
        <h3>장비 선택</h3>
        <HelpTip text="요청 사양을 만족하는 장비만 선택할 수 있습니다." />
      </div>
      {nodes.length === 0 && <p>연결된 PC가 없습니다.</p>}
      {nodes.map((node, index) => {
        const st = nodeState(node);
        const ok = meets(node) && st !== "active" && st !== "offline";
        const sc = node.session_count ?? 0;
        const cpuPct = node.load?.cpu_pct ?? null;
        const userLabel =
          st === "offline" ? "오프라인" :
          st === "active" ? "2명 사용 중 (만석)" :
          sc === 1 ? "1명 사용 중" : "비어 있음";
        const stateLabel =
          st === "offline" ? "오프라인" :
          st === "active" ? "사용 중 (2/2)" :
          meets(node) ? "선택 가능" : "사양 부족";
        return (
          <button
            key={node.id}
            disabled={!ok}
            data-on={selectedNodeId === node.id}
            onClick={() => ok && onSelect(node.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{node.name || node.id}</strong>
              <small>
                {node.gpu}<br />
                {node.ram_gb}GB · {node.storage_gb}GB
              </small>
              {cpuPct !== null && <NodeLoadBar pct={cpuPct} label={userLabel} />}
              {cpuPct === null && sc > 0 && (
                <small style={{ color: "var(--c-text-2, #888)", fontSize: "11px" }}>{userLabel}</small>
              )}
            </div>
            <em>{stateLabel}</em>
          </button>
        );
      })}
    </aside>
  );
});

function NodeLoadBar({ pct, label }: { pct: number; label: string }) {
  const color = pct >= 80 ? "#c0392b" : pct >= 50 ? "#e67e22" : "#27ae60";
  return (
    <div style={{ marginTop: "4px" }}>
      <div style={{ height: "3px", borderRadius: "2px", background: "rgba(0,0,0,0.08)", overflow: "hidden", width: "100%" }}>
        <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, transition: "width 0.4s" }} />
      </div>
      <span style={{ fontSize: "11px", color: "var(--c-text-2, #888)" }}>CPU {Math.round(pct)}% · {label}</span>
    </div>
  );
}
