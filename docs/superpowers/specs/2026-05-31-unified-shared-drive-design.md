# 통합 공유 드라이브 + account↔wallet 연동 — Design Spec

> 2026-05-31. 공유받은 visitor가 owner와 **같은 role-aware DriveShell**을 보게 만들고,
> 결제(저작권 매매)를 **계정에 귀속**시킨다. 표준 공유 드라이브(Google Drive/Dropbox/Notion)
> 경험을 기준으로 삼되, aindrive 철학(로컬 바이트 / outbound-only CLI / agent 1급 시민 /
> x402·A2A는 layer)을 헤치지 않는다.

## 문제 (Why)

지금 공유 링크로 들어온 visitor는 owner와 **전혀 다른 빈약한 뷰**(`PaidContentView`)를 본다.
"드라이브에 초대받았는데 다른 앱을 보는" 격 — 공유 드라이브로서 기본이 안 됨. 원인:

- `/d/[driveId]` 진입이 **session 로그인 전용**(`page.tsx:9-10`) — wallet/free-share visitor는 튕김
- 그래서 visitor용 별도 입구(`/s/<token>` → `ShareGate` → `PaidContentView`)가 생김
- `DriveShell`이 owner 데이터(`/api/drives` sidebar, `/shares` 배지)를 가정

백엔드 권한(`resolveAccess`)은 **이미 path-scoped·멀티신원으로 완성**돼 있다. 통합의 net-new는
"입구 한 hop + 뷰 통합"뿐.

## 목표 (What)

두 기둥:

1. **통합 DriveShell** — 모든 principal은 로그인 account. 공유 링크 → 로그인 → drive_members에
   share.role로 멤버 추가 → `/d/<id>?path=<share.path>` → owner와 같은 DriveShell, role로 능력 차등.
2. **account↔wallet 연동** — account가 신원의 단일 축. 이메일/지갑은 account에 붙는 인증·결제 수단.
   결제는 영구 멤버십을 부여하고 account에 귀속.

## 확정된 결정 (사용자)

| # | 결정 | 값 |
|---|---|---|
| D1 | 멤버십 수명 | **영구 standing 멤버십** (Google Drive식). 공유 만료/취소돼도 기존 멤버 유지. owner가 명시 제거해야 빠짐. |
| D2 | owner 모델 | **granted owner (공동소유 가능)**. 관리 게이트를 `atLeast(role,'owner')`로. drives.owner_id는 "최초 생성자/최종 권한"로 남기되 공동 owner 허용. |
| D3 | commenter role | **입력에서 제거** (members/access/shares 스키마). 나중에 진짜 comment 기능 만들 때 재도입. |
| D4 | wallet | **account↔wallet 연동**. account = principal, wallet = link되는 결제수단. 결제 = 영구 멤버십. 비회원 지갑결제는 SIWE로 지갑 기반 account 생성. |

## 능력 매트릭스 (role → capability)

monotonic 사다리: viewer < editor < owner (commenter는 D3로 제거).

| Capability | viewer | editor | owner |
|---|---|---|---|
| Read / list / download | ✓ | ✓ | ✓ |
| Edit / write | | ✓ | ✓ |
| Upload / mkdir | | ✓ | ✓ |
| Move / rename / delete | | ✓ | ✓ |
| Share onward (링크 생성·멤버 초대) | | (O2 토글) | ✓ |
| Manage members (추가/제거/role 변경) | | | ✓ |
| Change settings / payout / delete drive | | | ✓ |

`atLeast(role, required)` + `ROLE_RANK`(access-core.js)로 게이트. owner 게이트는 D2에 따라
`drives.owner_id ===` 직접 비교 → `atLeast(resolveRole(...), 'owner')`로 전환.

## 목표 흐름 (state machine)

모두의 종착지 = `/d/<driveId>?path=<grantPath>`, per-path role로 게이트.
**link-role은 floor — 기존 더 높은 grant가 항상 이김 (upgrade-only, never downgrade).**

- **S0 RESOLVE** — `GET share by token` (서버 authoritative): 존재? 미만료? free/paid? password?
  client는 role/path를 **절대 안 보냄** — shares row에서만. token은 unguessable(nanoid24) bearer.
- **S1 AUTHGATE** — `!getUser()`면 `/login?next=/s/<token>`. 멤버십은 쿠키가 아니라 **account에**
  붙으므로 durable write 전에 로그인 먼저.
  - 🔧 GAP: `signup/page.tsx`가 `next` 무시(`router.push('/')` 하드코딩) → 수정. login의
    "Create an account" 링크가 next 전달 안 함 → 수정.
- **S2 PAYWALL** (paid만) — 로그인 account에 covering grant 없으면 x402 paywall 렌더(기존
  share-gate.tsx 유지). 결제 crypto는 그대로. **settle 전엔 멤버 추가 금지** (paywall 우회 방지).
- **S3 CONSUME** (net-new 인증 서버 hop — `POST /api/s/[token]/accept`, getUser 필수) —
  token 재검증(존재/미만료/paid⇒settled/password⇒verified) → `drive_members(drive_id,
  user_id, path=share.path, role=share.role)` **upgrade-only upsert**. unique index로 idempotent.
  user가 owner면 아무것도 안 씀.
- **S4 LAND** — `/d/<driveId>?path=<share.path>` redirect. `listUserDrives`가 멤버 drive를
  반환하므로 sidebar 자동 채워짐. `/d` page는 root '' 강제 대신 멤버 grant path에서 평가.
- **S5 RE-CLICK** — 이미 consume됨 ⇒ upgrade-only upsert no-op ⇒ S4 직행.

**이메일 초대 통합**: email-targeted share가 `{email, role, path}`를 담음. 수신자 링크 → S1 → S3가
account email 일치 확인 후 upsert. 기존 "계정 먼저 만들라" 404 제거.

## account↔wallet 연동 (D4)

- 신규 테이블 `account_wallets(account_id, wallet_address UNIQUE, linked_at, verified_via)` —
  한 account ↔ N wallet, 한 wallet은 한 account에만.
- **link**: 로그인 상태에서 SIWE 서명 → account_wallets에 추가.
- **비회원 지갑결제**: 결제 시 SIWE → 그 지갑에 묶인 account 없으면 **지갑 기반 account 생성**
  (이메일 없는 account, 나중에 이메일 추가 가능) → account_wallets link → CONSUME.
- **이메일 유저가 지갑결제**: 결제 지갑이 미link면 그 자리서 account에 link(또는 "이 결제를 내
  계정에 연결" 동의) → CONSUME.
- 결제 귀속: `payment_receipts`에 `account_id` 추가(현재 wallet+tx_hash만). wallet-keyed
  folder_access는 영수증/감사 layer로 격하 — access principal은 account.

### 엣지케이스 (account↔wallet)
- 한 지갑을 두 account에 link 시도 → 거부(wallet UNIQUE).
- link 전 그 지갑으로 결제한 이력의 소급 귀속 → link 시 그 wallet의 미귀속 receipt를 account에 연결.
- SIWE 지갑-account와 이메일 account 병합 → v1 범위 밖(별도 "계정 병합" 기능). 지금은 "한 지갑=한
  account" 유지, 병합은 막고 안내.

## delete / keep / modify / create

**create**
- `POST /api/s/[token]/accept` — CONSUME hop (인증, upgrade-only upsert).
- `mergeRoleUpgradeOnly` 헬퍼 (access*) — `s/[token]/route.ts:250-259`의 inline 가드를 공용화.
  CONSUME + owner-invite(members POST) 양쪽에 적용 (현재 members POST는 blind downgrade 위험).
- `DELETE`/`PATCH /api/drives/[driveId]/members/[id]` — 멤버 제거 / role 변경 (owner-gated).
- `account_wallets` 테이블 + SIWE link 라우트 (`POST /api/wallet/link`).
- 결제 성공 후 txHash/basescan 영수증 — shell chrome 아니라 landing 후 toast/패널.

**modify**
- `drive-shell.tsx` — (1) grant path를 시각적 root로(항상 '' 아님), (2) header Share 버튼
  canEdit 게이트(현재 전 role 렌더), (3) `loadShares()`를 canEdit일 때만, (4) breadcrumb/back-nav를
  grant path로 clamp(sub-path 멤버가 root로 못 올라가게).
- `/d/[driveId]/page.tsx` — root '' 강제 평가 제거. 멤버 grant path에서 access 평가, 그 path를
  DriveShell 초기 path로.
- `signup/page.tsx` + login의 signup 링크 — `next` 전달(open-redirect 가드 복사).
- `s/[token]/route.ts` (GET, paid settle) — settle 후 folder_access뿐 아니라 getUser().id로
  drive_members upsert + payment_receipts에 account_id.
- `share-gate.tsx` — ok-state 렌더를 `/d/<id>?path=` redirect로. paywall UI + pay()는 유지.
- members/access/shares 스키마 — commenter 제거 (D3). 관리 게이트를 atLeast(role,'owner')로 (D2).

**keep**
- `access-core.js` / `access.ts` (resolveRoleByUser, bestMatchingRole, atLeast, ROLE_RANK) — 그대로.
  ⚠️ resolveAccess가 first-non-none(user→wallet→cookie) 반환, max 아님 — D4로 paid가 member row가
  되면 대부분 moot. 명시만.
- `listUserDrives` / `GET /api/drives` / `DriveShell.loadDrives` — 이미 owned+member 반환.
- Agent 버튼/agents API (owner-gated), Upload/New Folder (canEdit disabled) — 이미 올바름.
- `/s/[token]/page.tsx` + `share-gate-client.tsx` — back-compat 입구로 유지(기존 링크 404 금지).

**delete**
- `paid-content-view.tsx` 전체 (WalletRelink + FileRender + permanent-access banner) — CONSUME +
  scoped DriveShell이 대체.
- `share-grant.ts` + `resolveRoleByShareGrants` + dochub의 free-share 쿠키 분기 + `addShareGrant` —
  단일 신원에선 dead. **30d 쿠키 back-compat 창 이후** 제거(배포일 401 방지).

## 엣지케이스 (통합) — 우선순위

| trigger | 미처리 시 실패 | spec 요구 | sev |
|---|---|---|---|
| sub-path 멤버(editor on /docs, root 권한 없음)가 `/d`를 root에서 평가 | "no access"로 튕김 | `/d` page가 grant path에서 평가 + DriveShell 초기 path를 grant path로 | critical |
| paid share를 settle 전에 CONSUME | paywall 우회 | CONSUME이 paid⇒settled 재검증 (pickFreeShareRole price 가드 계승) | critical |
| share 토큰 위조로 self-add | 무단 접근 | token unguessable(nanoid24) 유지, 서버가 role/path를 token에서만 도출 | critical |
| owner가 자기 링크 클릭 | owner인데 member row 생겨 혼란 | CONSUME이 owner면 no-op | high |
| 같은 링크 재클릭 / 이미 멤버 | upsert 에러 | upgrade-only upsert idempotent | high |
| owner-invite(members POST)가 기존 editor를 viewer로 | 권한 강등 | mergeRoleUpgradeOnly 적용 | high |
| share 만료 후 클릭 | 만료 링크로 멤버됨 | S0/S3가 expires_at 검사 | high |
| WS(dochub)에서 멤버가 doc 열기 | per-path role 미검증 | dochub이 이미 path별 resolveRole — 단일신원 후 free-share 쿠키 분기 제거 | medium |
| 기존 `/s/<token>` 북마크 + 30d 쿠키 | 배포일 404/401 | back-compat: /s 입구 유지, 쿠키 경로 유예 후 제거 | medium |
| password share(현재 쓰기만 하고 검증 안 함) | silent dead 보안 control | O1: 챌린지 구현 or 기능 제거 | medium |

## 남은 open (기본값으로 두되 표시)

- **O1 password share**: 현재 password_hash를 쓰기만 하고 검증 안 함(dead control). 기본값 = **기능
  제거**(스키마/UI에서 password 제거). 진짜 필요하면 별도.
- **O2 re-share 정책**: editor가 link 생성은 되는데 멤버 초대는 owner-only(비일관). 기본값 =
  **owner-only로 통일**("editors can share" 토글은 나중).
- **O3 WS 다운그레이드**: 라이브 편집 중 role 강등 시 즉시 kick vs eventual. 기본값 = **eventual**
  (HTTP는 이미 authoritative, 실시간 세션만 지연).
- **O4 x402 badge 가시성**: viewer에게 "유료" 배지 노출? 기본값 = **canEdit 게이트**(관리 cue).

## Build sequence (bite-sized, 각 독립 ship+verify)

1. **mergeRoleUpgradeOnly 헬퍼 추출** + members POST·s/[token] settle에 적용 (downgrade 버그 선제거).
2. **`/d` page를 grant-path 평가로** + DriveShell 초기 path 스코프 (sub-path 멤버 통과).
3. **DriveShell role-aware 마무리**: Share 버튼·loadShares canEdit 게이트, breadcrumb clamp.
4. **`POST /api/s/[token]/accept` (CONSUME)** + share-gate ok-state를 redirect로.
5. **signup/login `next` 배선** (redirect-after-auth).
6. **PaidContentView 삭제** (CONSUME+scoped shell이 대체된 뒤).
7. **member remove/role-change 라우트** + share-dialog UI.
8. **account_wallets 테이블 + SIWE link 라우트** + 결제 settle이 drive_members upsert + receipt account_id.
9. **commenter 제거** (스키마), **owner 게이트 atLeast로** (D2), **password share 제거** (O1).
10. **free-share 쿠키 경로 제거** (back-compat 창 이후 — 별도/나중).

각 스텝은 typecheck + 33 unit tests + build + 실서버 스모크로 검증, CI(PR) 통과.

## 철학 보존 체크
- 로컬 바이트 / outbound-only CLI — 안 건드림 (fs RPC 그대로).
- agent 1급 시민 — agents API/owner-gate 유지. (agent를 멤버로 다루는 건 후속.)
- x402/A2A는 layer — paywall/결제 crypto 유지, account 귀속만 추가.
