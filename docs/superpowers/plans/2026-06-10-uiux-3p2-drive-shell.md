# UIUX 3'-2 Drive Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 드라이브 워크스페이스(가장 많이 보는 화면)를 구글드라이브급으로 — 그리드/리스트 토글, 풍부한 파일타입 아이콘, 빈 상태·로딩 스켈레톤, 드래그드롭 업로드, 컨텍스트 메뉴(우클릭), 진열 카드 그리드. 3'-1 프리미티브를 소비.

**Architecture:** `drive-shell-parts.tsx`의 `FileTable`/`ShowcaseSection`/`DriveSidebar`/`DriveHeader`를 재설계(표현만). 상태는 `drive-shell.tsx`에 그대로(view mode·drag state만 추가). 권한/API/네비게이션 로직(setPath, onUpload, onRowAction, 합성 root, paidByPath) **불변**. 새 프리미티브(Card/Menu/EmptyState/Skeleton/Badge) 사용.

**Tech Stack:** Next.js 15 client components, Tailwind v3 + 3'-1 토큰, lucide-react, 3'-1 ui/* 프리미티브, playwright.

**제약:** 서버/권한/결제 무변경 → 162 e2e 회귀 그물. e2e는 HTTP-only(셀렉터 무관)라 표현 변경에 안전(이미 확인). 드래그드롭·뷰토글은 신규 클라 상태.

---

## File Structure
- `web/components/drive-shell-parts.tsx` — FileTable(리스트+그리드)·ShowcaseSection(카드)·EntryIcon(확장)·DriveSidebar·DriveHeader 재설계
- `web/components/drive-shell.tsx` — `viewMode` state(localStorage), drag-over state, 컨텍스트 메뉴 위치 state. load/handler 불변.
- `web/components/file-icons.tsx` (신규) — 파일타입→아이콘+색 매핑 단일 소스
- 프리미티브 소비: `@/components/ui` (Card, Menu, EmptyState, Skeleton, Badge, IconButton)

---

## Task 1: 파일타입 아이콘 체계

**Files:** `web/components/file-icons.tsx` (신규)

- [ ] **Step 1:** `fileIcon(entry: {name, isDir, mime}): { Icon, className }` — 폴더/이미지/PDF/코드(ts·js·py·rs·go·json·html·css·sh)/문서(md·txt·doc)/시트(csv·xlsx)/슬라이드(ppt)/압축/오디오/비디오/기본. lucide 아이콘 + Drive-스러운 타입별 색(폴더 accent, 이미지 보라, 코드 청록, 시트 녹색, 문서 파랑, PDF 빨강 등 — drive 톤 안에서). `FileBadge`(잠금/진열용)도. 현 `EntryIcon`(parts:331) 로직 흡수·확장.
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): file-type icon system`.

## Task 2: FileTable 리스트 뷰 다듬기 + 빈상태/스켈레톤

**Files:** `web/components/drive-shell-parts.tsx`

- [ ] **Step 1:** FileTable 리스트 모드 재설계: 행 높이/패딩 일관(`h-11`), hover/selected 시각(rounded row, `bg-drive-hover`/`bg-drive-selected/60`), 아이콘은 `fileIcon`, 가격은 `Badge tone=sale`. **로딩 → Skeleton 행 6개**(현 "connecting…" 스피너 대체), **빈 → EmptyState**(폴더 아이콘 + "This folder is empty" + canEdit이면 "Upload" 액션), **err → EmptyState(경고 톤)**. 컬럼 정렬(이름 클릭 정렬은 3'-3로 미룸 — 지금은 시각만). 모바일 반응형 유지(Modified/Size 숨김).
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): polished list view + skeleton/empty states`.

## Task 3: 그리드 뷰 + 뷰 토글

**Files:** `web/components/drive-shell-parts.tsx`, `web/components/drive-shell.tsx`, `web/components/file-icons.tsx`

- [ ] **Step 1:** `drive-shell.tsx`에 `viewMode: "list"|"grid"` state, 초기값 `localStorage.getItem("aindrive:view") ?? "list"`(SSR 안전: useEffect로 hydrate), set 시 localStorage 저장. DriveHeader에 **뷰 토글 IconButton 2개**(List/LayoutGrid 아이콘, active 강조).
- [ ] **Step 2:** FileTable이 `viewMode` prop 받아 grid 모드: `Card` 그리드(`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3`), 각 카드 = 큰 파일타입 아이콘(이미지는 썸네일 — `fs/download` data-url 지연로드는 3'-3로 미룸, 지금은 타입 아이콘) + 이름(2줄 truncate) + 가격 배지 + 우상단 ⋮ Menu. 클릭=기존 setPath/setSelected. 빈/로딩/err는 리스트와 공유(grid skeleton 카드).
- [ ] **Step 3:** typecheck 0. 커밋 `feat(ui): grid view + persistent view toggle`.

## Task 4: 컨텍스트 메뉴 (우클릭) + RowMenu 통일

**Files:** `web/components/drive-shell-parts.tsx`, `web/components/drive-shell.tsx`, `web/components/row-menu.tsx`

- [ ] **Step 1:** 행/카드에 `onContextMenu`(preventDefault) → 위치 기반 Menu 표시. `drive-shell.tsx`에 `ctxMenu: {entry, x, y}|null` state. 메뉴 항목 = 기존 RowMenu 액션(sell/share/rename/delete, canSell=isOwner·canManage=canEdit 게이트 동일). ⋮ 버튼도 같은 항목(RowMenu를 `Menu` 프리미티브로 재구현하거나 래핑 — 동작·게이트 보존). 빈 영역 우클릭 → "New folder/Upload"(canEdit).
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): right-click context menu, unified row actions on Menu primitive`.

## Task 5: 드래그드롭 업로드

**Files:** `web/components/drive-shell.tsx`, `web/components/drive-shell-parts.tsx`

- [ ] **Step 1:** 파일 영역에 `onDragOver`/`onDragLeave`/`onDrop`(canEdit만). drag 중 **오버레이**(`absolute inset-0 bg-drive-accent/5 border-2 border-dashed border-drive-accent rounded-xl` + "Drop files to upload" + Upload 아이콘). drop → 기존 `onUpload(files)` 그대로 호출(핸들러 불변). 비-canEdit이면 오버레이 없음. window drag 누수 방지(counter 패턴).
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): drag-and-drop upload with drop overlay`.

## Task 6: 진열 카드 그리드 (ShowcaseSection 격상)

**Files:** `web/components/drive-shell-parts.tsx`

- [ ] **Step 1:** ShowcaseSection을 리스트→**카드 그리드**: 섹션 제목 "For sale"(아이콘+label 토큰), 각 진열 = `Card`(clickable) — 🔒 잠금 + 큰 타입 아이콘(leaf 확장자 추정) + `leafName`(truncate) + 가격 배지(`Badge tone=sale`, `{price} {currency}`) + "Buy" 힌트. 클릭=기존 redirect 라우트(`/api/drives/${driveId}/showcase/${shareId}`) 불변. **leaf만 표시**(보안 D1 — 전체 path 금지) 유지. 빈=null.
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): showcase as card grid`.

## Task 7: 사이드바·헤더 다듬기

**Files:** `web/components/drive-shell-parts.tsx`

- [ ] **Step 1:** DriveSidebar: "New folder" 버튼 → `Menu`("New": 폴더/업로드)로 격상(Drive의 New 버튼 패턴), 드라이브 nav 행 시각 일관(active selected, online 점 Tooltip), Role 배지. DriveHeader: breadcrumb 시각(chevron·hover·현 위치 강조 — 합성/grant crumb 로직 불변), 툴바 버튼을 `Button`/`IconButton` 프리미티브로, 뷰 토글 배치. 검색 입력은 3'-3로(여기선 자리만 비워두지 않음 — 범위 외).
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): polished sidebar (New menu) + header toolbar`.

## Task 8: 실브라우저 회귀 + 머지

- [x] dev 시드(owner+drive+여러 파일타입+폴더+멤버+진열). playwright:
  ① 리스트/그리드 토글 동작·localStorage 지속, ② 파일타입 아이콘 구분, ③ 빈 폴더 EmptyState, ④ 우클릭 컨텍스트 메뉴(owner sell 보임/editor 안 보임), ⑤ 드래그드롭 오버레이(드롭 시뮬은 어려우면 오버레이 표시까지), ⑥ 진열 카드 그리드 + 클릭→결제, ⑦ **합성 root(1b)·진열 권한(2a) 회귀 없음**(부분멤버로 재확인), ⑧ Modified 0 "—".
  → 9/9 통과(부분멤버 진열 leaf-only DTO 확인) + 그리드 상호작용 4/4(클릭·키보드·⋮·button중첩없음).
- [x] 풀 e2e 162/1 재확인(GREEN). 최종 리뷰(에이전트팀) — 그리드 카드 nested-button a11y 1건 발견·수정(66b2b94).
- [ ] **main 머지: 최종 통합 시점으로 보류.** main은 기본 워크트리에 잠겨 있고 환경 격리상 그곳을 건드리지 않음. 3'-3/3'-4까지 `feat/uiux-overhaul`에 쌓아 한 번에 `--no-ff` 통합(또는 사용자 머지).

## Self-Review
- 표현만 변경, 상태/핸들러/API/권한 불변 → 162 e2e + 1b/2a 실브라우저가 회귀 그물.
- 프리미티브 소비(Card/Menu/EmptyState/Skeleton/Badge/IconButton) — 3'-1 일관성 실현.
- 보안 불변식: 진열 leaf-only(전체 path 금지) 카드에서도 유지, RowMenu sell=owner·manage=editor 게이트 보존, 드래그드롭 canEdit 게이트.
- 접근성: 컨텍스트 메뉴/뷰토글 키보드(Menu 프리미티브 내장), 드롭 영역 aria.
- 이미지 썸네일·이름정렬·검색은 의도적으로 3'-3로 미룸(YAGNI 분할).
