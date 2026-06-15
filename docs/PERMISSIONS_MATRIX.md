# Permission requirements matrix

The **authoritative, exhaustive list of what each actor may do/see in each
situation, and how each case MUST behave.** This is the living source of truth
for permission *behaviour*.

- **Why** the model is shaped this way (roles, inheritance, identity) →
  [`PERMISSIONS.md`](PERMISSIONS.md). This file is the *case table*, that file
  is the *map*.
- **History / rationale of past decisions** → the dated specs under
  `docs/superpowers/specs/*permission*`. Those are immutable records; this file
  is kept current.
- **Enforcement** → every requirement here has an ID (e.g. `R-ACC-PAID-001`)
  mirrored by a test in `web/lib/__tests__/permission-matrix.test.ts`. The pure
  decision rules live in `web/lib/access-core.js`.

## How to use / maintain this file (read before any permission change)

1. Find the requirement(s) your change touches by ID.
2. If behaviour changes, **edit the row here first**, then update the mirrored
   test, then the code. The row is the spec; the test is the proof.
3. New gate / surface → add a new `R-*` row + a test. Never add a permission
   check that no row describes.
4. `CURRENT` = implemented and asserted today. `TARGET` = agreed required
   behaviour **not yet implemented** (tracked as `it.todo` in the test — the
   build-this list). `DEFERRED` = documented design, intentionally **not**
   planned (§10). All formerly-`OPEN` decisions are now settled (§10).

---

## 0. Dimensions & definitions

**Actor role at the target path** — resolved by `bestMatchingRole` (highest
grant on the path or any ancestor); drive ownership ⇒ `owner`. Ladder
`none < viewer < editor < owner` (`ROLE_RANK`). The **creator**
(`drives.owner_id`) is implicitly `owner` everywhere **plus** holds creator-only
surfaces (§7). `logged-out` = no session ⇒ `resolveAccess` → `none`.

**Content classification of a path P** — a property of the path, independent of
who is asking:
- **free** — no priced share covers P (no `shares` row with `price_usdc>0` at P
  or any ancestor).
- **paid** — the nearest-ancestor share covering P has `price_usdc>0`. That
  ancestor is the **gate path**.
- **private** *(deferred, §10)* — explicitly restricted: excluded from inherited
  grants even when free.
- **public** *(deferred, §10)* — anonymous-readable.

**Entitlement (paid paths only)** — does this account hold a right to the gate
path, independent of role:
- **purchased** — a `payment_receipts` row for this account covers the gate path.
- **comped** — an owner-issued free grant covers the gate path *(TARGET, §4)*.
- **none** — neither.

> Today access is **purely additive** (a `drive_members` grant only ever *adds*
> reach). The paid carve-out (§1) introduces the first **subtractive** rule: a
> priced subtree is removed from a broad viewer grant's reach. `private` would
> generalise that; see §10.

---

## 1. Content access — read / download / list-self / stream / yjs-read

Gate: `min = viewer` at the target path. Rule (TARGET) =
`canReadContent(role, classification, hasEntitlement)`:

| Actor role at P | free | paid · no entitlement | paid · purchased/comped | private *(deferred)* | public *(deferred)* |
|---|---|---|---|---|---|
| logged-out (anon) | DENY | DENY | DENY (entitlement binds to an account ⇒ needs login) | DENY | ALLOW |
| logged-in, role `none` | DENY | DENY | **ALLOW** (comp/receipt without any role) | DENY | ALLOW |
| `viewer` | ALLOW | **DENY** | ALLOW | OPEN | ALLOW |
| `editor` | ALLOW | **ALLOW** (manager) | ALLOW | OPEN | ALLOW |
| `owner` / creator | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW |

| ID | Requirement | Status |
|----|-------------|--------|
| `R-ACC-FREE-001` | Free path: `viewer+` may read/download; `none`/anon denied. | CURRENT (`require-access.ts:29`, `access.ts:66`) |
| `R-ACC-PAID-001` | Paid path: a bare `viewer` grant **does NOT** grant read — purchase/comp required. *(Today it wrongly does — `fs/*` never consults `shares`.)* | **TARGET** |
| `R-ACC-PAID-002` | Paid path: `editor+`/owner/creator read freely (they manage the content). | TARGET (free part CURRENT; the *distinction* from viewer is new) |
| `R-ACC-PAID-003` | Paid path: an account with a covering receipt **or** comp may read, even with no role grant. | TARGET |
| `R-ACC-PAID-004` | Write ops are **never** paywalled — they already require `editor+`, which bypasses (§3). The carve-out applies to *read* only. | TARGET (invariant to preserve) |
| `R-ACC-ANON-001` | No logged-out access to any non-public path (`resolveAccess` null→none). | CURRENT (`access.ts:71`) |
| `R-ACC-NEST-001` | Nested sales: the gate is the **nearest-ancestor** priced share; entitlement must cover **that** path. Buying a parent does not unlock a more-specific (separately priced) child. | TARGET |

> **Implementation note (not a requirement):** `canReadContent` is the pure
> rule and is tested now. Wiring it into the `fs/*` / `yjs` read routes (so they
> compute `classification` via a nearest-ancestor `shares` lookup and
> `hasEntitlement` via `payment_receipts`/comp) is the remaining work —
> `R-WIRE-*` todos in the test.

---

## 2. Listing visibility — what a folder listing reveals per child

When `list` succeeds on a folder, each child entry is annotated, not silently
dropped — except `private`:

| Child classification | viewer w/o entitlement sees | editor+/owner sees |
|---|---|---|
| free | visible + openable | visible + openable |
| paid (no entitlement) | **visible + LOCKED** (name + price + lock; click → paywall) | visible + openable |
| paid (entitled) | visible + openable | visible + openable |
| private *(deferred)* | **HIDDEN** | visible (deferred: editor vs owner — §10) |
| public *(future)* | visible + openable | visible + openable |

| ID | Requirement | Status |
|----|-------------|--------|
| `R-VIS-PAID-001` | Paid children are shown to non-entitled viewers as **locked** (decided `O-VIS-PAID`: a drive of paid content advertises, not hides, what's for sale). Today: covered viewers see them as normal files; uncovered partial members get the separate showcase (`showcase.ts`). | TARGET |
| `R-VIS-PRIV-001` | Private children are **hidden** from listings for non-allowlisted users. | DEFERRED (§10) |

---

## 3. Write operations — upload / write / edit / delete / mkdir / rename / yjs-write

| ID | Requirement | Status |
|----|-------------|--------|
| `R-WRITE-001` | All fs mutations require `editor+` at the target path (rename uses the *source* path). | CURRENT (`require-access.ts:29`; routes `fs/upload,write,delete,mkdir,rename,yjs`) |
| `R-WRITE-002` | Chunked upload: only the **session creator** (`created_by`) may append/status/abort, and must still be `editor+` at the session path. | CURRENT (`fs/upload-sessions/[uploadId]/route.ts:37`) |
| `R-WRITE-003` | Writes are unaffected by sale/paywall state (see `R-ACC-PAID-004`). | CURRENT/TARGET-invariant |

---

## 4. Shares & commerce — create / list / revoke / list-on-storefront / comp

| ID | Requirement | Status |
|----|-------------|--------|
| `R-SHARE-FREE-001` | Create a **free viewer** link: `editor+` **at the link's own path** (non-root editors included). | CURRENT (`shares/route.ts:43`) |
| `R-SHARE-EDITOR-001` | Create an **editor** link: `owner at root` only (no lateral edit-delegation by path-scoped editors). | CURRENT (`shares/route.ts:56`) |
| `R-SHARE-PAID-001` | Create a **paid** share: `editor+` at the path **and** a payout wallet resolvable for that path; one token, in the drive's allowed-tokens policy. | CURRENT (`shares/route.ts:63`) |
| `R-SHARE-PAID-002` | Non-root paid share also requires the agent online (path-existence/typo probe). Root (`""`) has no path to probe ⇒ **not** agent-gated. | CURRENT (`shares/route.ts:86`; rationale: spec D7) |
| `R-SHARE-LIST-001` | List all share links (`GET /shares`): `editor+ at root`. | CURRENT (`shares/route.ts:26`) |
| `R-SHARE-STORE-001` | `listed:true` (put on the drive storefront): `owner at root` only. | CURRENT (`shares/route.ts:49`) |
| `R-SHARE-REVOKE-001` | Revoke a link: the link's `created_by` **or** `owner at root`. Revoking 404s the token but leaves already-accepted grants intact. | CURRENT (`shares/[shareId]/route.ts:36`) |
| `R-COMP-001` | An owner may grant a specific account **free entitlement** to a paid path **without** edit rights (a "comp"). Behaves like a purchase for access (§1), binds to the account, is revocable, and is auditable distinctly from real sales. | **TARGET** |
| `R-COMP-002` | Comp entitlements live in a **separate `comp_grants` table** (decided `O-COMP-STORE`); path-scoped (covers the gate path and below, nearest-ancestor like receipts). The paid read gate checks `payment_receipts` **OR** `comp_grants`. | TARGET |

---

## 5. Payment / share-link resolution

| ID | Requirement | Status |
|----|-------------|--------|
| `R-PAY-RESOLVE-001` | `GET /s/:token` is public + login-aware: returns free metadata; the link owner and already-covered members bypass; paid + uncovered → `402`. | CURRENT (`s/[token]/route.ts:75`) |
| `R-PAY-SETTLE-001` | A verified x402 payment settles, writes an **upgrade-only** `drive_members` grant at `share.path`/`share.role` **and** an append-only `payment_receipts` row; binds to the resolved account. | CURRENT (`s/[token]/route.ts:179`) |
| `R-PAY-ACCEPT-001` | `POST /s/:token/accept` needs login; free → grant; paid → only if already covered (settled), else `402`; upgrade-only. | CURRENT (`s/[token]/accept/route.ts:22`) |
| `R-PAY-ENT-001` | After `R-ACC-PAID-*` ships, the **receipt** (not the auto-written member row) is the access proof for a paid path; the member row remains for navigation/entry. | TARGET |

---

## 6. Members

| ID | Requirement | Status |
|----|-------------|--------|
| `R-MEM-INVITE-001` | Invite by email: `owner at root`. Existing account → immediate grant; else pending invite (`202`) claimed on signup (upgrade-only). | CURRENT (`members/route.ts:56`) |
| `R-MEM-OWNER-001` | Granting/minting an **owner** is **creator-only**, and only at root (no non-root owner). | CURRENT (`members/route.ts`, `members/[memberId]/route.ts:71`) |
| `R-MEM-LIST-001` | List roster: `editor+ at root`; pending invites visible to `owner+` only. | CURRENT (`members/route.ts:21`) |
| `R-MEM-ROLE-001` | Change role (PATCH): `owner at root`; explicit downgrade allowed; the **creator row is immutable**; owner role whole-drive only. | CURRENT (`members/[memberId]/route.ts:59`) |
| `R-MEM-REMOVE-001` | Remove member: `owner at root`; **creator row cannot be removed**. | CURRENT (`members/[memberId]/route.ts:31`) |
| `R-MEM-LEAVE-001` | Any member may leave (deletes own rows); the **creator cannot leave** (deletes the drive instead). | CURRENT (`leave/route.ts:26`) |
| `R-MEM-INVITE-DEL-001` | Cancel a pending invite: `owner at root`. | CURRENT (`members/invites/[inviteId]/route.ts:18`) |

---

## 7. Financial & host — **creator-only** (`drives.owner_id`, not co-owners)

Co-owners (an `owner` grant at root who are not the creator) manage members/links
and create/price/list shares, but the following stay with the creator
(blast-radius safety); the UI shows co-owners an explicit "creator-only" state.

| ID | Requirement | Status |
|----|-------------|--------|
| `R-FIN-READ-001` | Read drive settings (`GET /drives/:id`): creator-only. | CURRENT (`drives/[driveId]/route.ts:72`) |
| `R-FIN-TOKEN-001` | Set payment-token policy + payout (`PATCH /drives/:id`): creator-only. | CURRENT (`drives/[driveId]/route.ts:36`) |
| `R-FIN-PAYOUT-001` | List/set/clear path-scoped payout wallets (`GET/PUT/DELETE /payout`): creator-only. | CURRENT (`payout/route.ts:37,44,54`) |
| `R-FIN-EARN-001` | Earnings ledger (`GET /receipts`): creator-only. | CURRENT (`receipts/route.ts:14`) |
| `R-HOST-AGENT-001` | Create/list/update/delete agents + rotate agent token: creator-only. | CURRENT (`agents/route.ts:49,104`; `agents/[agentId]/route.ts:46,81`; `rotate/route.ts:7`) |
| `R-HOST-DELETE-001` | Delete drive: creator-only. | CURRENT (intent; `drives.ts:67`) |

---

## 8. Storefront / showcase

| ID | Requirement | Status |
|----|-------------|--------|
| `R-STORE-001` | `GET /showcase`: creator **or** any member (≥1 row anywhere); lists only `listed:true` priced shares the viewer does not already cover. | CURRENT (`showcase/route.ts:17`; `showcase.ts`) |
| `R-STORE-002` | No public/anonymous storefront (explicit non-goal). | CURRENT |
| `R-STORE-003` | Once `R-ACC-PAID-*` ships, a whole-drive viewer no longer "covers" paid paths ⇒ the storefront becomes meaningful for them (free content browsable, paid items surfaced to buy). | TARGET |

---

## 9. Agent / WebSocket

| ID | Requirement | Status |
|----|-------------|--------|
| `R-AGENT-WS-001` | Agent WS connect: bearer token verified against bcrypt `agent_token_hash`; close on mismatch. | CURRENT (`agents.js:69`) |
| `R-AGENT-WS-002` | The WS handler (`dochub.js`) hand-duplicates `resolveRole`; it MUST stay in sync with `access.ts` (no machine binding today — covered by a shared test). | CURRENT/at-risk |
| `R-AGENT-ASK-001` | Ask agent: tier rate-limit + per-request policy evaluation. | CURRENT (`agents/[agentId]/ask/route.ts:38`) |

---

## 10. Settled decisions

These were the open product calls; now decided. The rows above are updated to
match.

| ID | Decision | Outcome |
|----|----------|---------|
| `O-COMP-STORE` | Where comp entitlements live. | **DECIDED: a separate `comp_grants` table.** Keeps `payment_receipts` a pure append-only money ledger (clean earnings/audit, no synthetic `tx_hash` for non-payments). The paid read gate (`R-ACC-PAID-003`) checks `payment_receipts` **OR** `comp_grants` for the entitlement. |
| `O-VIS-PAID` | Locked-and-visible vs hidden for paid children in listings. | **DECIDED: locked + visible** (`R-VIS-PAID-001`). A drive of paid content advertises what's for sale; a non-entitled viewer sees name + price + lock, click → paywall. |
| `O-PRIV-SCOPE` | A general **private** (free-but-restricted) classification. | **DEFERRED — not planned.** No concrete need; the paid carve-out + comp cover the stated cases. The §1/§2 2-axis layout stays as the extension point if a real need appears (and would decide then whether `private` excludes broad `editor` grants or only `viewer`). |
| `O-PUBLIC-SCOPE` | Anonymous **public** read as a per-path flag. | **DEFERRED — not planned.** A separate "web publishing" concern; free share links already approximate "anyone with the link". |
