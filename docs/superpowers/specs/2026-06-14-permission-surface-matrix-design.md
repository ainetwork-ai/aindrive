# Permission × Surface × Scenario matrix — design (2026-06-14)

Ground-truth map of **who can do/see what, where**, extracted from the code +
product docs (7-dimension audit), used to re-align the UI with the backend and
the product intent. Backend gates are the authoritative truth; the UI must not
*offer* what the backend rejects nor *hide* what the product intends to allow.

## Decisions needed (product calls — see Open questions for detail)

1. **Editor sharing** — expose the Share drawer to editors (free links + paid-unlisted at paths they cover; Sell/List stay owner-only)? Spec §B says yes; backend already allows it. *Rec: yes.*
2. **Co-owner financials** — keep payout wallet + token policy + earnings **creator-only** (fix the misleading co-owner UI + PERMISSIONS.md), or open to co-owners? *Rec: keep creator-only, fix UI.*
3. **Paid tier** — sales grant **viewer-only** (current, hardcoded) or also editor-tier (+ storefront advertises same-path upgrades)? *Rec: decide; default keep viewer-only.*
4. **Path-scoped `owner`** — forbid granting owner at a non-root path (remove the dead concept), or implement subtree-owner authority? *Rec: forbid owner-at-non-root.*

## Personas

- **Logged-out visitor** — no session; `resolveAccess`→'none'. Can see a paywall/free-share metadata at `/s/:token` but cannot consume (accept is 401); forced to `/login?next=` before any signature. No drive/Manage/showcase.
- **Logged-in, no grant** — authenticated, zero rows, not creator. Hard-deny on `/d/[id]`; showcase 403. Only entry = consume a free share or pay a paid share.
- **Viewer** — read+download on covered paths. Chrome: browse/search/folder-chat; Upload/New disabled; no row ⋮, no Share, no Manage, no Create-agent. Sees the showcase upsell. Can leave.
- **Editor** — viewer + upload/edit/delete on covered paths; row ⋮ Rename/Delete. **Backend allows more than the UI shows** (free + paid-unlisted create at-path) — no affordance today.
- **Path-scoped grantee** — grant on a subtree; inherits down, resolves 'none' at root. Root-gated endpoints (shares/members list, Manage, listing) all deny. A path-scoped *owner* still can't open Manage or list.
- **Co-owner** (owner via a root grant, not creator) — full member/link authority + owner chrome, but **creator-only surfaces 403**: drive settings read/write, payout, token policy, earnings. UI currently hides this poorly.
- **Creator** (`drives.owner_id`) — implicit owner everywhere; the only actor with settings/payout/token-policy/earnings/delete. Immutable member row; cannot leave (deletes drive instead).
- **Buyer** — logged-in payer; identity bound before payment; settle writes an upgrade-only grant at `share.path`/`share.role` (always viewer today) + receipt; becomes a viewer.
- **Agent (CLI/WS)** — owns the filesystem; `dochub.js` hand-duplicates `resolveRole` (no machine check binding it to `access.ts` — keep in sync).

## Backend capability matrix (authoritative)

| Action | Allowed for | Source |
|---|---|---|
| Read/download; WS connect | ≥viewer at path (ownership⇒owner) | require-access.ts:29; dochub.js:59 |
| Upload/edit/delete (fs/*) | ≥editor at path | require-access.ts:29 |
| **List** share links (GET /shares) | ≥editor **at root ''** | shares/route.ts:24 |
| **Create** share (free or paid, unlisted) | ≥editor **at the share's own path**; role enum viewer\|editor (never owner); paid needs payout-for-path + in-policy currency | shares/route.ts:35 |
| **List on storefront** (listed:true) | ≥**owner at root ''** | shares/route.ts:46 |
| Revoke a share | owner-at-root OR the link's `created_by` | shares/[shareId]:36 |
| List roster (GET /members) | ≥editor at root ''; pending invites owner-only | members/route.ts:17 |
| Invite by email | ≥**owner at root ''**; role viewer\|editor\|**owner**; any path; upgrade-only | members/route.ts:11,34 |
| Change role (PATCH) | ≥owner at root ''; **only downgrade path**; rejects creator row | members/[memberId]:43; member-guard:6 |
| Remove member | ≥owner at root ''; rejects creator row | members/[memberId]:22 |
| Leave | any member (deletes all own rows); **creator cannot** | leave/route.ts:20 |
| Read drive settings (GET /drives/:id) | **creator only** | route.ts:70 |
| Set payout / token policy (PATCH; PUT/DELETE payout) | **creator only** | route.ts:32; payout:27 |
| Earnings ledger (GET /receipts) | **creator only** | receipts:17 |
| Showcase (GET /showcase) | creator OR ≥1 row anywhere; filters to listed+priced uncovered | showcase/route:9; showcase.ts:28 |
| Resolve/pay/accept a share (/s/:token) | public GET (login-aware); creator/free/already-covered bypass; accept needs login; settle binds to account | s/[token]/route.ts; accept:18 |
| Open Manage | ≥**owner at root ''** (creator or co-owner) | manage/page.tsx:13 |
| Delete drive / rotate agent token | creator only (intent) | drives.ts:67 |

## Surface visibility (condensed)

- **Home** — logged-out: marketing only. Logged-in: drives owned/member-of; Leave button on non-owned cards.
- **Drive view** — visitor: redirected to login. No-grant: hard-deny. Viewer: browse only + showcase. Editor: + upload/edit/delete + row Rename/Delete (no Sell/Share). Owner: full chrome (Share, Sell, Create-agent, Manage, inline price badges, **no** showcase).
- **Share drawer** — **owner-only to open** today (both entry points isOwner). Creator: all sections work. Co-owner: same layout but settings reads 403 → DEFAULT_TOKENS fallback + payout Save 403s.
- **Manage** — ≥owner-at-root to open. Co-owner: Members/Links work; Earnings silently $0.00; Payments "Creator-only" empty state. Creator: all 4 sections.
- **Paywall** — visitor: sign-in-to-purchase. Buyer: connect→(approve)→pay→granted→redirect. Creator/entitled: bypass, enter free.
- **Storefront/showcase** — owners: never see it in-drive (audit in Manage→Sales). Member-without-access: "For sale" grid (leaf name+price+lock) of uncovered listed items. No-row/logged-out: nothing (no public storefront — explicit non-goal).

## Scenarios (walkthrough + current gap)

- **Sell file / folder** — owner row ⋮ → Sell…; drawer at path; needs payout-for-path; price+currency; optional List; POST /shares role:'viewer' (hardcoded). *Gap: viewer-only; editors have no affordance though backend allows; co-owner currency/payout drawer gaps.*
- **Sell whole drive** — header Share at root; path ''; stat-probe skipped. *Gap: can mint while agent offline (file/folder can't); viewer-only.*
- **Free share** — drawer FreeLinkSection; role viewer\|editor; POST /shares no price. *Gap: editor-tier free link mintable; drawer owner-only so editors blocked; accept needs login (no anon link access).*
- **List on storefront** — owner ticks List (isOwner); backend re-gates owner-at-root. *Gap: path-scoped owner can't list; owner never sees own showcase in-drive.*
- **Member browses storefront** — entry view shows uncovered listed items; click→paywall. *Gap: same-path tier upgrades NOT advertised (filter ==='none', not rank<share.role); no inline badges for members.*
- **Visitor on paid link** — 402→login-first→buyer. *Intended; no gap.*
- **Buy+accept** — connect→Permit2 approve→pay→settle→upgrade-only grant+receipt→redirect to share.path. *Gap: wallet-only fallback account if no login (rare, identity-first gate); leaving forfeits grant.*

## Divergences (UI ≠ backend ≠ intent)

**Fix-now (clear, once directions below are set):**
- **D1 [high]** Editors have backend right to create shares, zero UI. → expose drawer Link tab to editors (Free on, Paid hidden), row "Share…" gated canEdit; Sell/List stay owner-only. *(decision 1)*
- **D2 [high]** Co-owner sees owner chrome but creator-only settings silently break (payout Save 403 toast, $0.00 Earnings, DEFAULT_TOKENS fallback). → explicit "Creator-only" states for Earnings + drawer currency/payout when GET /drives 403s. *(decision 2)*
- **D5 [low]** Creator's own member row shows role Select + Remove that always 400. → lock with 👑 badge (both Manage + drawer). *(already addressed on `ux/intuitive-flows` branch — reconcile.)*
- **D9 [low]** Agent-offline has no dedicated drive-view state (generic load error). → explicit offline state. *(also touched by `ux/intuitive-flows`.)*

**Needs a decision (below):**
- **D3 [med]** PERMISSIONS.md overstates co-owner "sales/settings" — backend makes creator special in 4 ways (row immutability + payout + token policy + earnings). *(decision 2 → doc fix)*
- **D4 [med]** Storefront hides same-path paid upgrades from lower-tier members (filter ==='none' vs backend's rank<share.role). *(decision 3)*
- **D6 [med]** List endpoints gate at root, so a path-scoped editor can create a link but not list it. → path-aware list, or document drawer per-path list as the non-root audit surface. *(decision 4-adjacent)*
- **D7 [low]** Whole-drive sale skips the agent existence probe. **RESOLVED = documented, NOT gated.** Briefly tried gating root sales on agent-online, but e2e #184 encodes the intended flow (create a drive → set up storefront/sales → pair/start the agent later), and the file/folder probe is path-EXISTENCE verification (typo protection), not a sell-time agent gate — root has no path to verify. So there is no real asymmetry to "fix"; root share creation is intentionally agent-independent.
- **D8 [low]** No inline sale badge for editors managing files on sale. *(decision 3-adjacent)*

## Open questions (product decisions + recommendation)

1. **Paid tier ceiling** — viewer-only (current) vs allow editor-tier sales? *Rec: keep owner ungrantable via shares; decide viewer-only vs add a viewer\|editor role choice in SellSection.*
2. **Storefront upgrades** — advertise same-path paid upgrades to existing lower-tier members? *Rec: yes — change filter to rank<share.role (backend already supports it).*
3. **Path-scoped `owner`** — real concept or dead? Management gates all check root. *Rec: forbid owner at non-root (validate path=='' for role owner), removing the in-between confusion.*
4. **Co-owner financials** — payout/token-policy/earnings creator-only or co-owner? *Rec: keep creator-only (blast-radius); fix PERMISSIONS.md + ROLE_HELP + add explicit blocked states.*
5. **Inviter≥invitee ceiling** — any owner can mint/demote another co-owner; only creator protected. *Rec: acceptable for a shared drive; optionally reserve owner-minting to the creator.*
6. **Spec-vs-spec** — 2026-06-11 membership (3 Manage tabs + InviteCard) vs later ux-overhaul (5 sections + invite-in-drawer). *Rec: ux-overhaul governs; mark membership Manage layout superseded.*
7. **Editor free-link escalation** — editors can mint editor-tier free links (role select offers editor). *Rec: cap non-owner free-link role at viewer + enforce role≤caller in POST /shares, unless lateral edit-delegation is intended.*

## Doc reconciliation (follow-up)

- PERMISSIONS.md: enumerate the **creator-only** surface (row immutability + payout + token policy + earnings + delete); reframe co-owner as "members + links + create/list/price shares".
- Mark `2026-06-11-membership-ux-design.md` Manage layout **superseded** by the ux-overhaul.
- `dochub.js` ↔ `access.ts` role duplication: note it / add a shared test.

## Future: creator (drive-owner) transfer — NOT built

"Creator" = the account that ran `aindrive` to pair the folder
(`drives.owner_id`, set once in `createDrive`). It is the real host: the
agent token + the machine holding the files + drive-deletion. There is no
ownership transfer today (only `rotate-token` re-issues the agent token to
the SAME owner). Co-ownership (a web `owner` grant) is the collaboration
approximation; it deliberately does NOT convey the creator-only surface
(payout/token-policy/earnings/delete — by design, blast-radius).

If real transfer is ever needed it spans CLI + web (the host machine has to
change hands, not just a DB column): re-pair the folder under the new
owner's credentials and reassign `owner_id`, or an explicit "transfer
ownership" flow that issues a fresh agent token to the new owner and
flips `owner_id`. Out of scope until there's a concrete need.
