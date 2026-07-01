"use client";

import s from "../atelier.module.css";
import { HelpTip } from "../ui";

const STEPS: [string, string, string][] = [
  ["01", "PC 신청", "작업 이름과 필요한 최소 사양(CPU·메모리·저장공간)을 입력하고 사용할 장비를 선택합니다."],
  ["02", "원격 접속", "배정이 끝나면 ‘데스크톱 열기’를 눌러 브라우저에서 Ubuntu 환경에 접속합니다. 첫 로딩은 1~2분 걸릴 수 있습니다."],
  ["03", "파일 전송", "‘파일 보내기’로 내 컴퓨터의 파일을 실행 중인 PC의 바탕화면/받은파일 폴더로 전송합니다."],
  ["04", "종료와 보관", "작업 종료 시 설치 환경과 파일이 보관함에 30일간 저장되어 다음에 이어서 사용할 수 있습니다."],
];

const TIPS: string[] = [
  "종료 5분 전 알림이 표시됩니다. 알림이 오면 작업을 꼭 저장하세요.",
  "학교망에서 접속이 안 되면 VPN을 켜고 다시 시도하세요.",
  "팀원도 같은 @ts.hs.kr 계정만 추가할 수 있습니다.",
  "‘파일 완전히 제거’는 모든 파일·패키지를 영구 삭제하며 되돌릴 수 없습니다.",
];

const RULES: [string, string, string][] = [
  ["01", "계정과 세션", "본인 계정으로만 사용하고, 함께 작업하는 사람은 팀원으로 등록하세요. 계정과 접속 주소를 다른 사람에게 공유하면 안 됩니다."],
  ["02", "허용된 용도", "수업·연구·프로젝트 목적으로 사용하세요. 채굴, 악성 프로그램 실행, 외부 시스템 공격이나 우회 접속은 금지됩니다."],
  ["03", "자료 관리", "중요한 결과물은 개인 저장소에도 따로 백업하세요. ‘파일 완전히 제거’로 삭제한 세션과 파일은 복구할 수 없습니다."],
  ["04", "보안 확인", "운영 안전을 위해 위험 확장자 파일이 감지되면 파일 정보와 당시 화면이 관리자 보안 경고에 기록될 수 있습니다."],
];

const INPUT_GUIDE: [string, string, string][] = [
  ["01", "화면 먼저 클릭", "원격 데스크톱 안쪽을 한 번 클릭해 키보드 입력이 브라우저가 아닌 원격 PC로 전달되게 합니다."],
  ["02", "Shift + Space", "Shift 키를 누른 상태에서 Space를 눌러 한글과 영어를 전환합니다. 브라우저 원격 접속에서는 키보드의 한/영 키보다 이 조합이 안정적입니다."],
  ["03", "전환이 안 될 때", "화면 상단의 키보드·IBus 아이콘에서 ‘Korean - Hangul’을 선택한 뒤 Shift + Space를 다시 누르세요. 아이콘이 없으면 데스크톱을 새로고침합니다."],
  ["04", "입력 상태 확인", "메모장이나 터미널에 짧게 입력해 현재 언어를 확인하세요. 키 조합이 브라우저에 동작했다면 원격 화면 안쪽을 다시 클릭하고 전환합니다."],
];

export default function GuidePage() {
  return (
    <div className={s.enter}>
      <div className={s.pageTitle}>
        <div className={s.titleLine}>
          <h1>이용 안내</h1>
          <HelpTip text="GPU 전산실의 기본 사용 절차입니다." />
        </div>
      </div>

      <section className={s.guideSheet}>
        {STEPS.map((row) => (
          <article key={row[0]}>
            <span>{row[0]}</span>
            <h2>{row[1]}</h2>
            <p>{row[2]}</p>
          </article>
        ))}
      </section>

      <div className={s.contactLine}>
        <div className={s.titleLine}>
          <strong>사용 규칙</strong>
          <HelpTip text="모두가 안전하게 장비를 사용하기 위한 기본 규칙입니다." />
        </div>
      </div>
      <section className={s.guideSheet} style={{ marginTop: "14px" }}>
        {RULES.map((row) => (
          <article key={row[0]}>
            <span>RULE {row[0]}</span>
            <h2>{row[1]}</h2>
            <p>{row[2]}</p>
          </article>
        ))}
      </section>

      <div className={s.contactLine}>
        <div className={s.titleLine}>
          <strong>한/영 전환</strong>
          <HelpTip text="원격 데스크톱에서는 Shift + Space를 사용합니다." />
        </div>
      </div>
      <section className={s.guideSheet} style={{ marginTop: "14px" }}>
        {INPUT_GUIDE.map((row) => (
          <article key={row[0]}>
            <span>KEY {row[0]}</span>
            <h2>{row[1]}</h2>
            <p>{row[2]}</p>
          </article>
        ))}
      </section>

      <div className={s.contactLine}>
        <div className={s.titleLine}>
          <strong>알아두면 좋아요</strong>
        </div>
      </div>
      <section className={s.guideSheet} style={{ marginTop: "14px" }}>
        {TIPS.map((t, i) => (
          <article key={i}>
            <span>TIP</span>
            <p style={{ marginTop: "12px" }}>{t}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
