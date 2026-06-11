# aindrive UX 전면 개편 — design

제품 정체성: **구글 공유드라이브 + 드라이브 내 유료 컨텐츠 + AI 에이전트/협업**.
4-에이전트 설계팀 수렴 결과. 원칙: 기능을 *편안·직관·깔끔·예쁜* UI로. 과거 코드에
얽매이지 않음.

## 확정 네비게이션: 맥락우선 (구글드라이브형)

파일이 주인공. 공유·판매는 **항목(파일/폴더)에서 우측 드로우**로 생성. 드라이브
전체 감사/설정은 **별도 페이지(원장)**. 핵심 IA 규칙: *생성은 맥락에서, 원장은
설정에서* — 같은 개념이 두 surface에 쪼개져 "어디서 만들지?"가 되는 현재 버그를
구조로 제거.

## A. 파일 셸 크롬

- **레이아웃**: 좌 사이드바(256) + 상단바 + 콘텐츠 + (우측 도킹 슬롯: Viewer /
  Share 드로우 / Folder-chat 상호배타).
- **상단바 3존**: 좌=브레드크럼 / 중=검색(아이콘→확장)·뷰토글 / 우=**아바타 메뉴**
  (신규: 이메일 + Sign out, `web/app/page.tsx`의 logout 이전).
- **+ New**(folder/upload) = 유일 1차 액션(사이드바). Upload 중복 제거(드래그드롭 유지).
- **선택 툴바**(신규): 항목 선택 시 브레드크럼 행 우측을 대체 — `N selected · Open
  Download Share Sell Rename Delete`. 행 `⋮`·우클릭·툴바 모두 `rowMenuItems` 단일
  소스 소비(드리프트 방지). `rowMenuItems`에 **Open·Download 추가**.
- **사이드바 푸터**(owner): `⊕ Create agent` · `⚙ Settings`(→ /manage) · `Role`.
  멤버는 Role만.
- **Folder-chat**: 헤더 버튼 제거 → 우측 레일 토글(Viewer/드로우와 같은 슬롯 도킹).
- **모바일**: 사이드바 off-canvas, 선택 툴바→하단 바, 드로우→풀스크린 시트, 길게눌러=우클릭.

## B. Share 드로우 (맥락 생성 surface) — `ShareDialog` 대체

우측 패널(~420), 경로 P에 대해. 세그먼트 `People | Link`. 기존 모달 대체.
**여기가 유일한 생성처.** 토큰 정책·정산지갑·매출은 읽기만(편집은 Settings).

- **People**(기본): 상단 "Invite to this item"(이메일+역할+초대, pending 지원, 역할
  1줄 설명). 아래 "WHO CAN ACCESS · P": **Direct**(P에 직접 grant — 역할 select+제거,
  본인 제외) / **Inherited**(조상 grant — 읽기전용 + "manage at /ancestor" 툴팁).
  타 폴더 멤버 숨김.
- **Link**: `Free | Paid` 내부 토글(progressive disclosure).
  - Free: 역할 + "Create free link"(생성+클립보드 복사).
  - Paid: 가격 + "Pay with"(드라이브 토큰 메뉴 Select) + (owner) "List on storefront"
    체크 + "Create paid link". **혼란 제거 문구**: "Buyer pays this in ONE token. The
    menu lists the currencies you accept — the buyer picks one, not all." + 읽기전용
    "Accepted in this drive: …" 칩 + "Manage tokens in Settings ⚙".
  - 하단: **이 경로의 링크 목록**(복사·revoke).
- **엣지**: 정산지갑 미설정 → Paid 폼이 경고카드로 대체(owner: Open Settings→ /
  비owner: 안내). 비owner editor → Paid 세그먼트 숨김(공유는 가능, 판매 불가). 서버가
  진실원천(listed/paid 재검증).

## C. 드라이브 Settings (원장/감사) — `/d/[id]/manage` 재작성

**단일 페이지 + 좌측 앵커 레일**(서브페이지 아님 — 데이터가 작고 한 번에 fetch,
교차참조가 잦은 감사 surface). 모바일은 기존 가로 탭. 섹션 5개:

- **Members**(`Users`): 사람 단위 그룹 + grant 칩(경로 링크·역할 select·제거).
  creator/본인 잠금(👑 배지, 강등·제거 불가). pending invites 별도 블록(취소). 검색.
  사람별 `⋯`(Remove from all). **InviteCard 제거**(생성은 드로우) → "↗ Share에서
  생성, 여기선 관리" 역참조 문구.
- **Links**(`Link2`): 전체 링크 테이블(경로·역할·Free/가격·Listed·만료·복사·revoke).
  필터(All/Free/Paid/Listed/Expired). 생성 버튼 없음(역참조 문구만).
- **Sales**(`TrendingUp`): 매출 원장(총액+영수증+tx) **+ "On the storefront"**
  (listed shares 카탈로그). Links와 분리 — Links="어떤 문이 있나", Sales="얼마 벌었고
  뭘 팔고 있나". 같은 listed 데이터를 Links에선 가시성 속성, Sales에선 상점 카탈로그로.
- **Payments**(`Wallet`, creator 전용): 정산지갑 + 토큰 정책 에디터(아래 D). co-owner
  엔 잠금 EmptyState(기존 `settingsReadable` 게이트).
- **General**(`Settings`): 드라이브 이름, Agents(연결 상태+Create agent 모달), Danger
  zone(드라이브 삭제, creator 전용, 이름 입력 확인).

## D. 토큰 정책 명확화 (Payments 내부)

**모든 토큰 행에 동일한 Toggle**(ON/OFF). 프리셋·커스텀 차이는 "accepted?" 축에서
제거 — 커스텀만 line2 주소(provenance) + line3 🗑(삭제, 토글과 분리). OFF 행은 dim
유지(사라지지 않음).

- 카드 문구: "Accepted payment currencies — Pick the currencies you're allowed to
  price sales in. You set one currency on each sale; buyers pay only that one.
  Turning on more here just gives you more options."
- settle 배지 → line3 quiet `Badge(neutral)`("⚡ Instant settle" / "· one-time
  approval" 툴팁). 파란 accent 제거(동시청구 오해 차단).
- 저장 의미: accepted = *판매 가격 책정 시 고를 수 있는 메뉴*. 이미 책정된 share는
  불변(비소급). `accepted >= 1` 불변식(0이면 저장 불가 경고).
- Add custom: 인라인 패널(네트워크+CA+Look up → 메타+settle 표시 → "Add & accept",
  ON으로 추가). 미정산성 토큰 차단.

## 불변식 (깨면 안 됨)

- 서버 권한/결제/스트리밍 로직 의미 불변(이번은 표현층 + 신규 라우트 0). 기존 e2e
  green. creator 보호·upgrade-only·경로 스코프 유지.
- 결제 흐름(402/x402 v2/permit2)·미디어 스트리밍·업로드 무변경.
- 토큰 정책 저장 포맷(`allowed_tokens` JSON = PaymentToken[]) 무변경 — accepted=배열
  포함, OFF=배열 제외(현행과 동일, UI만 토글로).

## 구현 우선순위 (라이브 반영)

1. ✅ **토큰 정책 토글화 + 문구** — PR #13.
2. ✅ **Settings 재작성**(Members·Links·Sales·Payments 좌측 레일) — PR #13.
3. ✅ **Share 드로우**(모달→우측 드로우, Earnings는 Settings로) — PR #14.
4. **파일 크롬** — ⏳ 부분: 상단바 정리(Agent·Manage → 사이드바 푸터). 잔여:
   선택 툴바(선택 시 Open/Download/Share/Sell/Rename/Delete), +New 단일화,
   아바타/계정 메뉴(sign-out), folder-chat 우측 레일화.

각 단계 typecheck/build/e2e green 유지, 증분 커밋. 권한 회귀는 적대 리뷰로 닫음.

## 범위 밖 (후속)

멤버별 활동/구매 드릴다운, 대량 초대, 멤버 태그, 초대 이메일 발송, 구매자 "내 구매"
페이지, 폴더 zip 다운로드, Studio 분리(하이브리드).
