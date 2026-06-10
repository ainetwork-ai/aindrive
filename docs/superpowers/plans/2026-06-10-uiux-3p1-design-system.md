# UIUX 3'-1 Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 재사용 디자인 시스템(토큰 스케일 + 폰트 self-host + UI 프리미티브)을 세우고, 가장 거친 두 모달(share-dialog·create-agent-modal)과 앱 전역 버튼을 그 위로 옮겨 "장인정신" 일관성의 토대를 만든다.

**Architecture:** Tailwind v3 `theme.extend`에 타이포/radii/elevation 스케일 추가. sans 폰트를 next/font(빌드타임 self-host)로 로드 + CSP 원격 폰트 제거. `web/components/ui/` 신규 프리미티브(1파일 1책임) + 배럴. dev-only 갤러리로 실브라우저 확인. 모달 2종은 신규 `Modal` 셸로 치환(기존 동작·셀렉터 의미 보존). 권한/결제/API 무변경 → 162 e2e가 회귀 그물.

**Tech Stack:** Next.js 15, Tailwind v3, next/font, lucide-react(기존), TypeScript, playwright(실브라우저).

**제약:** 서버/권한/결제 로직 무변경. 모달 치환은 **시각·구조만** — 자식 폼/핸들러/제출 동작 보존. self-host(CSP).

---

## File Structure
- `web/tailwind.config.ts` — 토큰 스케일(fontSize+lineHeight, borderRadius, boxShadow) 추가
- `web/app/layout.tsx` — sans next/font 로드(`--font-sans`)
- `web/middleware.ts` — CSP에서 `fonts.googleapis.com`/`fonts.gstatic.com` 제거
- `web/components/ui/{Button,IconButton,Modal,Input,Select,Menu,Tooltip,Skeleton,EmptyState,Card,Badge,Toggle,Avatar}.tsx` + `index.ts`
- `web/app/_dev/ui/page.tsx` — dev-only 갤러리(프로덕션 빌드 제외 또는 noindex)
- 치환: `web/components/share-dialog.tsx`, `create-agent-modal.tsx` (Modal 셸), 전역 버튼

---

## Task 1: 토큰 스케일 + 폰트 self-host

**Files:** `web/tailwind.config.ts`, `web/app/layout.tsx`, `web/middleware.ts`

- [ ] **Step 1: tailwind.config.ts — 스케일 추가** (기존 `theme.extend.colors`/`fontFamily`/`boxShadow` 유지, 확장):
```ts
      fontSize: {
        display: ["28px", { lineHeight: "1.2", fontWeight: "600" }],
        title: ["20px", { lineHeight: "1.3", fontWeight: "600" }],
        subtitle: ["16px", { lineHeight: "1.4", fontWeight: "500" }],
        body: ["14px", { lineHeight: "1.5" }],
        caption: ["12px", { lineHeight: "1.4" }],
        label: ["11px", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.04em" }],
      },
      borderRadius: { sm: "6px", md: "8px", lg: "12px", xl: "16px" },
      boxShadow: {
        drive: "0 1px 2px 0 rgb(60 64 67 / 0.302), 0 2px 6px 2px rgb(60 64 67 / 0.149)",
        e1: "0 1px 2px 0 rgb(60 64 67 / 0.20)",
        e2: "0 1px 3px 0 rgb(60 64 67 / 0.24), 0 4px 8px 3px rgb(60 64 67 / 0.10)",
        e3: "0 4px 8px 3px rgb(60 64 67 / 0.16), 0 8px 24px 6px rgb(60 64 67 / 0.10)",
      },
```
fontFamily.sans는 `var(--font-sans)` 선두로 교체: `sans: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"]`.

- [ ] **Step 2: layout.tsx — sans self-host**. `Inter` from `next/font/google`(빌드타임 self-host) 추가:
```ts
import { Inter } from "next/font/google";
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
```
`<html className={`${display.variable} ${sans.variable}`}>`.

- [ ] **Step 3: middleware.ts — CSP 원격 폰트 제거**. `style-src`에서 `https://fonts.googleapis.com`, `font-src`에서 `https://fonts.gstatic.com` 삭제(self-host됐으므로). `style-src ... 'unsafe-inline'`은 유지(Tailwind/RainbowKit 인라인 스타일).
- [ ] **Step 4: 게이트** — typecheck 0. `npm --prefix web run build`로 next/font 빌드 성공 확인(또는 dev 부팅 + 폰트 200). 커밋 `feat(ui): type/radius/elevation scale + self-host sans font + drop remote-font CSP`.

## Task 2: 코어 프리미티브 — Button/IconButton

**Files:** `web/components/ui/Button.tsx`, `web/components/ui/index.ts`

- [ ] **Step 1:** `Button` — props `{variant?: "filled"|"tonal"|"text"|"outline"|"danger"; size?: "sm"|"md"; loading?: boolean}` extends `ButtonHTMLAttributes`. Drive 스타일: filled=accent bg/white, tonal=selected bg/accent text, text=hover bg, outline=border, danger=red. `rounded-full px-4 h-9`(md)/`h-8 px-3`(sm), `transition`, focus ring `accent/40`, disabled opacity. loading 시 `Loader2` 스핀 + disabled. `IconButton`(정사각 rounded-full hover). 배럴 export.
- [ ] **Step 2:** typecheck 0. (갤러리는 Task 9.) 커밋 `feat(ui): Button + IconButton primitives`.

## Task 3: Modal 셸

**Files:** `web/components/ui/Modal.tsx`

- [ ] **Step 1:** `Modal({ open, onClose, title, children, footer, size? })` — backdrop `fixed inset-0 z-50 bg-black/40`, 패널 `bg-drive-panel rounded-xl shadow-e3`, 헤더(title `text-title` + close IconButton), body(scroll, max-h), footer 슬롯. **a11y/UX**: `role="dialog" aria-modal aria-labelledby`, Esc 닫기, 바깥클릭 닫기(패널 stopPropagation), **scroll-lock**(open 시 body overflow hidden), **focus trap**(open 시 첫 focusable에 포커스, Tab 순환 — 간단 구현: 패널 내 focusable 순환). enter fade+slide(150ms). `useEffect` cleanup으로 scroll 복원.
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): accessible Modal shell (focus-trap, esc, scroll-lock)`.

## Task 4: 폼 프리미티브 — Input/Select/Toggle

**Files:** `web/components/ui/{Input,Select,Toggle}.tsx`

- [ ] **Step 1:** `Input`(label?/error?/helper? 슬롯, `rounded-md border px-3 h-9 focus:ring`), `Select`(동형 + chevron), `Toggle`(기존 share-dialog-sections:530 Toggle 시각 일반화 — `on/onChange/disabled`, accent 트랙). 기존 인라인 Toggle/Row와 동작 동일하게.
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): Input/Select/Toggle primitives`.

## Task 5: Menu (드롭다운/컨텍스트)

**Files:** `web/components/ui/Menu.tsx`

- [ ] **Step 1:** `Menu({ trigger, items: {label, icon?, onClick, danger?}[], align? })` — 클릭 토글, 바깥클릭/Esc 닫기, 키보드(↑↓ Enter), 위치(trigger 아래 align start/end), `shadow-e2 rounded-md bg-drive-panel`. row-menu.tsx의 ⋮ 패턴을 이걸로 대체 가능하게(단 row-menu 치환은 3'-2).
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): Menu (dropdown/context) primitive`.

## Task 6: 피드백 프리미티브 — Skeleton/EmptyState/Tooltip

**Files:** `web/components/ui/{Skeleton,EmptyState,Tooltip}.tsx`

- [ ] **Step 1:** `Skeleton`(pulse `bg-drive-hover rounded`, w/h props), `EmptyState`({icon, title, description?, action?} 중앙정렬), `Tooltip`({content, children} hover/focus 지연 표시, `shadow-e2 text-caption`). (Avatar/Card/Badge는 Task 7.)
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): Skeleton/EmptyState/Tooltip primitives`.

## Task 7: 표시 프리미티브 — Card/Badge/Avatar

**Files:** `web/components/ui/{Card,Badge,Avatar}.tsx`

- [ ] **Step 1:** `Card`(`rounded-lg border bg-drive-panel hover:shadow-e2 transition`, clickable variant), `Badge`({tone: "neutral"|"accent"|"warning"|"sale"}, X402Badge 일반화 토대), `Avatar`({name, color?} 이니셜 원 — 협업 presence/계정용). 배럴 정리.
- [ ] **Step 2:** typecheck 0. 커밋 `feat(ui): Card/Badge/Avatar primitives`.

## Task 8: dev UI 갤러리

**Files:** `web/app/_dev/ui/page.tsx`

- [ ] **Step 1:** 모든 프리미티브를 변형별로 렌더하는 페이지(섹션: Buttons, Modal(열기 버튼), Inputs, Menu, Feedback, Cards). 프로덕션 노출 방지: 상단에서 `if (process.env.NODE_ENV === "production") notFound();`.
- [ ] **Step 2: 실브라우저 확인** — dev 서버 + playwright로 `/_dev/ui` 캡처, 각 프리미티브 렌더·Modal 열기/Esc·Menu 키보드 동작·폰트(Inter) 적용 확인. 커밋 `chore(ui): dev primitive gallery`.

## Task 9: 모달 2종 치환 (share-dialog, create-agent-modal)

**Files:** `web/components/share-dialog.tsx`, `web/components/create-agent-modal.tsx`

- [ ] **Step 1:** 각 컴포넌트의 ad-hoc `<div className="fixed inset-0 z-50 ...">` 셸을 `<Modal open title=... onClose=...>`로 교체. **자식 콘텐츠/폼/핸들러/제출 로직은 그대로** — 셸만 교체. share-dialog의 헤더("Share /")·Done 버튼을 Modal title/footer로. 버튼들을 `Button` 프리미티브로.
- [ ] **Step 2: typecheck 0 + 풀 e2e 단독 GREEN**(162/1 — 모달 내부 동작·셀렉터 보존 확인; 깨지면 셀렉터 의미 보존하며 보정). 커밋 `refactor(ui): share-dialog + create-agent-modal on Modal shell`.

## Task 10: 실브라우저 회귀 + 머지

- [ ] dev 시드(owner+drive+멤버+진열) → playwright: ① 홈/드라이브 폰트·버튼 일관 ② Share 모달 열기→Esc/바깥클릭 닫힘, 멤버/초대/판매 섹션 정상, 통화 select·진열 체크박스 여전 동작(2a 회귀) ③ create-agent 모달 정상. 스크린샷. 정리.
- [ ] 최종 리뷰(에이전트팀) → main 머지(--no-ff, 트리 동일성).

## Self-Review
- 토큰/폰트/프리미티브는 신규 추가(비파괴). 치환은 모달 2종+버튼만(점진 — 3'-2에서 셸/목록 계속). 두 시스템 공존은 의도적·한시적(3'-3까지 수렴).
- 불변식: API/권한/결제 무변경 → 162 e2e 회귀 그물. 모달 치환은 자식 동작 보존(2a 판매 UI 포함).
- self-host: 폰트 next/font 빌드타임 + CSP 원격 제거(critical 폰트 지적 반영).
- a11y: Modal focus-trap/Esc/scroll-lock, Menu 키보드 — 프리미티브에 내장(장인정신).
