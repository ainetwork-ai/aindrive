# 공유 드라이브 권한 모델 재설계 + account↔wallet 연동 — Design Spec

> 2026-05-31. **현재 프론트/스키마에 맞추지 않는다 — from-scratch 재설계.**
> 해커톤 흔적(3개 평행 grant 테이블, 죽은 commenter 칸, wallet-keyed 유료접근)을 걷어내고,
> 표준 공유 드라이브(Google Drive/Dropbox/Notion)의 깨끗한 권한 모델 + aindrive의 1차 목표
> (web3 작가가 컨텐츠·저작권 판매)에 맞는 **구매 원장**을 세운다.
> 철학(로컬 바이트 / outbound-only CLI / agent 1급 시민 / x402·A2A는 layer)은 보존.

---

## 1. 지금 권한이 어떻게 돼 있나 (걷어낼 대상)

코드 기준 실제 진실:

**역할 사다리** (`access-core.js`): `none(0) < viewer(1) < commenter(2) < editor(3) < owner(4)`

**한 개념(이 path에서 누가 뭘 하나)을 신원 종류마다 다른 테이블로 3번 표현:**

| 테이블 | 키 | 의미 | 문제 |
|---|---|---|---|
| `drive_members` | **account** + path → role | 진짜 멤버십 | ✅ 이게 정답 형태 |
| `folder_access` | **wallet** + path → role | 유료 결제 접근 | account 아닌 지갑에 묶임. "구매"="viewer"로 뭉개짐 |
| `shares`(free) | **링크 가진 익명** + path → role | 무료 공유(쿠키 grant) | 또 다른 익명 principal |

+ `drives.owner_id` = 생성자 단일 하드 owner.

`resolveAccess`는 셋을 `max`가 아니라 **first-non-none(account→wallet→cookie)** 으로 고른다 →
같은 사람이 신원에 따라 다른 권한을 갖는 구조. `commenter`는 사다리에 있으나 댓글 기능 없음(죽은 칸).
visitor는 owner와 완전히 다른 빈약한 뷰(`PaidContentView`)를 본다 — "초대받았는데 다른 앱".

---

## 2. 목표 모델 (from scratch)

### 핵심 원칙: 두 개념을 절대 섞지 않는다

1. **접근(멤버십)** — 이 path에서 무엇을 할 수 있나. account에 묶인 영구 권한.
2. **구매(상거래)** — 누가 무엇을 얼마에 샀나. 독립 원장. 멤버십을 *부여하는 부수효과*는 있지만
   그 자체로 1급 기록 — 저작권/라이선스/로열티 레이어의 기반.

### 신원: account 단일 축

- 모든 principal은 로그인 account. wallet은 account에 link되는 **결제수단**, 별도 principal 아님.
- 무료 공유 쿠키 grant(`aindrive_share`)·wallet-keyed 익명 접근 — **둘 다 제거**.

### 역할: viewer / editor / owner (3단계) — 확정

`commenter` 제거 (댓글 기능 만들 때 재도입). monotonic 사다리: `none(0) < viewer(1) < editor(2) < owner(3)`.

| Capability | viewer | editor | owner |
|---|:--:|:--:|:--:|
| 읽기 / list / 다운로드 | ✓ | ✓ | ✓ |
| 쓰기 / 업로드 / mkdir | | ✓ | ✓ |
| 이동 / rename / 삭제 | | ✓ | ✓ |
| 공유 링크 생성 · 멤버 초대 | | (O2 토글) | ✓ |
| 멤버 관리(추가/제거/role 변경) | | | ✓ |
| 설정 · payout · 판매(유료공유) · 드라이브 삭제 | | | ✓ |

- **D2 공동 owner**: owner는 더 이상 `drives.owner_id` 단일이 아님 — 멤버십 role=`owner`인 누구나.
  `drives.owner_id`는 "최초 생성자/최종 권한"으로만 남기고, 게이트는 `atLeast(role,'owner')`.

### 접근 해석: 단일 출처

```
resolveAccess(driveId, path, accountId):
  rows = drive_members where (drive_id, user_id=accountId)
  role = bestMatchingRole(rows, normalize(path))          # 최장 접두사·최고 역할
  if accountId == drives.owner_id: role = max(role, owner) # 생성자는 항상 owner
  return role
```

- `bestMatchingRole`(path 해석)·`atLeast`·`ROLE_RANK`(commenter 제외) **유지** — 순수 로직.
- `pickFreeShareRole` + wallet/cookie 분기 + folder_access 조회 — **삭제**.
- WS(`dochub.js`)도 같은 단일 출처로 — 자기 free-share 분기 제거.

### 구매: 멤버십 부여 + 독립 원장 — 확정

```
유료 share 결제 settle:
  ├─ membership upsert: drive_members(account, share.path, share.role)  # 접근 (upgrade-only)
  └─ receipt insert:   purchase_receipts(account, drive, path, amount,  # 상거래 원장
                         tx_hash UNIQUE, network, share_id, settled_at)
```

- `payment_receipts` → **account-keyed로 재설계** (현재 wallet-keyed). `account_id` 추가, wallet은
  영수증 메타로만. tx_hash UNIQUE = replay 방어.
- `folder_access`(wallet-keyed 접근 테이블) — **제거**. 접근은 drive_members가 단일 출처.
- 저작권/라이선스/로열티 = 이 원장 위에 얹는 future layer (이번 범위 밖, 스키마가 받칠 수 있게만).

### account↔wallet 연동 (D4)

- 신규 `account_wallets(account_id, wallet_address UNIQUE, linked_at, verified_via)` — account ↔ N wallet,
  한 wallet은 한 account에만.
- **link**: 로그인 상태 SIWE 서명 → account_wallets 추가 (`POST /api/wallet/link`).
- **비회원 지갑결제**: 결제 시 SIWE → 그 지갑에 묶인 account 없으면 **지갑 기반 account 생성**(이메일 없는
  account, 나중에 이메일 추가) → link → 구매 처리.
- **이메일 유저가 지갑결제**: 결제 지갑 미link면 그 자리서 link 동의 → 구매 처리.
- 미link 지갑으로 한 과거 결제의 소급 귀속: link 시 그 wallet의 미귀속 receipt를 account에 연결.

---

## 3. 통합 드라이브 표면 (UX)

"visitor가 owner와 같은 뷰"가 아니라 **하나의 드라이브 화면 + 역할만큼만 보임**. Google Drive처럼
모두 같은 Drive UI를 쓰되 viewer에겐 Share/Upload/관리 버튼이 *없다*.

- 진입점은 **`/d/<driveId>?path=<grantPath>` 하나**. visitor 전용 입구·뷰 없음.
- 화면은 **role-aware로 새로 구축**: 파일트리(권한 있는 path만) + 역할별 능력(viewer=읽기/다운로드,
  editor=+편집 affordance, owner=+관리/판매 패널).
- sub-path 멤버(예: `/docs`에 editor)는 그 path가 시각적 root. 위로 못 올라감(breadcrumb clamp).
- **현재 `DriveShell` + `PaidContentView`는 둘 다 이 표면으로 교체** — patch 아님, 재구축.
  (현재 컴포넌트는 참고용 재료일 뿐 기준 아님.)

---

## 4. 진입·초대 흐름 (state machine)

종착지 = `/d/<driveId>?path=<grantPath>`, per-path role 게이트.
**share.role은 floor — 기존 더 높은 grant가 항상 이김 (upgrade-only, never downgrade).**

- **S0 RESOLVE** — 서버가 token으로 share 조회 (authoritative). 존재? 미만료? free/paid?
  client는 role/path를 **절대 안 보냄** — shares row에서만. token = unguessable bearer (nanoid24).
- **S1 AUTHGATE** — `!getUser()`면 `/login?next=/s/<token>`. 멤버십은 쿠키 아니라 account에 붙으므로
  durable write 전 로그인 먼저. (signup `next` 무시 버그 + login의 signup 링크 next 누락 → 수정.)
- **S2 PAYWALL** (paid만) — 로그인 account에 covering grant 없으면 x402 paywall. 결제 crypto 유지.
  **settle 전엔 멤버/영수증 쓰기 금지** (paywall 우회 방지).
- **S3 CONSUME** (인증 서버 hop — `POST /api/s/[token]/accept`, getUser 필수) — token 재검증
  (존재/미만료/paid⇒settled) → membership upgrade-only upsert (+ paid면 receipt). owner면 no-op.
- **S4 LAND** — `/d/<driveId>?path=<share.path>` redirect. 멤버 drive는 sidebar에 자동.
- **S5 RE-CLICK** — 이미 consume → upgrade-only no-op → S4 직행.

**이메일 초대 통합**: email-targeted share가 `{email, role, path}` → 수신자 링크 → S1 → S3가 email
일치 확인 후 upsert. 기존 "계정 먼저 만들라" 404 제거.

---

## 5. 스키마 변경 요약

**신규**
- `account_wallets(account_id, wallet_address UNIQUE, linked_at, verified_via)`.

**재설계**
- `payment_receipts` → account-keyed: `account_id` 추가 (wallet은 메타로 남김).
- `drive_members` — role CHECK를 {viewer,editor,owner}로 (commenter 제거). 단일 grant 출처로 격상.
- `shares` — role {viewer,editor,owner}. `password_hash` 제거 (O1: 검증 안 하는 죽은 control).
- `drives.owner_id` — "생성자/최종 권한" 의미로 유지, owner는 멤버십 role로도 부여 (D2).

**제거**
- `folder_access` (wallet-keyed 접근) — drive_members가 단일 출처로 대체. (마이그레이션: 기존 row를
  account로 매핑 가능하면 drive_members로 이관, 아니면 receipt로만 보존.)

---

## 6. 코드 변경 요약

**유지** — `bestMatchingRole` / `atLeast` / `ROLE_RANK`(commenter만 삭제) / `listUserDrives`(이미
owned+member 반환) / `normalizePath`.

**재작성**
- `resolveAccess` — 단일 출처(drive_members + owner_id), first-non-none/wallet/cookie 분기 제거.
- 드라이브 표면 컴포넌트 — role-aware로 신규 구축 (DriveShell + PaidContentView 대체).
- `dochub.js` WS 권한 — free-share 분기 제거, 단일 출처.

**신규**
- `mergeRoleUpgradeOnly` 헬퍼 — CONSUME·owner-invite 양쪽 (현재 members POST는 blind downgrade 위험).
- `POST /api/s/[token]/accept` (CONSUME).
- `DELETE`/`PATCH /api/drives/[driveId]/members/[id]` (owner-gated).
- `POST /api/wallet/link` (SIWE).

**수정**
- `/d/[driveId]/page.tsx` — root '' 강제 제거, 멤버 grant path에서 평가.
- `signup/page.tsx` + login의 signup 링크 — `next` 배선 (open-redirect 가드).
- `s/[token]/route.ts`(GET, paid settle) — settle 후 drive_members upsert + account-keyed receipt.
- `share-gate.tsx` — ok-state를 `/d/<id>?path=` redirect로. paywall UI + pay()는 유지.

**제거** (back-compat 창 이후)
- `paid-content-view.tsx` 전체. `share-grant.ts` + `resolveRoleByShareGrants` + dochub free-share 분기
  + `addShareGrant` (`aindrive_share` 쿠키 경로 — 30d 유예 후).

---

## 7. 엣지케이스 (우선순위)

| trigger | 미처리 시 | 요구 | sev |
|---|---|---|---|
| sub-path 멤버가 `/d`를 root에서 평가 | 튕김 | grant path에서 평가 + 초기 path 스코프 | critical |
| paid share를 settle 전 CONSUME | paywall 우회 | CONSUME이 paid⇒settled 재검증 | critical |
| token 위조 self-add | 무단 접근 | token unguessable, 서버가 role/path를 token에서만 도출 | critical |
| 한 지갑을 두 account에 link | 신원 충돌 | wallet UNIQUE 거부 | critical |
| owner-invite가 기존 editor를 viewer로 | 강등 | mergeRoleUpgradeOnly | high |
| owner 자기 링크 클릭 | 멤버 row 혼란 | CONSUME owner no-op | high |
| 재클릭/이미 멤버 | upsert 에러 | upgrade-only idempotent | high |
| share 만료 후 클릭 | 만료 링크로 멤버 | S0/S3 expires_at 검사 | high |
| WS 멤버가 doc 열기 | per-path role 미검증 | dochub 단일 출처 path별 resolveRole | medium |
| 기존 `/s` 북마크 + 30d 쿠키 | 배포일 404/401 | /s 입구 유지, 쿠키 경로 유예 후 제거 | medium |
| folder_access 마이그레이션 | 기존 유료구매자 접근 상실 | 매핑 가능 row는 drive_members로 이관 | medium |

---

## 8. 남은 open (기본값으로 두되 표시)

- **O1 password share**: 현재 password_hash 쓰기만 하고 검증 안 함(죽은 control). 기본값 = **제거**.
- **O2 re-share 정책**: editor가 링크 생성·멤버 초대 가능? 기본값 = **owner-only**("editors can share" 토글 나중).
- **O3 WS 다운그레이드**: 라이브 편집 중 강등 즉시 kick vs eventual. 기본값 = **eventual**(HTTP는 authoritative).
- **O4 유료 배지 가시성**: viewer에게 "유료" 노출? 기본값 = **canEdit 게이트**(관리 cue).

---

## 9. Build sequence (각 독립 ship+verify)

권한 모델 붕괴가 토대 → 먼저. 표면 재구축 → 그 위. 구매/wallet → 마지막.

1. **ROLE_RANK commenter 제거** + `mergeRoleUpgradeOnly` 추출, members POST·s settle에 적용 (downgrade 선제거).
2. **resolveAccess 단일 출처화** — wallet/cookie/free-share 분기 제거, drive_members + owner_id만.
   dochub WS도 같이. (folder_access 조회 제거 + 마이그레이션.)
3. **`/d` page grant-path 평가** + 초기 path 스코프 (sub-path 멤버 통과).
4. **role-aware 드라이브 표면 신규 구축** — viewer/editor/owner 능력 차등, breadcrumb clamp.
5. **`POST /api/s/[token]/accept` (CONSUME)** + share-gate ok-state redirect.
6. **signup/login `next` 배선**.
7. **PaidContentView 삭제** (4·5 ship 후).
8. **member remove/role-change 라우트 + UI**.
9. **purchase 원장 재설계**: payment_receipts account-keyed, settle이 drive_members upsert + receipt.
   folder_access 제거.
10. **account_wallets + SIWE link** (`POST /api/wallet/link`), 비회원 지갑결제 → account 생성·link.
11. **정리**: shares password 제거(O1), owner 게이트 atLeast(D2), free-share 쿠키 경로 제거(back-compat 후).

각 스텝: typecheck + unit tests + build + 실서버 스모크 + CI 통과.

---

## 10. 철학 보존 체크
- 로컬 바이트 / outbound-only CLI — 안 건드림 (fs RPC 그대로).
- agent 1급 시민 — agents API/owner-gate 유지. (agent를 멤버로 다루는 건 후속.)
- x402/A2A는 layer — paywall·결제 crypto 유지, 구매를 account 원장에 귀속만 추가.
