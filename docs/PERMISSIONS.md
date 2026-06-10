# Drive permissions model

How access works in an aindrive drive. The canonical logic is `web/lib/access-core.js`
(pure, tested) + `web/lib/access.ts` (DB-backed wrappers); this page is the map.

## Roles

A four-rung ladder (`ROLE_RANK`): `none` < `viewer` < `editor` < `owner`.

| Role | Can |
|------|-----|
| viewer | read & download files |
| editor | + upload, edit, delete files |
| owner | + manage members, links, sales, settings |

"Owner" is not only the drive creator: anyone holding the `owner` role via a
`drive_members` row is a co-owner. The **creator** is special in exactly one
way — they can't be removed (`canRemoveMember`).

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

Identity is the **email-login account**. Wallets are a payment instrument only,
never a login — a paid grant binds to the logged-in account (the share gate
requires sign-in before payment), or to a wallet-provisioned account that a
human can later reclaim by linking the wallet.
