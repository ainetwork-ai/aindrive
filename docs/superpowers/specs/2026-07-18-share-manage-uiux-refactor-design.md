# Share 드로어 · Manage 페이지 UI/UX 정리 + ⋮ 메뉴 버블링 버그 수정 (2026-07-18)

## 문제

1. **⋮ 메뉴 항목 클릭이 행 클릭까지 실행** — `ui/Menu.tsx` 팝오버는 포털 없이
   행 내부에 렌더되는데, 트리거(⋮)만 `stopPropagation()` 하고 항목 버튼은 하지
   않는다. "Share…" 클릭이 `<tr>`/`<Card>`의 navigate 핸들러로 버블링 →
   드로어가 열리면서 폴더 진입/뷰어 열림이 동시에 일어난다.
2. **Share 드로어가 난잡** — 448px 드로어에 아이콘 배지 `SectionCard` 5장
   (Manage 배너 / Sell / Members / Invite / Free link)이 쌓이고, Sell 카드 안에
   또 테두리 박스 3개(링크 복사 / 판매 조건 / 수락 통화 칩)가 중첩. 좁은
   패널에서 카드-안-카드는 시각 소음이다.
3. **Manage Members 탭 카드 과다** — 초대 / 대기 초대 / 명단이 카드 3장.
4. **숨은 상태 결합** — 무료 링크 생성이 초대 role select의 상태를 몰래 공유
   (초대 role을 editor로 바꾸면 다음 무료 링크도 editor로 생성됨).

## 결정

표현 계층만 변경한다. 서버 권한/결제 시맨틱, API 호출, "create in context,
audit in settings" IA(`CLAUDE.md`)는 불변.

### 1. Menu 팝오버에서 클릭 전파 차단

항목마다가 아니라 **팝오버 컨테이너 한 곳**에서 `onClick` 전파를 끊는다 —
현재 4개 항목과 향후 추가 항목, 비활성 항목/여백 클릭까지 일괄 커버.
(포털화는 정렬 로직 재작성이 필요한 더 큰 변경이라 채택하지 않음.)

### 2. 드로어 = 플랫 시트, 카드는 넓은 페이지 전용

- 드로어 본문을 `divide-y` 구분선의 플랫 섹션(`DrawerSection`, 드로어 로컬
  컴포넌트)으로 재구성. 섹션 순서는 멘탈 모델 순서로: **People(초대+멤버) →
  Link sharing(무료 링크) → Sell**.
- 상단 "Members, links & settings" 배너 → 하단의 조용한 링크 행으로 이동
  (열자마자 다른 페이지로 보내는 배너가 첫 시선을 받는 우선순위 오류 제거).
- Sell 내부 중첩 박스 해체: 판매 조건 박스·통화 칩 박스 제거, 살아있는 링크
  행 하나만 배경으로 강조. 수락 통화는 한 줄 캡션 + Settings 링크.
- 멤버 행에 `Avatar` 추가, role 변경은 Manage와 같은 투명 인라인 select.
- 무료 링크에 **전용 role select** 추가 — 초대 role과의 숨은 결합 제거.
- `focusSection === "sell"` 은 하이라이트 링 대신 자동 스크롤 + 폼 오픈.

### 3. SectionCard 헤더 경량화 (앱 전역)

8×8 파란 아이콘 배지 박스 → 인라인 뮤트 아이콘. API 불변이므로 사용처
(drive-manage, create-agent-modal)는 코드 수정 없이 가벼워진다.

### 4. Manage Members 탭 카드 3장 → 1장

초대 폼(행)과 대기 초대(하위 목록)를 "Members" 카드 안으로 흡수. 검색은 카드
action 슬롯 유지.

## 검증

`npm run typecheck` + `npm run test` + `npm run build` (web/). 수동 시나리오:
목록/그리드에서 ⋮ → Share… 클릭 시 드로어만 열리고 경로가 바뀌지 않아야 한다.
