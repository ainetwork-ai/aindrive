# UIUX Overhaul (Phase 3') — Design

설계일 2026-06-10. aindrive를 "기능은 있으나 거친" 상태에서 **구글드라이브급 경험**으로 끌어올린다. 자율 진행(사용자 위임) — 사용자-승인 게이트 대신 ultracode 디자인 비평으로 검증.

## 진단 (현 상태)

- **색 토큰은 이미 Google Drive 팔레트** (`tailwind.config.ts`): accent `#0b57d0`, selected `#c2e7ff`, sidebar `#f0f4f9`, Google Sans, Drive 그림자. 방향성은 옳다.
- **그러나 재사용 프리미티브가 0개**: Button/Modal/Input/Select/Menu가 컴포넌트마다 ad-hoc. 모달은 각자 `<div className="fixed inset-0 z-50 bg-black/30 ...">`(create-agent-modal:126, share-dialog:240). `Row`·`Toggle`이 share-dialog-sections와 share-gate에 중복 정의. spacing/radii/type 스케일 토큰 없음.
- **목록은 평범한 `<table>`** (drive-shell-parts FileTable): 그리드 뷰 없음, 파일타입 아이콘 빈약, 빈 상태/로딩 스켈레톤/드래그드롭 업로드 없음.
- **에디터는 Monaco 단일** + 인라인 분기 (viewer.tsx:54-56 `isText/isImage/isPdf`, :283-290). 문서타입별 편집기 확장 seam 없음.

→ "기능만 있는" 정체 = **디자인 시스템 부재**. 색은 Drive인데 그 위 컴포넌트가 제각각이라 장인정신이 안 느껴진다.

## 비전 / 원칙

1. **Google Drive의 친숙함** — 익숙한 레이아웃(상단 앱바+검색, 좌측 사이드바, 목록/그리드 토글, 컨텍스트 메뉴, 슬라이드인 디테일 패널)을 차용하되 aindrive 고유 기능(진열·결제·에이전트·협업)을 자연스럽게 녹인다.
2. **시스템 우선** — 화면을 한 땀씩 칠하지 않는다. 토큰 스케일 + 프리미티브를 먼저 세우고 모든 화면이 그 위에 선다(일관성=장인정신).
3. **불변식 보존** — 권한 모델(drive_members)·진열 leaf-DTO·결제 정책·합성 root·162 e2e는 **UI 개편으로 절대 깨지지 않는다**. 이 작업은 표현층만 바꾼다(서버 라우트·권한 로직 무변경; 컴포넌트가 부르는 API 계약 유지).
4. **self-host 제약** — 모든 에디터/폰트/아이콘은 same-origin(CSP `script-src 'self'`). Monaco self-host 교훈 준수. 신규 에디터도 CDN 금지.
5. **협업 재사용** — Yjs/y-monaco가 이미 있다. 리치텍스트 에디터는 같은 Yjs 문서에 y-prosemirror로 얹어 협업을 공짜로 잇는다.

## 디자인 언어 (토큰 확장)

기존 색 위에 스케일을 추가(`tailwind.config.ts` + `app/globals.css`):
- **타이포** (Google Sans): `display`(28/600), `title`(20/600), `subtitle`(16/500), `body`(14/400), `caption`(12/400), `label`(11/500 uppercase). line-height 동반.
- **spacing**: 4px 베이스(Tailwind 기본 유지, 컴포넌트가 일관 사용 — 1/2/3/4/6/8).
- **radii**: `sm 6` `md 8` `lg 12` `xl 16` `full`. Drive는 카드 12, pill 버튼 full.
- **elevation**: `e1`(기존 drive 그림자 약화) `e2`(hover) `e3`(모달/팝오버). focus ring `accent/40`.
- **motion**: `transition 150ms ease`, 모달/패널 enter/leave(fade+slide 8px).

## 프리미티브 (web/components/ui/, 신규)

각 파일 1책임, 기존 ad-hoc을 흡수:
- `Button.tsx` — variants `filled|tonal|text|outline|danger`, sizes `sm|md`, `IconButton`, loading 상태. (홈/툴바/모달 버튼 통일)
- `Modal.tsx` — 셸: backdrop, 중앙/시트 배치, 헤더(title+close)·body(scroll)·footer, **focus trap·Esc·scroll-lock·a11y(role=dialog, aria-labelledby)**. (create-agent-modal·share-dialog 흡수)
- `Input.tsx` / `Select.tsx` — 라벨·에러·helper text 슬롯.
- `Menu.tsx` — 드롭다운/컨텍스트(키보드 nav, 바깥클릭 닫기, 위치 자동). RowMenu·우클릭 메뉴 통일.
- `Tooltip.tsx`, `Skeleton.tsx`, `EmptyState.tsx`(아이콘+제목+설명+액션), `Card.tsx`, `Badge.tsx`(X402Badge 일반화), `Toggle.tsx`(중복 흡수), `Avatar.tsx`(협업 presence), `Tabs.tsx`(에디터 타입 전환용).
- `index.ts` 배럴.

## 하위페이즈 분해 (각 자체 plan→구현→실브라우저→머지)

### 3'-1 — 디자인 시스템 기반 (선행 필수)
토큰 스케일 + 위 프리미티브 전부 + 기존 ad-hoc(Row/Toggle/모달 div/버튼) 치환. **시각 회귀 위험이 크므로**: 프리미티브는 신규 추가, 치환은 화면별로 점진(이 페이즈는 프리미티브 구축 + 모달 2종·버튼 치환까지). Storybook은 도입 안 함(YAGNI) — 대신 `app/_dev/ui/page.tsx`(dev-only) 프리미티브 갤러리로 실브라우저 확인.

### 3'-2 — 드라이브 셸 (최대 레버리지)
- 상단 **앱바**: 로고 + 드라이브 검색(파일명 필터, 클라이언트) + 계정 메뉴(Avatar).
- **사이드바** 정리: My drives, 드라이브별 online 점, "New" 메뉴(폴더/업로드).
- **목록/그리드 토글**: 리스트(현 테이블 개선) + 그리드(파일타입 아이콘·썸네일 카드). 뷰 선호 localStorage.
- **파일타입 아이콘** 체계(폴더/문서/시트/이미지/PDF/코드/잠금-진열).
- **빈 상태·로딩 스켈레톤·드래그드롭 업로드 오버레이**.
- **컨텍스트 메뉴**(우클릭 + ⋮) Menu 프리미티브로.
- breadcrumb 다듬기(현 합성/grant 로직 유지, 시각만).
- For-sale 진열을 **카드 그리드**로 격상(leaf+가격+잠금, 클릭→결제).

### 3'-3 — 모달·결제·진열 디테일
- share-dialog "폼 덤프"(551줄) → Modal 셸 + 섹션 카드(멤버/초대/판매/정책)로 재구성, 시각 위계.
- paywall(share-gate) → **상품 카드**(아이템 타입·가격·통화·"무엇을 사는지"·결제 버튼 위계).
- create-agent-modal, folder-chat 패널 정리.

### 3'-4 — 에디터 프레임워크 + 리치텍스트
- Viewer의 인라인 분기를 **에디터 레지스트리**로: `mime/ext → EditorComponent`. `viewer.tsx`는 디스패처, 각 에디터는 독립 파일.
- 기본 제공: **코드/텍스트(Monaco, 현행 유지)**, **이미지 뷰어**(줌/핏 개선), **PDF 뷰어**(개선), **리치텍스트**(신규: TipTap/ProseMirror, self-host, `.md`를 위지윅으로; Yjs 협업은 y-prosemirror로 동일 문서에).
- **시트/슬라이드는 이 페이즈 비목표**(레지스트리에 "지원 예정" placeholder만 — 거대 기능, 별도 트랙). editor-roadmap memory의 방향과 일치.
- 자동저장·협업·디스크 왕복은 기존 Viewer 메커니즘 재사용(에디터만 교체).

## 불변식 / 제약 (절대)

- 서버 라우트·권한 로직·DB **무변경**. 컴포넌트가 호출하는 API 계약 유지 → 162 e2e 그대로 GREEN(표현층 개편이라 e2e는 회귀 그물).
- 권한·진열·결제 UI 규칙 보존: 잠긴 path 내용/전체 path 비노출(leaf만), listed owner-only, 합성 root role 리셋·canEdit 게이트.
- self-host(CSP) — 폰트(Google Sans 이미 사용 — self-host 확인), 아이콘(lucide-react 번들, OK), 에디터(Monaco self-host 유지, ProseMirror 번들).
- 번들 크기: 리치텍스트 추가 시 dynamic import(현 Viewer가 이미 dynamic — 동일).

## 테스트 / 검증

- **e2e 162/1**: 표현층 개편이라 셀렉터 변경이 일부 케이스를 깰 수 있다 → 각 하위페이즈 후 풀 e2e 재실행, 깨지면 셀렉터/구조 보정(단언 의미 불변).
- **실브라우저**(playwright): 각 하위페이즈의 핵심 화면을 시드+캡처로 전후 확인 — Monaco 무한로딩 교훈(렌더는 HTTP e2e로 안 잡힘).
- **시각 회귀**: dev UI 갤러리(3'-1)로 프리미티브 확인.
- 권한 회귀: 기존 #165~#175가 UI 경로의 권한을 간접 보증; 추가로 합성 root·진열 실브라우저 재확인.

## 영향 범위 (개괄)

신규: `web/components/ui/*`, `web/components/editors/*`(3'-4), 토큰(tailwind.config·globals.css). 개편: 모든 `web/components/*.tsx` 표현, `web/app/{page,login,signup}/*`. 무변경: `web/app/api/*`, `web/lib/*`(권한/결제/쇼케이스 로직), `web/scenarios/*`(셀렉터 보정 외).
