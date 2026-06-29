# DSHS Compute Design Lab

로그인 이후 화면을 재설계하기 위한 독립 UI 프로토타입입니다. 실제 API, 인증,
세션 데이터는 사용하지 않으며 기존 `/dashboard`, `/admin` 코드를 수정하지 않습니다.

## 실행

```powershell
cd frontend
npm run dev
```

브라우저에서 `/design-lab`을 엽니다. 예: `http://localhost:3000/design-lab`

- 시안 01 — Prismatic Glass: `/design-lab`
- 시안 02 — 작업 원장: `/design-lab/ledger`
- 시안 03 — White Liquid: `/design-lab/white-glass`
- 시안 04 — White Atelier: `/design-lab/ivory`

시안 02는 영문 아이브로우, 장식 그래프와 전면 카드화를 배제하고 학교 전산실의
배정표와 작업 원장을 시각적 기준으로 사용합니다. 단일 코발트 블루, 사선 속도선,
대형 한글 타이포그래피가 핵심 표현입니다.

시안 03은 시안 02의 컬러 배경을 유지하되 모든 카드와 버튼의 안료를 무채색
White Liquid Glass로 바꿉니다. 시안 04는 아이보리 화이트 배경과 백색 유리,
검정 타이포그래피를 사용하며 워드마크와 날짜에만 필기체를 제한적으로 섞습니다.

## 직접 열기

- `/design-lab?view=dashboard&state=ready`
- `/design-lab?view=dashboard&state=idle`
- `/design-lab?view=dashboard&state=starting`
- `/design-lab?view=dashboard&state=queued`
- `/design-lab?view=dashboard&state=error`
- `/design-lab?view=saved`
- `/design-lab?view=activity`
- `/design-lab?view=guide`
- `/design-lab?view=admin`

관리자 화면 안에서는 `현황`, `PC`, `세션`, `사용자`, `공지`, `유지보수` 탭을
전환할 수 있습니다. 학생 대시보드에서는 새 작업 신청, 파일 전송, 세션 종료
프로토타입을 열 수 있습니다.

## 파일 구성

- `PrototypeApp.tsx`: 화면과 프로토타입 인터랙션
- `design-lab.module.css`: Prismatic Liquid Glass 디자인 시스템
- `fixtures.ts`: 화면에 사용하는 고정 샘플 데이터

확정된 디자인을 운영 화면에 반영할 때는 이 파일의 API 없는 화면 구조를 통째로
복사하지 말고, 디자인 토큰과 재사용 컴포넌트를 기존 상태 로직에 단계적으로
이식합니다.
