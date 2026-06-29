"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { activity, machines, savedSessions, users } from "./fixtures";
import styles from "./design-lab.module.css";

type View = "dashboard" | "saved" | "activity" | "guide" | "admin";
type SessionState = "idle" | "starting" | "ready" | "queued" | "error";
type AdminTab = "overview" | "machines" | "sessions" | "users" | "notice" | "maintenance";

const stateLabels: Record<SessionState, string> = {
  idle: "사용 가능",
  starting: "준비 중",
  ready: "사용 중",
  queued: "대기 중",
  error: "오류",
};

const navItems: { id: View; label: string; icon: IconName }[] = [
  { id: "dashboard", label: "워크스페이스", icon: "grid" },
  { id: "saved", label: "저장된 작업", icon: "archive" },
  { id: "activity", label: "활동", icon: "pulse" },
  { id: "guide", label: "이용 안내", icon: "help" },
];

export default function PrototypeApp() {
  const [view, setView] = useState<View>("dashboard");
  const [sessionState, setSessionState] = useState<SessionState>("ready");
  const [showRequest, setShowRequest] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showTerminate, setShowTerminate] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get("view") as View | null;
    const requestedState = params.get("state") as SessionState | null;
    if (requestedView && ["dashboard", "saved", "activity", "guide", "admin"].includes(requestedView)) {
      setView(requestedView);
    }
    if (requestedState && Object.prototype.hasOwnProperty.call(stateLabels, requestedState)) {
      setSessionState(requestedState);
    }
  }, []);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2400);
  }

  return (
    <div className={styles.lab}>
      <div className={styles.ambient} aria-hidden="true">
        <span className={styles.orbOne} />
        <span className={styles.orbTwo} />
        <span className={styles.orbThree} />
        <span className={styles.mesh} />
      </div>

      <div className={styles.prototypeBar}>
        <div className={styles.prototypeMark}>
          <span>DESIGN LAB</span>
          <b>Prismatic Glass · 01</b>
        </div>
        <div className={styles.statePicker} aria-label="프로토타입 상태 선택">
          {(Object.keys(stateLabels) as SessionState[]).map((state) => (
            <button
              key={state}
              className={sessionState === state ? styles.stateActive : ""}
              onClick={() => {
                setSessionState(state);
                setView("dashboard");
              }}
            >
              {stateLabels[state]}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.appFrame}>
        <aside className={styles.sidebar}>
          <button className={styles.brand} onClick={() => setView("dashboard")}>
            <span className={styles.brandSymbol}>
              <span />
              <span />
              <span />
            </span>
            <span>
              <b>DSHS</b>
              <small>COMPUTE LAB</small>
            </span>
          </button>

          <nav className={styles.nav}>
            <p className={styles.navLabel}>MY COMPUTE</p>
            {navItems.map((item) => (
              <NavButton key={item.id} active={view === item.id} onClick={() => setView(item.id)}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {item.id === "saved" && <em>2</em>}
              </NavButton>
            ))}
            <p className={styles.navLabel}>MANAGEMENT</p>
            <NavButton active={view === "admin"} onClick={() => setView("admin")}>
              <Icon name="shield" />
              <span>관리자 콘솔</span>
            </NavButton>
          </nav>

          <div className={styles.systemMini}>
            <div>
              <span className={styles.liveDot} />
              <strong>시스템 정상</strong>
            </div>
            <p>4대 온라인 · 2대 사용 가능</p>
            <div className={styles.miniBars}><i /><i /><i /><i /><i /><i /><i /><i /></div>
          </div>
        </aside>

        <div className={styles.workspace}>
          <header className={styles.topbar}>
            <div className={styles.breadcrumb}>
              <span>Compute Lab</span>
              <Icon name="chevron" />
              <strong>{view === "admin" ? "관리자 콘솔" : navItems.find((item) => item.id === view)?.label}</strong>
            </div>
            <div className={styles.topActions}>
              <button className={styles.iconButton} aria-label="알림">
                <Icon name="bell" />
                <span className={styles.notificationDot} />
              </button>
              <button className={styles.profile}>
                <span className={styles.avatar}>15</span>
                <span><b>ts250015</b><small>학생 · 관리자</small></span>
                <Icon name="down" />
              </button>
            </div>
          </header>

          <main className={styles.content}>
            {view === "dashboard" && (
              <DashboardView
                sessionState={sessionState}
                setSessionState={setSessionState}
                onRequest={() => setShowRequest(true)}
                onUpload={() => setShowUpload(true)}
                onTerminate={() => setShowTerminate(true)}
                onSaved={() => setView("saved")}
              />
            )}
            {view === "saved" && <SavedView onResume={() => { setSessionState("starting"); setView("dashboard"); notify("저장된 환경을 복원하고 있습니다."); }} />}
            {view === "activity" && <ActivityView />}
            {view === "guide" && <GuideView />}
            {view === "admin" && <AdminConsole notify={notify} />}
          </main>
        </div>
      </div>

      <nav className={styles.mobileNav}>
        {navItems.slice(0, 3).map((item) => (
          <button key={item.id} className={view === item.id ? styles.mobileActive : ""} onClick={() => setView(item.id)}>
            <Icon name={item.icon} /><span>{item.label}</span>
          </button>
        ))}
        <button className={view === "admin" ? styles.mobileActive : ""} onClick={() => setView("admin")}>
          <Icon name="shield" /><span>관리자</span>
        </button>
      </nav>

      {showRequest && <RequestPanel onClose={() => setShowRequest(false)} onStart={() => { setShowRequest(false); setSessionState("starting"); notify("Lab Station 01을 준비합니다."); }} />}
      {showUpload && <UploadPanel onClose={() => setShowUpload(false)} notify={notify} />}
      {showTerminate && (
        <ConfirmDialog
          onClose={() => setShowTerminate(false)}
          onConfirm={() => { setShowTerminate(false); setSessionState("idle"); notify("세션이 안전하게 보관되었습니다."); }}
        />
      )}
      {toast && <div className={styles.toast}><Icon name="check" />{toast}</div>}
    </div>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button className={`${styles.navButton} ${active ? styles.navActive : ""}`} onClick={onClick}>{children}</button>;
}

function DashboardView({
  sessionState,
  setSessionState,
  onRequest,
  onUpload,
  onTerminate,
  onSaved,
}: {
  sessionState: SessionState;
  setSessionState: (state: SessionState) => void;
  onRequest: () => void;
  onUpload: () => void;
  onTerminate: () => void;
  onSaved: () => void;
}) {
  return (
    <div className={styles.pageEnter}>
      <section className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>MONDAY, JUNE 29</p>
          <h1>좋은 오후예요, <span>ts250015</span></h1>
          <p>필요한 연산 환경을 만들고, 중단한 작업을 바로 이어가세요.</p>
        </div>
        <button className={styles.primaryButton} onClick={onRequest}><Icon name="plus" />새 작업 시작</button>
      </section>

      <div className={styles.dashboardGrid}>
        <SessionPanel
          state={sessionState}
          onRequest={onRequest}
          onUpload={onUpload}
          onTerminate={onTerminate}
          onReady={() => setSessionState("ready")}
        />
        <aside className={styles.rightRail}>
          <AvailabilityCard onRequest={onRequest} />
          <NoticeCard />
        </aside>
      </div>

      <section className={styles.sectionBlock}>
        <div className={styles.sectionHead}>
          <div><p className={styles.eyebrow}>PERSISTENT WORKSPACE</p><h2>저장된 작업</h2></div>
          <button className={styles.textButton} onClick={onSaved}>전체 보기 <Icon name="arrow" /></button>
        </div>
        <div className={styles.savedList}>
          {savedSessions.map((session) => (
            <article className={styles.savedRow} key={session.id}>
              <div className={styles.fileGlyph}><Icon name="layers" /></div>
              <div className={styles.savedName}><strong>{session.name}</strong><span>{session.machine} · {session.savedAt}</span></div>
              <span className={styles.specText}>{session.specs}</span>
              <span className={styles.deleteText}><small>자동 삭제</small>{session.deleteIn}</span>
              <button className={styles.secondaryButton} onClick={() => setSessionState("starting")}>이어서 사용</button>
              <button className={styles.moreButton} aria-label="더 보기"><Icon name="more" /></button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function SessionPanel({ state, onRequest, onUpload, onTerminate, onReady }: {
  state: SessionState;
  onRequest: () => void;
  onUpload: () => void;
  onTerminate: () => void;
  onReady: () => void;
}) {
  return (
    <section className={`${styles.glassPanel} ${styles.sessionPanel}`}>
      <div className={styles.panelTopline}>
        <div><span className={styles.liveDot} /><span>MY ACTIVE SESSION</span></div>
        <StateBadge state={state} />
      </div>

      {state === "ready" && (
        <div className={styles.readyContent}>
          <div className={styles.projectTitle}>
            <div><p>컴퓨터 비전 탐구</p><h2>실시간 교통 객체 인식</h2></div>
            <div className={styles.timeBlock}><small>남은 시간</small><strong>6:42:18</strong><span>오늘 오후 9:20 종료</span></div>
          </div>
          <div className={styles.machineLine}>
            <span className={styles.machineIcon}><Icon name="monitor" /></span>
            <div><strong>Lab Station 01</strong><span>RTX 4090 24GB · Ryzen 9 7950X · Seoul Lab</span></div>
            <button className={styles.livePill}><span />연결됨</button>
          </div>
          <div className={styles.usageGrid}>
            <UsageMetric label="CPU" value="38%" detail="12 / 32 cores" percent={38} />
            <UsageMetric label="GPU" value="72%" detail="17.4 / 24GB" percent={72} violet />
            <UsageMetric label="MEMORY" value="41%" detail="26.2 / 64GB" percent={41} />
            <UsageMetric label="STORAGE" value="18%" detail="328 / 1800GB" percent={18} />
          </div>
          <div className={styles.sessionActions}>
            <a className={styles.openDesktop} href="#" onClick={(event) => event.preventDefault()}><Icon name="screen" />데스크톱 열기<Icon name="external" /></a>
            <button className={styles.secondaryButton} onClick={onUpload}><Icon name="upload" />파일 보내기</button>
            <button className={styles.moreButton} onClick={onTerminate} aria-label="세션 종료"><Icon name="power" /></button>
          </div>
        </div>
      )}

      {state === "idle" && (
        <div className={styles.emptyState}>
          <div className={styles.emptyVisual}><span /><Icon name="monitor" /></div>
          <h2>지금 바로 사용할 수 있어요</h2>
          <p>현재 사용 가능한 PC가 2대 있습니다. 작업에 필요한 사양을 선택하면 가장 적합한 PC를 연결합니다.</p>
          <button className={styles.primaryButton} onClick={onRequest}><Icon name="plus" />새 작업 시작</button>
          <span className={styles.microcopy}>보통 20초 안에 준비됩니다</span>
        </div>
      )}

      {state === "starting" && (
        <div className={styles.preparingState}>
          <div className={styles.loaderOrb}><span /><span /><Icon name="spark" /></div>
          <p className={styles.eyebrow}>PREPARING YOUR WORKSPACE</p>
          <h2>연산 환경을 구성하고 있어요</h2>
          <p>Lab Station 01에 프로젝트 환경과 저장 공간을 연결합니다.</p>
          <div className={styles.stepList}>
            <ProcessStep done label="PC 배정" detail="Lab Station 01" />
            <ProcessStep active label="컨테이너 시작" detail="약 8초 남음" />
            <ProcessStep label="원격 데스크톱 연결" detail="대기 중" />
          </div>
          <button className={styles.textButton} onClick={onReady}>프로토타입: 완료 상태 보기 <Icon name="arrow" /></button>
        </div>
      )}

      {state === "queued" && (
        <div className={styles.queueState}>
          <div className={styles.queueNumber}><span>대기 순번</span><strong>02</strong><small>번째</small></div>
          <div><p className={styles.eyebrow}>ALL MACHINES ARE ACTIVE</p><h2>자리가 생기면 바로 알려드릴게요</h2><p>현재 예상 대기 시간은 약 18분입니다. 이 페이지를 닫아도 순번은 유지됩니다.</p></div>
          <div className={styles.queueTrack}><i /><i /><i /><i /><i /></div>
          <button className={styles.secondaryButton}>대기 취소</button>
        </div>
      )}

      {state === "error" && (
        <div className={styles.errorState}>
          <span className={styles.errorIcon}><Icon name="warning" /></span>
          <p className={styles.eyebrow}>CONNECTION INTERRUPTED</p>
          <h2>PC와 연결하지 못했어요</h2>
          <p>VPN 또는 학교 네트워크 연결을 확인한 뒤 다시 시도해 주세요. 작업 데이터는 안전하게 보관되어 있습니다.</p>
          <div><button className={styles.primaryButton}>다시 연결</button><button className={styles.secondaryButton}>문제 해결 보기</button></div>
          <code>ERR_NODE_TUNNEL_TIMEOUT · LAB-01</code>
        </div>
      )}
    </section>
  );
}

function StateBadge({ state }: { state: SessionState }) {
  return <span className={`${styles.stateBadge} ${styles[`state_${state}`]}`}><i />{stateLabels[state]}</span>;
}

function UsageMetric({ label, value, detail, percent, violet = false }: { label: string; value: string; detail: string; percent: number; violet?: boolean }) {
  return (
    <div className={styles.usageMetric}>
      <span>{label}</span><strong>{value}</strong><small>{detail}</small>
      <div><i className={violet ? styles.violetBar : ""} style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

function ProcessStep({ label, detail, done = false, active = false }: { label: string; detail: string; done?: boolean; active?: boolean }) {
  return <div className={`${styles.processStep} ${done ? styles.stepDone : ""} ${active ? styles.stepActive : ""}`}><span>{done ? <Icon name="check" /> : active ? <i /> : null}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function AvailabilityCard({ onRequest }: { onRequest: () => void }) {
  return (
    <section className={`${styles.glassPanel} ${styles.availability}`}>
      <div className={styles.cardTitle}><span><Icon name="server" /></span><div><p>COMPUTE POOL</p><h3>전산실 현황</h3></div></div>
      <div className={styles.availabilityNumber}><strong>2</strong><span>대 사용 가능<small>전체 5대 중</small></span></div>
      <div className={styles.machineDots}><i /><i /><i className={styles.dotBusy} /><i className={styles.dotBusy} /><i className={styles.dotOffline} /></div>
      <div className={styles.availabilityRows}>
        <div><span><i />사용 가능</span><strong>2</strong></div>
        <div><span><i className={styles.dotBusy} />사용 중</span><strong>2</strong></div>
        <div><span><i className={styles.dotOffline} />점검 중</span><strong>1</strong></div>
      </div>
      <button className={styles.textButton} onClick={onRequest}>PC 사양 확인 <Icon name="arrow" /></button>
    </section>
  );
}

function NoticeCard() {
  return (
    <section className={`${styles.glassPanel} ${styles.noticeCard}`}>
      <div className={styles.noticeHead}><span>NOTICE</span><time>06.29</time></div>
      <h3>오늘 18:00 네트워크 점검</h3>
      <p>약 10분간 원격 접속이 불안정할 수 있습니다. 진행 중인 작업을 미리 저장해 주세요.</p>
      <button className={styles.textButton}>자세히 보기 <Icon name="arrow" /></button>
    </section>
  );
}

function SavedView({ onResume }: { onResume: () => void }) {
  return (
    <div className={styles.pageEnter}>
      <section className={styles.pageHeading}><div><p className={styles.eyebrow}>PERSISTENT WORKSPACES</p><h1>저장된 작업</h1><p>중단한 환경과 파일은 30일 동안 그대로 보관됩니다.</p></div><button className={styles.primaryButton}><Icon name="plus" />새 작업 시작</button></section>
      <div className={styles.filterBar}><button className={styles.filterActive}>전체 <span>2</span></button><button>최근 저장</button><button>곧 삭제</button><div /><button><Icon name="search" />검색</button><button><Icon name="sort" />정렬</button></div>
      <div className={styles.savedCards}>
        {savedSessions.map((session, index) => (
          <article className={`${styles.glassPanel} ${styles.savedCard}`} key={session.id}>
            <div className={`${styles.savedArtwork} ${index ? styles.artworkTwo : ""}`}><span /><span /><span /><Icon name="layers" /></div>
            <div className={styles.savedCardBody}>
              <div className={styles.savedCardTitle}><span className={styles.stateBadge}><i />저장됨</span><button className={styles.moreButton}><Icon name="more" /></button></div>
              <h2>{session.name}</h2><p>{session.machine} · {session.specs}</p>
              <div className={styles.savedMeta}><span><small>저장 공간</small><strong>{session.size}</strong></span><span><small>마지막 저장</small><strong>{session.savedAt}</strong></span><span><small>자동 삭제</small><strong>{session.deleteIn}</strong></span></div>
              <div className={styles.savedCardActions}><button className={styles.primaryButton} onClick={onResume}><Icon name="play" />이어서 사용</button><button className={styles.secondaryButton}><Icon name="trash" />완전히 제거</button></div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ActivityView() {
  return (
    <div className={styles.pageEnter}>
      <section className={styles.pageHeading}><div><p className={styles.eyebrow}>AUDIT & HISTORY</p><h1>최근 활동</h1><p>세션, 파일 전송, 팀 작업의 최근 변경사항입니다.</p></div><button className={styles.secondaryButton}><Icon name="download" />기록 내보내기</button></section>
      <section className={`${styles.glassPanel} ${styles.activityPanel}`}>
        <div className={styles.activitySummary}><div><span>이번 주 사용 시간</span><strong>18시간 42분</strong><small>지난주보다 12% 증가</small></div><div className={styles.weekBars}>{[38,55,24,72,92,64,18].map((n,i)=><span key={i}><i style={{height:`${n}%`}} /></span>)}</div></div>
        <div className={styles.timeline}>
          {activity.map((item) => <div className={styles.timelineItem} key={item.title}><time>{item.time}</time><span className={styles[`tone_${item.tone}`]}><Icon name={item.tone === "green" ? "upload" : item.tone === "violet" ? "archive" : "pulse"} /></span><div><strong>{item.title}</strong><p>{item.detail}</p></div><button className={styles.moreButton}><Icon name="more" /></button></div>)}
        </div>
      </section>
    </div>
  );
}

function GuideView() {
  const guides = [
    ["01", "새 작업 만들기", "프로젝트 이름과 필요한 사양을 선택하면 사용 가능한 PC를 자동으로 연결합니다."],
    ["02", "원격 데스크톱 사용", "브라우저에서 Ubuntu 환경을 열고 개발 도구와 GPU를 바로 사용할 수 있습니다."],
    ["03", "내 PC에서 파일 보내기", "활성 세션의 파일 보내기 메뉴에서 대용량 파일도 안전하게 전송할 수 있습니다."],
    ["04", "작업 저장하고 종료하기", "세션을 종료하면 현재 환경이 저장되며 30일 안에 그대로 이어갈 수 있습니다."],
  ];
  return (
    <div className={styles.pageEnter}>
      <section className={`${styles.glassPanel} ${styles.guideHero}`}><div><p className={styles.eyebrow}>GETTING STARTED</p><h1>무엇을 도와드릴까요?</h1><p>PC 대여부터 파일 전송까지, 필요한 내용을 빠르게 찾아보세요.</p><label><Icon name="search" /><input placeholder="도움말 검색" /></label></div><div className={styles.guideOrb}><span /><Icon name="spark" /></div></section>
      <div className={styles.guideGrid}>{guides.map(([num,title,copy])=><article className={styles.glassPanel} key={num}><span>{num}</span><Icon name={num === "01" ? "plus" : num === "02" ? "screen" : num === "03" ? "upload" : "archive"} /><h3>{title}</h3><p>{copy}</p><button className={styles.textButton}>내용 보기 <Icon name="arrow" /></button></article>)}</div>
      <section className={styles.supportBanner}><div><Icon name="message" /><span><strong>해결되지 않았나요?</strong><small>전산 담당 선생님에게 오류 코드와 함께 문의하세요.</small></span></div><button className={styles.secondaryButton}>문의 방법 보기</button></section>
    </div>
  );
}

function RequestPanel({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  const [preset, setPreset] = useState("gpu");
  const [selected, setSelected] = useState("lab-01");
  return (
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.requestPanel}>
        <header className={styles.modalHeader}><div><p className={styles.eyebrow}>NEW WORKSPACE</p><h2>새 작업 시작</h2></div><button className={styles.closeButton} onClick={onClose}><Icon name="close" /></button></header>
        <div className={styles.requestBody}>
          <div className={styles.formSection}><div className={styles.formNumber}>01</div><div className={styles.formContent}><h3>작업 정보</h3><p>나중에 쉽게 찾을 수 있는 이름을 사용하세요.</p><label>프로젝트 이름<input defaultValue="컴퓨터 비전 탐구" /></label><label>팀원 <span>선택</span><div className={styles.memberInput}><span>ts250042@ts.hs.kr <button>×</button></span><input placeholder="학교 이메일로 추가" /><button>추가</button></div></label></div></div>
          <div className={styles.formSection}><div className={styles.formNumber}>02</div><div className={styles.formContent}><h3>작업 유형</h3><p>유형을 선택하면 권장 사양을 자동으로 설정합니다.</p><div className={styles.presetGrid}>
            <Preset active={preset === "basic"} onClick={() => setPreset("basic")} icon="code" title="일반 실습" copy="코딩·데이터 분석" spec="4 Core · 8GB" />
            <Preset active={preset === "gpu"} onClick={() => setPreset("gpu")} icon="spark" title="GPU 학습" copy="비전·딥러닝" spec="8 Core · 16GB" recommended />
            <Preset active={preset === "high"} onClick={() => setPreset("high")} icon="gauge" title="고사양 작업" copy="LLM·대규모 학습" spec="16 Core · 32GB" />
          </div><button className={styles.advancedButton}><Icon name="sliders" />세부 사양 직접 설정<Icon name="down" /></button></div></div>
          <div className={styles.formSection}><div className={styles.formNumber}>03</div><div className={styles.formContent}><h3>PC 선택</h3><p>선택한 작업 유형에 적합한 PC만 표시됩니다.</p><div className={styles.machineSelectList}>{machines.map((machine) => <button key={machine.id} disabled={machine.state !== "available"} onClick={() => setSelected(machine.id)} className={selected === machine.id ? styles.machineSelected : ""}><span className={styles.radioMark} /><div><strong>{machine.name}</strong><small>{machine.gpu} · {machine.cpu}</small></div><span className={`${styles.machineStatus} ${machine.state !== "available" ? styles.unavailable : ""}`}>{machine.state === "available" ? "사용 가능" : machine.state === "offline" ? "점검 중" : "사용 중"}</span></button>)}</div><label className={styles.durationLabel}>유지 기간 <strong>7일</strong><input type="range" min="1" max="30" defaultValue="7" /><span><small>1일</small><small>30일</small></span></label></div></div>
        </div>
        <footer className={styles.requestFooter}><div><span>선택한 환경</span><strong>GPU 학습 · RTX 4090 · 7일</strong></div><button className={styles.secondaryButton} onClick={onClose}>취소</button><button className={styles.primaryButton} onClick={onStart}>Lab Station 01에서 시작<Icon name="arrow" /></button></footer>
      </section>
    </div>
  );
}

function Preset({ active, onClick, icon, title, copy, spec, recommended = false }: { active: boolean; onClick: () => void; icon: IconName; title: string; copy: string; spec: string; recommended?: boolean }) {
  return <button className={`${styles.presetCard} ${active ? styles.presetActive : ""}`} onClick={onClick}>{recommended && <em>추천</em>}<span><Icon name={icon} /></span><strong>{title}</strong><p>{copy}</p><small>{spec}</small></button>;
}

function UploadPanel({ onClose, notify }: { onClose: () => void; notify: (message: string) => void }) {
  const [hasFile, setHasFile] = useState(false);
  return (
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`${styles.glassPanel} ${styles.uploadModal}`}>
        <header className={styles.modalHeader}><div><p className={styles.eyebrow}>FILE TRANSFER</p><h2>내 PC로 파일 보내기</h2></div><button className={styles.closeButton} onClick={onClose}><Icon name="close" /></button></header>
        <div className={styles.destination}><span className={styles.machineIcon}><Icon name="monitor" /></span><div><small>보낼 위치</small><strong>Lab Station 01 · 바탕화면/받은파일</strong></div><span><i />연결됨</span></div>
        {!hasFile ? <button className={styles.dropzone} onClick={() => setHasFile(true)}><span><Icon name="upload" /></span><strong>여기에 파일을 놓거나 선택하세요</strong><small>파일당 최대 50GB · 대용량 파일은 자동으로 나누어 전송합니다</small><em>파일 선택</em></button> : <div className={styles.uploadFile}><span><Icon name="file" /></span><div><strong>dataset-v4.zip</strong><small>1.82GB · 준비됨</small><div><i style={{width:"100%"}} /></div></div><button onClick={() => setHasFile(false)}><Icon name="close" /></button></div>}
        <div className={styles.transferInfo}><Icon name="info" /><p>전송 중에는 이 창을 열어두세요. 전송된 파일은 실행 중인 PC의 <strong>받은파일</strong> 폴더에 나타납니다.</p></div>
        <footer className={styles.modalFooter}><span>사용 가능 공간 <strong>1.47TB</strong></span><button className={styles.secondaryButton} onClick={onClose}>취소</button><button disabled={!hasFile} className={styles.primaryButton} onClick={() => { notify("dataset-v4.zip 전송을 시작했습니다."); onClose(); }}><Icon name="upload" />전송 시작</button></footer>
      </section>
    </div>
  );
}

function ConfirmDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return <div className={styles.overlay}><section className={`${styles.glassPanel} ${styles.confirmDialog}`}><span className={styles.warningOrb}><Icon name="power" /></span><p className={styles.eyebrow}>END SESSION</p><h2>작업을 저장하고 종료할까요?</h2><p>실행 중인 프로그램은 종료되지만 파일과 설치된 환경은 30일간 보관됩니다.</p><div><button className={styles.secondaryButton} onClick={onClose}>계속 사용</button><button className={styles.dangerButton} onClick={onConfirm}>저장하고 종료</button></div></section></div>;
}

function AdminConsole({ notify }: { notify: (message: string) => void }) {
  const [tab, setTab] = useState<AdminTab>("overview");
  const tabs: { id: AdminTab; label: string }[] = [
    { id: "overview", label: "현황" }, { id: "machines", label: "PC" }, { id: "sessions", label: "세션" },
    { id: "users", label: "사용자" }, { id: "notice", label: "공지" }, { id: "maintenance", label: "유지보수" },
  ];
  return (
    <div className={styles.pageEnter}>
      <section className={styles.pageHeading}><div><p className={styles.eyebrow}>SYSTEM MANAGEMENT</p><h1>관리자 콘솔</h1><p>전산실 PC와 사용자 세션을 한곳에서 관리합니다.</p></div><div className={styles.adminHealth}><span className={styles.liveDot} /><div><strong>모든 서비스 정상</strong><small>마지막 확인 4초 전</small></div></div></section>
      <div className={styles.adminTabs}>{tabs.map(item=><button key={item.id} className={tab===item.id?styles.adminTabActive:""} onClick={()=>setTab(item.id)}>{item.label}{item.id==="sessions"&&<span>3</span>}</button>)}</div>
      {tab === "overview" && <AdminOverview setTab={setTab} />}
      {tab === "machines" && <MachineTable />}
      {tab === "sessions" && <SessionsTable notify={notify} />}
      {tab === "users" && <UsersTable />}
      {tab === "notice" && <NoticeEditor notify={notify} />}
      {tab === "maintenance" && <MaintenancePanel notify={notify} />}
    </div>
  );
}

function AdminOverview({ setTab }: { setTab: (tab: AdminTab) => void }) {
  return <>
    <div className={styles.kpiGrid}><KpiCard icon="server" label="온라인 PC" value="4 / 5" note="1대 점검 중" tone="blue" /><KpiCard icon="screen" label="활성 세션" value="2" note="40% 사용률" tone="green" /><KpiCard icon="clock" label="대기열" value="1" note="예상 18분" tone="amber" /><KpiCard icon="database" label="총 저장 공간" value="6.2 TB" note="31% 사용 중" tone="violet" /></div>
    <div className={styles.adminOverviewGrid}><section className={`${styles.glassPanel} ${styles.fleetPanel}`}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>LIVE FLEET</p><h2>PC 모니터링</h2></div><button className={styles.textButton} onClick={()=>setTab("machines")}>전체 보기 <Icon name="arrow" /></button></div><div className={styles.fleetGrid}>{machines.map(machine=><MachineMini key={machine.id} machine={machine} />)}</div></section><section className={`${styles.glassPanel} ${styles.queuePanel}`}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>WAITING</p><h2>대기열</h2></div><span>1명</span></div><div className={styles.queuePerson}><span className={styles.avatar}>11</span><div><strong>ts260011@ts.hs.kr</strong><small>GPU 학습 · 14:21 등록</small></div><em>#1</em></div><div className={styles.queueEstimate}><Icon name="clock" /><span>예상 배정 시각<strong>오후 2:50</strong></span></div></section></div>
  </>;
}

function KpiCard({ icon, label, value, note, tone }: { icon: IconName; label: string; value: string; note: string; tone: string }) {
  return <article className={`${styles.glassPanel} ${styles.kpiCard}`}><span className={styles[`kpi_${tone}`]}><Icon name={icon} /></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}

function MachineMini({ machine }: { machine: typeof machines[number] }) {
  return <article className={`${styles.machineMini} ${machine.state === "offline" ? styles.machineOffline : ""}`}><div><span className={styles.machineIcon}><Icon name="server" /></span><span className={`${styles.machineStatus} ${machine.state !== "available" ? styles.unavailable : ""}`}>{machine.state === "available" ? "사용 가능" : machine.state === "busy" ? "사용 중" : "오프라인"}</span></div><strong>{machine.name}</strong><small>{machine.gpu}</small><div className={styles.miniUsage}><span>GPU <b>{machine.gpuUsage}%</b></span><div><i style={{width:`${machine.gpuUsage}%`}} /></div></div>{machine.project?<p>{machine.project}<span>{machine.owner}</span></p>:<p className={styles.noProject}>배정된 작업 없음</p>}</article>;
}

function MachineTable() {
  return <section className={`${styles.glassPanel} ${styles.tablePanel}`}><TableHeader title="PC 목록" copy="5대 등록 · 실시간 상태" actions /><div className={styles.dataTable}><div className={styles.tableHead}><span>PC</span><span>상태</span><span>현재 작업</span><span>CPU / GPU</span><span>저장 공간</span><span /></div>{machines.map(machine=><div className={styles.tableRow} key={machine.id}><span className={styles.tableIdentity}><span className={styles.machineIcon}><Icon name="server" /></span><span><strong>{machine.name}</strong><small>{machine.gpu}</small></span></span><span><span className={`${styles.machineStatus} ${machine.state !== "available" ? styles.unavailable : ""}`}>{machine.state === "available" ? "사용 가능" : machine.state === "busy" ? "사용 중" : "오프라인"}</span></span><span>{machine.project?<><strong>{machine.project}</strong><small>{machine.owner}</small></>:<small>—</small>}</span><span className={styles.dualUsage}><small>CPU <b>{machine.cpuUsage}%</b></small><small>GPU <b>{machine.gpuUsage}%</b></small></span><span><strong>{machine.storage}</strong><small>사용 가능</small></span><button className={styles.moreButton}><Icon name="more" /></button></div>)}</div></section>;
}

function SessionsTable({ notify }: { notify: (message: string) => void }) {
  const rows = [
    ["실시간 교통 객체 인식", "ts250015@ts.hs.kr", "Lab Station 01", "사용 중", "6시간 42분"],
    ["YOLOv8 도로 객체 탐지", "ts250021@ts.hs.kr", "Lab Station 02", "사용 중", "2시간 18분"],
    ["LLM Fine-tuning", "ts250008@ts.hs.kr", "Lab Station 03", "사용 중", "11시간 05분"],
    ["자율주행 데이터셋", "ts250015@ts.hs.kr", "Lab Station 03", "저장됨", "27일 후 삭제"],
  ];
  return <section className={`${styles.glassPanel} ${styles.tablePanel}`}><TableHeader title="세션 관리" copy="활성 3 · 저장 2" actions /><div className={styles.dataTable}><div className={`${styles.tableHead} ${styles.sessionColumns}`}><span>프로젝트</span><span>사용자</span><span>PC</span><span>상태</span><span>남은 시간</span><span /></div>{rows.map(row=><div className={`${styles.tableRow} ${styles.sessionColumns}`} key={row[0]}><span><strong>{row[0]}</strong><small>ID · a8f2c1</small></span><span>{row[1]}</span><span>{row[2]}</span><span><span className={styles.machineStatus}>{row[3]}</span></span><span>{row[4]}</span><button className={styles.moreButton} onClick={()=>notify("세션 작업 메뉴를 열었습니다.")}><Icon name="more" /></button></div>)}</div></section>;
}

function UsersTable() {
  return <section className={`${styles.glassPanel} ${styles.tablePanel}`}><TableHeader title="사용자 관리" copy="등록 사용자 5명" actions /><div className={styles.dataTable}><div className={`${styles.tableHead} ${styles.userColumns}`}><span>사용자</span><span>권한</span><span>활성 세션</span><span>최대 허용</span><span>최근 접속</span><span /></div>{users.map((user,index)=><div className={`${styles.tableRow} ${styles.userColumns}`} key={user.email}><span className={styles.userIdentity}><span className={styles.avatar}>{String(15+index).padStart(2,"0")}</span><span><strong>{user.email}</strong><small>DSHS Google Workspace</small></span></span><span><span className={user.role === "관리자" ? styles.adminRole : styles.studentRole}>{user.role}</span></span><span><strong>{user.sessions}</strong>개</span><span><select defaultValue={user.limit}><option>1</option><option>2</option><option>3</option></select>대</span><span>{user.lastSeen}</span><button className={styles.moreButton}><Icon name="more" /></button></div>)}</div></section>;
}

function NoticeEditor({ notify }: { notify: (message: string) => void }) {
  return <div className={styles.settingsGrid}><section className={`${styles.glassPanel} ${styles.editorPanel}`}><p className={styles.eyebrow}>ANNOUNCEMENT</p><h2>학생 공지 작성</h2><p>대시보드 오른쪽 공지 카드에 표시됩니다.</p><label>공지 제목<input defaultValue="오늘 18:00 네트워크 점검" /></label><label>내용<textarea rows={6} defaultValue="약 10분간 원격 접속이 불안정할 수 있습니다. 진행 중인 작업을 미리 저장해 주세요." /></label><label className={styles.toggleLabel}><input type="checkbox" defaultChecked /><span /><div><strong>공지 표시</strong><small>모든 학생의 대시보드에 노출</small></div></label><div className={styles.editorActions}><button className={styles.secondaryButton}>미리보기</button><button className={styles.primaryButton} onClick={()=>notify("공지를 저장했습니다.")}>공지 저장</button></div></section><section className={`${styles.glassPanel} ${styles.previewPanel}`}><p className={styles.eyebrow}>LIVE PREVIEW</p><NoticeCard /></section></div>;
}

function MaintenancePanel({ notify }: { notify: (message: string) => void }) {
  return <div className={styles.maintenanceGrid}><section className={`${styles.glassPanel} ${styles.maintenanceCard}`}><span className={styles.warningOrb}><Icon name="container" /></span><h2>중단된 컨테이너</h2><p>실행이 끝났지만 아직 정리되지 않은 컨테이너입니다.</p><div className={styles.containerRow}><div><strong>session_a8f2c1_stopped</strong><small>2.4GB · 6월 27일 종료</small></div><span>저장된 세션</span><button className={styles.dangerText}>삭제</button></div><div className={styles.containerRow}><div><strong>session_f1c09a_failed</strong><small>812MB · 6월 22일 종료</small></div><span>고아 컨테이너</span><button className={styles.dangerText}>삭제</button></div><button className={styles.secondaryButton} onClick={()=>notify("정리 작업을 시작했습니다.")}><Icon name="trash" />전체 정리</button></section><section className={`${styles.glassPanel} ${styles.maintenanceCard}`}><span className={styles.kpi_blue}><Icon name="pulse" /></span><h2>서비스 상태</h2><p>프론트엔드, 중앙 허브와 노드 연결 상태입니다.</p>{[["Frontend / Next.js","정상","38ms"],["Central Hub API","정상","82ms"],["Firebase","정상","124ms"],["Node SSH Tunnel","정상","46ms"]].map(row=><div className={styles.serviceRow} key={row[0]}><span><i />{row[0]}</span><strong>{row[1]}</strong><small>{row[2]}</small></div>)}<button className={styles.secondaryButton}><Icon name="refresh" />다시 확인</button></section></div>;
}

function TableHeader({ title, copy, actions = false }: { title: string; copy: string; actions?: boolean }) {
  return <div className={styles.tableTitle}><div><p className={styles.eyebrow}>MANAGEMENT</p><h2>{title}</h2><span>{copy}</span></div>{actions&&<div><button className={styles.secondaryButton}><Icon name="search" />검색</button><button className={styles.secondaryButton}><Icon name="refresh" />새로고침</button></div>}</div>;
}

type IconName = "grid" | "archive" | "pulse" | "help" | "shield" | "chevron" | "bell" | "down" | "plus" | "layers" | "arrow" | "more" | "monitor" | "screen" | "external" | "upload" | "power" | "spark" | "check" | "server" | "warning" | "search" | "sort" | "play" | "trash" | "download" | "message" | "close" | "code" | "gauge" | "sliders" | "file" | "info" | "clock" | "database" | "refresh" | "container";

function Icon({ name }: { name: IconName }) {
  const paths = useMemo<Record<IconName, ReactNode>>(() => ({
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    archive: <><path d="M4 7.5h16v12H4z"/><path d="M3 4.5h18v3H3zM9 12h6"/></>, pulse: <path d="M3 12h4l2.2-6 4 12 2.2-6H21"/>, help: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 1 1 3.3 2.2c-.8.4-1.1.9-1.1 1.8M12 17h.01"/></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/></>, chevron: <path d="m9 18 6-6-6-6"/>, bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>, down: <path d="m6 9 6 6 6-6"/>, plus: <path d="M12 5v14M5 12h14"/>,
    layers: <><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>, arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>, more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>, screen: <><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m9 10 2 2-2 2m4 0h3"/></>, external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M5 15v5h14v-5"/></>, power: <><path d="M12 2v10"/><path d="M6.3 5.3a8 8 0 1 0 11.4 0"/></>, spark: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z"/><path d="m18 15 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></>, check: <path d="m5 12 4 4L19 6"/>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/></>, warning: <><path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.8 3h15.2a2 2 0 0 0 1.8-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, sort: <path d="M8 6h12M8 12h8M8 18h4M4 4v16m-2-3 2 3 2-3"/>, play: <path d="m8 5 11 7-11 7z"/>, trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6m4-6v6"/></>, download: <><path d="M12 4v12m-5-5 5 5 5-5"/><path d="M5 20h14"/></>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>, close: <path d="m6 6 12 12M18 6 6 18"/>, code: <path d="m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12"/>, gauge: <><path d="M4.9 19a9 9 0 1 1 14.2 0"/><path d="m12 14 4-5"/></>, sliders: <><path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></>,
    file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 13h6m-6 4h6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M18.5 16A8 8 0 1 1 20 12"/></>, container: <><path d="M3 7h18v13H3zM7 7V4h10v3M8 11v5m4-5v5m4-5v5"/></>,
  }), []);
  return <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
