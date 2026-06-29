"use client";

import { useEffect, useState, type ReactNode } from "react";
import { activity, machines, savedSessions, users } from "../fixtures";
import s from "./ledger.module.css";

type Page = "work" | "saved" | "history" | "guide" | "admin";
type WorkState = "ready" | "idle" | "starting" | "queued" | "error";
type AdminPage = "status" | "pc" | "session" | "people" | "notice" | "clean";
type ThemeVariant = "blue" | "white-glass" | "ivory";

const workStateLabel: Record<WorkState, string> = {
  ready: "사용 중",
  idle: "배정 가능",
  starting: "준비 중",
  queued: "대기 중",
  error: "연결 오류",
};

const themeMeta: Record<ThemeVariant, { no: string; name: string; nextHref: string; nextLabel: string }> = {
  blue: { no: "시안 02", name: "작업 원장", nextHref: "/design-lab/white-glass", nextLabel: "시안 03 보기" },
  "white-glass": { no: "시안 03", name: "White Liquid", nextHref: "/design-lab/ivory", nextLabel: "시안 04 보기" },
  ivory: { no: "시안 04", name: "White Atelier", nextHref: "/design-lab/ledger", nextLabel: "시안 02 보기" },
};

export default function LedgerPrototype({ variant = "blue" }: { variant?: ThemeVariant }) {
  const [page, setPage] = useState<Page>("work");
  const [workState, setWorkState] = useState<WorkState>("ready");
  const [requestOpen, setRequestOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [labControlsOpen, setLabControlsOpen] = useState(false);
  const [lowTime, setLowTime] = useState(false);
  const [highLoad, setHighLoad] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view") as Page | "admin-session" | null;
    const scenario = params.get("scenario");
    if (scenario === "critical") { setLowTime(true); setHighLoad(true); }
    else if (scenario === "low-time") setLowTime(true);
    else if (scenario === "high-load") setHighLoad(true);
    if (requested === "admin-session") { setPage("admin"); return; }
    if (requested && ["work", "saved", "history", "guide", "admin"].includes(requested)) setPage(requested);
  }, []);

  function flash(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2200);
  }

  const nav: { key: Page; no: string; label: string }[] = [
    { key: "work", no: "01", label: "내 작업" },
    { key: "saved", no: "02", label: "보관함" },
    { key: "history", no: "03", label: "사용 기록" },
    { key: "guide", no: "04", label: "이용 안내" },
  ];

  const theme = themeMeta[variant];

  return (
    <div className={s.root} data-variant={variant}>
      <div className={s.field} aria-hidden="true"><i /><i /><i /></div>

      <div className={s.testDock} data-open={labControlsOpen}>
        <button className={s.labToggle} onClick={() => setLabControlsOpen((open) => !open)}>
          {labControlsOpen ? "미리보기 닫기" : "상태 미리보기"}
        </button>
        {labControlsOpen && (
          <div className={s.testBar}>
            <span><b>{theme.no}</b> {theme.name}</span>
            <a href={theme.nextHref}>{theme.nextLabel}</a>
            <div className={s.testStateButtons}>
              {(Object.keys(workStateLabel) as WorkState[]).map((key) => (
                <button key={key} data-on={workState === key} onClick={() => { setPage("work"); setWorkState(key); }}>
                  {workStateLabel[key]}
                </button>
              ))}
            </div>
            <div className={s.testScenarioButtons}>
              <button data-on={lowTime} onClick={() => { setLowTime((value) => !value); setPage("work"); setWorkState("ready"); }}>시간 부족</button>
              <button data-on={highLoad} onClick={() => { setHighLoad((value) => !value); setPage("work"); setWorkState("ready"); }}>고부하</button>
            </div>
          </div>
        )}
      </div>

      <div className={s.shell}>
        <aside className={s.side}>
          <button className={s.wordmark} onClick={() => setPage("work")}>
            <span>DSHS</span>
            <strong>GPU 전산실</strong>
          </button>

          <nav>
            {nav.map((item) => (
              <button key={item.key} data-on={page === item.key} onClick={() => setPage(item.key)}>
                <span>{item.no}</span>{item.label}
              </button>
            ))}
          </nav>

          <button className={s.adminEntry} data-on={page === "admin"} onClick={() => setPage("admin")}>
            <span>05</span>관리
          </button>

          <div className={s.sideFoot}>
            <span><i /> 운영 중</span>
            <strong>4 / 5</strong>
            <small>온라인 장비</small>
          </div>
        </aside>

        <section className={s.stage}>
          <header className={s.header}>
            <div><strong>{page === "admin" ? "관리" : nav.find((item) => item.key === page)?.label}</strong><span>2026. 06. 29. 월요일</span></div>
            <div className={s.account}><span>ts250015@ts.hs.kr</span><button>계정</button></div>
          </header>

          <main className={s.main}>
            {page === "work" && (
              <WorkPage state={workState} lowTime={lowTime} highLoad={highLoad} onRequest={() => setRequestOpen(true)} onUpload={() => setUploadOpen(true)} onState={setWorkState} />
            )}
            {page === "saved" && <SavedPage onResume={() => { setPage("work"); setWorkState("starting"); flash("보관된 환경을 다시 준비합니다."); }} />}
            {page === "history" && <HistoryPage />}
            {page === "guide" && <GuidePage />}
            {page === "admin" && <AdminArea flash={flash} />}
          </main>
        </section>
      </div>

      {requestOpen && <RequestSheet onClose={() => setRequestOpen(false)} onSubmit={() => { setRequestOpen(false); setWorkState("starting"); flash("1호기 배정을 요청했습니다."); }} />}
      {uploadOpen && <UploadSheet onClose={() => setUploadOpen(false)} onSubmit={() => { setUploadOpen(false); flash("파일 전송 대기열에 추가했습니다."); }} />}
      {message && <div className={s.message}>{message}</div>}
    </div>
  );
}

function WorkPage({ state, lowTime, highLoad, onRequest, onUpload, onState }: { state: WorkState; lowTime: boolean; highLoad: boolean; onRequest: () => void; onUpload: () => void; onState: (state: WorkState) => void }) {
  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}><h1>내 작업</h1><HelpTip text="배정된 PC와 보관 중인 환경을 확인합니다." /></div>
        <button className={s.solidButton} onClick={onRequest}>새 작업 신청</button>
      </div>

      <div className={s.workLayout}>
        <section className={s.assignment}>
          <div className={s.assignmentHead}><span>현재 배정</span><StateMark state={state} /></div>
          {state === "ready" && <ReadyAssignment lowTime={lowTime} highLoad={highLoad} onUpload={onUpload} />}
          {state === "idle" && <IdleAssignment onRequest={onRequest} />}
          {state === "starting" && <StartingAssignment onDone={() => onState("ready")} />}
          {state === "queued" && <QueuedAssignment />}
          {state === "error" && <ErrorAssignment />}
        </section>
        <MachineLedger onRequest={onRequest} />
      </div>

      <section className={s.recentBlock}>
        <div className={s.blockHeading}><h2>보관 중인 작업</h2><button>보관함 전체 보기</button></div>
        <div className={s.ledgerTable}>
          <div className={s.ledgerHead}><span>작업명</span><span>마지막 장비</span><span>사용량</span><span>삭제 예정</span><span /></div>
          {savedSessions.map((item) => (
            <div className={s.ledgerRow} key={item.id}>
              <span><strong>{item.name}</strong><small>{item.savedAt}</small></span>
              <span>{item.machine}</span><span>{item.size}</span><span>{item.deleteIn}</span>
              <button onClick={() => onState("starting")}>이어하기</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StateMark({ state }: { state: WorkState }) {
  return <span className={s.stateMark} data-state={state}><i />{workStateLabel[state]}</span>;
}

function ReadyAssignment({ lowTime, highLoad, onUpload }: { lowTime: boolean; highLoad: boolean; onUpload: () => void }) {
  const remainingSeconds = lowTime ? 282 : 24138;
  const timeLevel = remainingSeconds <= 300 ? "critical" : remainingSeconds <= 1800 ? "warning" : "normal";
  return (
    <div className={s.readyAssignment}>
      <div className={s.projectLine}>
        <div><small>작업 이름</small><h2>실시간 교통 객체 인식</h2></div>
        <div className={s.timeReadout} data-level={timeLevel}><small>남은 시간</small><strong>{lowTime ? "00:04:42" : "06:42:18"}</strong><p>{lowTime ? "곧 자동 종료" : "오늘 21:20 종료"}</p></div>
      </div>
      <div className={s.machineIdentity}><span>01</span><div><small>배정 장비</small><strong>1호기 / RTX 4090 24GB</strong></div><p>10.72.117.23</p></div>
      <div className={s.numbers}>
        <Metric label="CPU" value={highLoad ? "94" : "38"} unit="%" note={highLoad ? "30 / 32 core" : "12 / 32 core"} percent={highLoad ? 94 : 38} cool="blue" />
        <Metric label="GPU" value={highLoad ? "98" : "72"} unit="%" note={highLoad ? "23.5 / 24GB" : "17.4 / 24GB"} percent={highLoad ? 98 : 72} cool="green" />
        <Metric label="메모리" value={highLoad ? "89" : "41"} unit="%" note={highLoad ? "57.0 / 64GB" : "26.2 / 64GB"} percent={highLoad ? 89 : 41} cool="green" />
        <Metric label="저장 공간" value={highLoad ? "92" : "18"} unit="%" note={highLoad ? "144GB 남음" : "1.47TB 남음"} percent={highLoad ? 92 : 18} cool="blue" />
      </div>
      <div className={s.actionLine}>
        <button className={s.solidButton}>데스크톱 열기 <span>↗</span></button>
        <button className={s.lineButton} onClick={onUpload}>파일 보내기</button>
        <button className={s.powerButton} aria-label="작업 종료" title="작업 종료"><PowerIcon /></button>
      </div>
    </div>
  );
}

function Metric({ label, value, unit, note, percent, cool }: { label: string; value: string; unit: string; note: string; percent: number; cool: "blue" | "green" }) {
  const level = percent >= 90 ? "critical" : percent >= 80 ? "hot" : percent >= 65 ? "warm" : cool;
  return <div className={s.metric} data-level={level}><span>{label}</span><strong>{value}<small>{unit}</small></strong><p>{note}</p></div>;
}

function IdleAssignment({ onRequest }: { onRequest: () => void }) {
  return <div className={s.plainState}><span className={s.stateCode}>00</span><div><h2>배정된 PC가 없습니다.</h2><p>현재 2대를 바로 사용할 수 있습니다.</p></div><button className={s.solidButton} onClick={onRequest}>작업 신청</button></div>;
}

function StartingAssignment({ onDone }: { onDone: () => void }) {
  return <div className={s.prepState}><span className={s.stateCode}>01</span><div><h2>1호기를 준비하고 있습니다.</h2><p>저장 공간을 연결한 뒤 원격 데스크톱을 시작합니다.</p><ol><li data-done="true">장비 배정 <span>완료</span></li><li data-now="true">작업 환경 시작 <span>진행 중</span></li><li>원격 접속 확인 <span>대기</span></li></ol><button className={s.quietButton} onClick={onDone}>완료 화면 보기</button></div></div>;
}

function QueuedAssignment() {
  return <div className={s.queueState}><div><span>대기 순번</span><strong>2</strong></div><section><h2>현재 사용 가능한 장비가 없습니다.</h2><p>순번은 페이지를 닫아도 유지됩니다. 예상 배정 시각은 14:50입니다.</p><dl><div><dt>요청 사양</dt><dd>RTX 3090 이상 · 메모리 16GB</dd></div><div><dt>등록 시각</dt><dd>14:21</dd></div></dl><button className={s.quietButton}>대기 취소</button></section></div>;
}

function ErrorAssignment() {
  return <div className={s.plainState} data-error="true"><span className={s.stateCode}>!</span><div><h2>1호기 연결이 끊겼습니다.</h2><p>작업 파일은 저장되어 있습니다. 학교망 또는 VPN 상태를 확인하세요.</p><code>NODE_TUNNEL_TIMEOUT / LAB-01</code></div><button className={s.solidButton}>다시 연결</button></div>;
}

function MachineLedger({ onRequest }: { onRequest: () => void }) {
  return (
    <aside className={s.machineLedger}>
      <div className={s.machineLedgerHead}><h2>PC 배정 현황</h2><span>2 / 5 사용 가능</span></div>
      <div>
        {machines.map((machine, index) => (
          <article key={machine.id} data-state={machine.state}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{machine.name.replace("Lab Station ", "")}호기</strong><small>{machine.gpu}</small>{machine.project && <p>{machine.project}</p>}</div>
            <em>{machine.state === "available" ? "가능" : machine.state === "busy" ? "사용 중" : "점검"}</em>
          </article>
        ))}
      </div>
    </aside>
  );
}

function SavedPage({ onResume }: { onResume: () => void }) {
  return <div className={s.enter}><div className={s.pageTitle}><div className={s.titleLine}><h1>보관함</h1><HelpTip text="종료한 작업 환경은 30일간 보관됩니다." /></div></div><section className={s.fullSheet}><div className={s.sheetTools}><strong>2개 작업</strong><div><button>최근 저장순</button><button>검색</button></div></div>{savedSessions.map((item, index)=><article className={s.savedItem} key={item.id}><span className={s.savedIndex}>{String(index+1).padStart(2,"0")}</span><div><h2>{item.name}</h2><p>{item.savedAt} 저장 · {item.machine}</p></div><dl><div><dt>환경</dt><dd>{item.specs}</dd></div><div><dt>사용량</dt><dd>{item.size}</dd></div><div><dt>자동 삭제</dt><dd>{item.deleteIn}</dd></div></dl><button className={s.solidButton} onClick={onResume}>이어하기</button><button className={s.quietButton}>삭제</button></article>)}</section></div>;
}

function HistoryPage() {
  return <div className={s.enter}><div className={s.pageTitle}><div className={s.titleLine}><h1>사용 기록</h1><HelpTip text="최근 30일간의 세션과 파일 이동 기록입니다." /></div><button className={s.lineButton}>기록 내려받기</button></div><section className={s.fullSheet}><div className={s.historySummary}><div><span>이번 달 사용</span><strong>46시간 12분</strong></div><div><span>시작한 작업</span><strong>7회</strong></div><div><span>파일 전송</span><strong>12.4GB</strong></div></div><div className={s.historyList}>{activity.map((item,index)=><article key={item.title}><time>{item.time}</time><span>{String(index+1).padStart(2,"0")}</span><div><strong>{item.title}</strong><p>{item.detail}</p></div></article>)}</div></section></div>;
}

function GuidePage() {
  const rows = [["01","PC 신청","작업 이름과 필요한 사양을 입력하고 장비를 선택합니다."],["02","원격 접속","배정이 끝나면 데스크톱 열기를 눌러 Ubuntu 환경에 접속합니다."],["03","파일 전송","내 컴퓨터의 파일을 실행 중인 PC의 받은파일 폴더로 보냅니다."],["04","종료와 보관","작업 종료 시 설치 환경과 파일이 30일간 보관됩니다."]];
  return <div className={s.enter}><div className={s.pageTitle}><div className={s.titleLine}><h1>이용 안내</h1><HelpTip text="GPU 전산실의 기본 사용 절차입니다." /></div></div><section className={s.guideSheet}>{rows.map(row=><article key={row[0]}><span>{row[0]}</span><h2>{row[1]}</h2><p>{row[2]}</p><button>자세히</button></article>)}</section><div className={s.contactLine}><div className={s.titleLine}><strong>접속 문제가 계속되나요?</strong><HelpTip text="오류 코드와 장비 번호를 전산 담당자에게 전달하세요." /></div><button className={s.lineButton}>문의 방법</button></div></div>;
}

function RequestSheet({ onClose, onSubmit }: { onClose: () => void; onSubmit: () => void }) {
  const [selected, setSelected] = useState("lab-01");
  return <Overlay><section className={s.requestSheet}><header><div><span>작업 신청서</span><h2>새 PC 배정</h2></div><button onClick={onClose}>닫기</button></header><div className={s.formGrid}><div className={s.formMain}><Field label="작업 이름"><input defaultValue="실시간 교통 객체 인식" /></Field><Field label="함께 사용할 학생"><div className={s.inlineInput}><input placeholder="@ts.hs.kr 계정" /><button>추가</button></div></Field><fieldset><legend>작업 성격</legend><div className={s.workTypes}><label><input type="radio" name="type" /><span>일반 연산<small>코딩·자료 처리</small></span></label><label><input type="radio" name="type" defaultChecked /><span>GPU 학습<small>비전·딥러닝</small></span></label><label><input type="radio" name="type" /><span>직접 지정<small>사양 개별 선택</small></span></label></div></fieldset><div className={s.specFields}><Field label="CPU"><select defaultValue="8"><option>4</option><option>8</option><option>16</option></select><small>코어 이상</small></Field><Field label="메모리"><select defaultValue="16"><option>8</option><option>16</option><option>32</option></select><small>GB 이상</small></Field><Field label="저장 공간"><select defaultValue="100"><option>50</option><option>100</option><option>250</option></select><small>GB</small></Field><Field label="유지 기간"><select defaultValue="7"><option>1</option><option>7</option><option>14</option><option>30</option></select><small>일</small></Field></div></div><aside className={s.selectMachine}><div className={s.titleLine}><h3>장비 선택</h3><HelpTip text="요청 사양을 만족하는 장비만 선택할 수 있습니다." /></div>{machines.map((machine,index)=><button key={machine.id} disabled={machine.state!=="available"} data-on={selected===machine.id} onClick={()=>setSelected(machine.id)}><span>{String(index+1).padStart(2,"0")}</span><div><strong>{index+1}호기</strong><small>{machine.gpu}<br/>{machine.ram} · {machine.storage}</small></div><em>{machine.state==="available"?"선택 가능":machine.state==="busy"?"사용 중":"점검"}</em></button>)}</aside></div><footer><div><span>선택</span><strong>1호기 · GPU 학습 · 7일</strong></div><button className={s.lineButton} onClick={onClose}>취소</button><button className={s.solidButton} onClick={onSubmit}>배정 요청</button></footer></section></Overlay>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className={s.fieldLabel}><span>{label}</span><div>{children}</div></label>; }

function UploadSheet({ onClose, onSubmit }: { onClose: () => void; onSubmit: () => void }) {
  const [picked, setPicked] = useState(false);
  return <Overlay><section className={s.uploadSheet}><header><div><span>1호기 / 받은파일</span><div className={s.titleLine}><h2>파일 보내기</h2><HelpTip text="전송된 파일은 실행 중인 PC의 바탕화면/받은파일 폴더에 저장됩니다." /></div></div><button onClick={onClose}>닫기</button></header>{picked?<div className={s.selectedFile}><span>ZIP</span><div><strong>dataset-v4.zip</strong><small>1.82GB</small></div><button onClick={()=>setPicked(false)}>제거</button></div>:<button className={s.fileDrop} onClick={()=>setPicked(true)}><strong>파일을 여기에 놓으세요.</strong><span>또는 눌러서 파일 선택</span><small>파일당 최대 50GB</small></button>}<footer><span>사용 가능 1.47TB</span><button className={s.lineButton} onClick={onClose}>취소</button><button className={s.solidButton} disabled={!picked} onClick={onSubmit}>전송 시작</button></footer></section></Overlay>;
}

function Overlay({ children }: { children: ReactNode }) { return <div className={s.overlay}>{children}</div>; }

function HelpTip({ text }: { text: string }) {
  return <span className={s.helpTip}><button aria-label="도움말" type="button">?</button><span role="tooltip">{text}</span></span>;
}

function PowerIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 2v10"/><path d="M6.3 5.3a8 8 0 1 0 11.4 0"/></svg>;
}

function AdminArea({ flash }: { flash: (text: string) => void }) {
  const [tab,setTab]=useState<AdminPage>("status");
  const tabs: {key:AdminPage;label:string}[]=[{key:"status",label:"운영 현황"},{key:"pc",label:"PC"},{key:"session",label:"세션"},{key:"people",label:"사용자"},{key:"notice",label:"공지"},{key:"clean",label:"정리"}];
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "admin-session") { setTab("session"); return; }
    const requested = params.get("tab") as AdminPage | null;
    if (requested && ["status", "pc", "session", "people", "notice", "clean"].includes(requested)) setTab(requested);
  }, []);
  return <div className={s.enter}><div className={s.pageTitle}><div className={s.titleLine}><h1>관리</h1><HelpTip text="장비 배정과 사용자 세션을 관리합니다." /></div><span className={s.operating}><i/>전체 서비스 정상</span></div><nav className={s.adminTabs}>{tabs.map(item=><button key={item.key} data-on={tab===item.key} onClick={()=>setTab(item.key)}>{item.label}</button>)}</nav>{tab==="status"&&<AdminStatus setTab={setTab}/>} {tab==="pc"&&<AdminPc/>} {tab==="session"&&<AdminSessions flash={flash}/>} {tab==="people"&&<AdminPeople/>} {tab==="notice"&&<AdminNotice flash={flash}/>} {tab==="clean"&&<AdminClean flash={flash}/>}</div>;
}

function AdminStatus({setTab}:{setTab:(tab:AdminPage)=>void}) { return <><div className={s.adminCounts}><div><span>온라인</span><strong>4<small>/ 5대</small></strong></div><div><span>사용 중</span><strong>2<small>대</small></strong></div><div><span>대기</span><strong>1<small>명</small></strong></div><div><span>저장 공간</span><strong>31<small>%</small></strong></div></div><div className={s.adminGrid}><section className={s.opsSheet}><div className={s.blockHeading}><h2>장비 상태</h2><button onClick={()=>setTab("pc")}>전체 보기</button></div>{machines.map((machine,index)=><div className={s.opsMachine} key={machine.id}><span>{String(index+1).padStart(2,"0")}</span><div><strong>{index+1}호기</strong><small>{machine.gpu}</small></div><em data-state={machine.state}>{machine.state==="available"?"대기":machine.state==="busy"?"사용 중":"점검"}</em><p>{machine.project||"—"}</p><dl><div><dt>CPU</dt><dd>{machine.cpuUsage}%</dd></div><div><dt>GPU</dt><dd>{machine.gpuUsage}%</dd></div></dl></div>)}</section><aside className={s.waitSheet}><h2>대기열</h2><article><span>01</span><div><strong>ts260011@ts.hs.kr</strong><small>14:21 등록</small></div></article><dl><div><dt>요청</dt><dd>GPU 학습</dd></div><div><dt>예상 배정</dt><dd>14:50</dd></div></dl></aside></div></> }

function AdminPc(){return <AdminTable title="PC 관리" headers={["장비","상태","사용자 / 작업","CPU","GPU","저장 공간",""]}>{machines.map((m,i)=><div className={s.adminRow} key={m.id}><span><b>{String(i+1).padStart(2,"0")}</b>{i+1}호기<small>{m.gpu}</small></span><span>{m.state==="available"?"대기":m.state==="busy"?"사용 중":"점검"}</span><span>{m.owner||"—"}<small>{m.project}</small></span><span>{m.cpuUsage}%</span><span>{m.gpuUsage}%</span><span>{m.storage}</span><button>관리</button></div>)}</AdminTable>}
function AdminSessions({flash}:{flash:(text:string)=>void}){const rows=[["실시간 교통 객체 인식","ts250015","1호기","사용 중","6:42:18"],["YOLOv8 도로 객체 탐지","ts250021","2호기","사용 중","2:18:02"],["LLM Fine-tuning","ts250008","3호기","사용 중","11:05:44"],["자율주행 데이터셋","ts250015","—","보관","27일"]];return <AdminTable title="세션 관리" headers={["작업","사용자","장비","상태","남은 시간",""]}>{rows.map(row=><div className={s.adminRow} key={row[0]}><span><strong>{row[0]}</strong></span><span>{row[1]}</span><span>{row[2]}</span><span>{row[3]}</span><span>{row[4]}</span><button onClick={()=>flash("세션 관리 메뉴를 열었습니다.")}>관리</button></div>)}</AdminTable>}
function AdminPeople(){return <AdminTable title="사용자 관리" headers={["계정","권한","활성 세션","최대 허용","최근 접속",""]}>{users.map(user=><div className={s.adminRow} key={user.email}><span><strong>{user.email}</strong></span><span>{user.role}</span><span>{user.sessions}개</span><span><select defaultValue={user.limit}><option>1</option><option>2</option><option>3</option></select>대</span><span>{user.lastSeen}</span><button>관리</button></div>)}</AdminTable>}

function AdminTable({title,headers,children}:{title:string;headers:string[];children:ReactNode}){return <section className={s.adminTable}><div className={s.blockHeading}><h2>{title}</h2><div><button>검색</button><button>새로고침</button></div></div><div className={s.adminHead}>{headers.map((h,i)=><span key={i}>{h}</span>)}</div>{children}</section>}

function AdminNotice({flash}:{flash:(text:string)=>void}){return <div className={s.settings}><section><div className={s.titleLine}><h2>학생 공지</h2><HelpTip text="내 작업 화면의 공지 영역에 표시됩니다." /></div><Field label="제목"><input defaultValue="오늘 18:00 네트워크 점검"/></Field><Field label="내용"><textarea rows={7} defaultValue="약 10분간 원격 접속이 불안정할 수 있습니다. 진행 중인 작업을 미리 저장해 주세요."/></Field><label className={s.checkLine}><input type="checkbox" defaultChecked/>학생 화면에 표시</label><button className={s.solidButton} onClick={()=>flash("공지를 저장했습니다.")}>저장</button></section><aside><span>미리 보기</span><time>06.29</time><h3>오늘 18:00 네트워크 점검</h3><p>약 10분간 원격 접속이 불안정할 수 있습니다. 진행 중인 작업을 미리 저장해 주세요.</p></aside></div>}
function AdminClean({flash}:{flash:(text:string)=>void}){return <div className={s.cleanGrid}><section><div className={s.titleLine}><h2>중단된 컨테이너</h2><HelpTip text="종료 후 남아 있는 컨테이너입니다." /></div>{[["session_a8f2c1_stopped","2.4GB · 저장된 세션"],["session_f1c09a_failed","812MB · 고아 컨테이너"]].map(row=><article key={row[0]}><div><strong>{row[0]}</strong><small>{row[1]}</small></div><button>삭제</button></article>)}<button className={s.lineButton} onClick={()=>flash("정리 작업을 시작했습니다.")}>전체 정리</button></section><section><div className={s.titleLine}><h2>서비스 확인</h2><HelpTip text="마지막 확인은 4초 전입니다." /></div>{["프론트엔드","중앙 허브","Firebase","노드 SSH"].map(name=><article key={name}><span><i/>{name}</span><strong>정상</strong></article>)}<button className={s.lineButton}>다시 확인</button></section></div>}
