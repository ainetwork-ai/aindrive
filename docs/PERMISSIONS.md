# Drive permissions model

How access works in an aindrive drive. The canonical logic is `web/lib/access-core.js`
(pure, tested) + `web/lib/access.ts` (DB-backed wrappers); this page is the map.

> **The exhaustive case→behaviour table** (who may do/see what in every
> situation, with requirement IDs + tests) is
> [`PERMISSIONS_MATRIX.md`](PERMISSIONS_MATRIX.md). Consult & update it on every
> permission change. This page explains the *why*; the matrix is the *spec*.

## Roles

A four-rung ladder (`ROLE_RANK`): `none` < `viewer` < `editor` < `owner`.

| Role | Can |
|------|-----|
| viewer | read & download files |
| editor | + upload, edit, delete files |
| owner | + manage members & links; create / price / list shares |

The `owner` role is **whole-drive only** — it is granted at `path=""`, never on
a subtree (the API rejects a non-root owner grant), because every owner-level
gate resolves at root.

**Creator vs co-owner.** Anyone holding `owner` via a `drive_members` row at
`""` is a *co-owner*. The **creator** (`drives.owner_id`) is special in several
ways a co-owner is NOT — these are **creator-only**, not "owner":

- their member row is immutable (`canRemoveMember`) — can't be removed/demoted;
- **payout wallets** (per-path) — `GET/PUT/DELETE /payout`;
- **payment-token policy** — `PATCH /api/drives/:id`;
- the **earnings ledger** — `GET /receipts`;
- **drive deletion** + agent-token rotation; and the creator can't *leave*
  (they delete the drive instead).

A co-owner manages members and links and can create/price/list shares, but the
financial config + earnings above stay with the creator (blast-radius safety).
The UI shows co-owners an explicit "creator-only" state on those surfaces.

## Grants are path-scoped, and inherit downward

A membership (`drive_members` row) is `(user, path, role)`. `path=""` means the
whole drive; `path="docs"` covers `docs` and everything under it.

A user's effective role at a path is the **highest-ranked grant on that path or
any ancestor** (`bestMatchingRole`). One person can hold several grants in the
same drive (e.g. viewer at `""`, editor at `docs/drafts`); the most specific
covering grant wins by rank.

## Upgrade-only: access never silently downgrades

Whenever a grant is written from an *automatic* flow — accepting a share link,
settling a payment, an invite re-fire, claiming a pending invite — it merges
**upgrade-only** (`mergeRoleUpgradeOnly`): the kept role is the higher of the
existing and incoming. A viewer link can't demote an editor. Only an owner's
explicit role change (PATCH) can lower a role.

## Three ways access is granted — all converge on a grant

- **Invite** (`POST /api/drives/:id/members`, owner-only): by email. If the
  email already has an account → immediate `drive_members` grant. If not → a
  **pending invite** (`drive_invites`, 202) that converts to a grant the moment
  that email signs up (`claimInvitesForEmail`, upgrade-only). Owners see and
  cancel pending invites from the Manage page.
- **Share link** (`shares.token` → `/s/<token>`): `viewer`/`editor`, optionally
  priced + `listed` on the drive showcase. Free links convert to a grant via
  `POST /s/<token>/accept` (login required). Revoking a link
  (`DELETE /api/drives/:id/shares/:shareId`) 404s the token but leaves grants
  already accepted through it intact.
- **Payment** (paid share, x402): a settled payment resolves the payer to an
  account (`resolveAccountForWallet`) and writes the grant + an append-only
  `payment_receipts` row. See `README.md` and `docs/*payment*`.

## What a member sees on entry

`entryView` decides where a non-owner lands:

- **root** — owner, or a grant at `""`: enters the drive root.
- **single** — exactly one accessible subtree: enters that path directly.
- **multi** — several unrelated grants: a **synthetic root** lists those grant
  paths as the top level (the real drive root would 403).

Navigation, breadcrumbs and the file listing all stay within what the member's
grants cover; the server re-checks every API call regardless of the UI.

## Identity note

Identity is an **account** (`users` row); its id is the root that every drive,
grant, and receipt hangs off. An account is reached by **either** an
email+password credential **or** a wallet via SIWE (`POST /api/wallet/login`).

A **wallet-provisioned account** — minted for a wallet that paid or signed in
(`resolveAccountForWallet`) — is **self-custodial**: losing the wallet loses the
account, by design. aindrive does not custody or recover wallet keys (that is
the wallet provider's job); a user may *optionally* attach a real email later
for an alternative login. A wallet linked to an existing email account is a
login credential **only** after the owner opts in while authenticated
(`account_wallets.login_enabled`); a payment/attribution link never is. A
verified wallet *payment* may still bootstrap/attribute an account (a trusted
facilitator attests the payer controls the key), but **payment is not
authentication** — login (SIWE, origin+nonce bound) and payment (x402) are
separate proofs.
