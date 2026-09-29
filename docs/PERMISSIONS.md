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
- the remote-MCP **sale tools** (account grant `drives:sell`: share links,
  payout wallets, token policy, receipts — `app/mcp/README.md`);
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
  that email signs up (`claimInvitesForEmail`, upgrade-only) — by the emailed
  code, or through AIN SSO with that AIN-verified address. Owners see and
  cancel pending invites from the Manage page.
- **Share link** (`shares.token` → `/s/<token>`): `viewer`/`editor`, optionally
  priced + `listed` on the drive showcase. Free links convert to a grant via
  `POST /s/<token>/accept` (login required). Revoking a link
  (`DELETE /api/drives/:id/shares/:shareId`) 404s the token but leaves grants
  already accepted through it intact.
- **Payment** (paid share, x402): a settled payment resolves the payer to an
  account (`resolveAccountForWallet`) and writes the grant + an append-only
  `payment_receipts` row. A relaying app may name the buyer's account instead
  by sending its account-grant token (`Authorization: Bearer aind_aat_…`).
  See `README.md` and `docs/*payment*`.

## Organizations (AIN SSO)

Where AIN SSO is configured, a drive's **creator** can share the whole drive
with an **organization** — an AIN SSO organization as the provisioning adapter
recorded it (`sso_memberships`: issuer + org id, with its slug and name). It is
the fourth way in, and the only one that does **not** write a grant: the role
is computed on every check, so AIN SSO ending a membership ends the access in
the same moment. Code: `web/lib/orgs.js` (DB), `web/lib/org-policy.js` (pure
rules); table `drive_org_shares(drive_id, issuer, org_id, role)`.

- **Who gets what.** Every person whose membership in that organization is
  `active` — all of their rows for it; one suspended/deprovisioned row wins —
  gets the share's role, `viewer` (default) or `editor`, on the whole drive
  (`path=""`). Never `owner`. It comes out of the same functions every surface
  already asks (`resolveRoleByUser`/`resolveAccess`, `entryView`, the doc
  socket's `resolveRole`, the MCP scope ceiling `maxRoleInDrive`) and is merged
  with the person's own grants by rank, so it never lowers one.
- **When it stops.** The member is suspended or offboarded (the adapter push;
  their sessions end too); the drive's creator is no longer an active member
  of that organization (the share pauses for everyone, and resumes if they are
  reactivated — it was their share to the org as a member); the creator
  unshares it; or the AIN SSO adapter is not configured for that issuer (a
  membership nobody keeps current grants nothing). Open collaborative editors
  are re-checked when a share is lowered or removed and after each adapter push
  (for every organization of the pushed subject — a rolled-back legacy mapping
  moves them all, and closes the unlinked account's sockets even when nobody
  signed in through the link). A socket that got its access through an
  organization is also checked before every frame it sends and swept every
  5 s (`dochub.js revalidateOrgPeers`), so a change made outside the server
  process — the operator script — stops its edits at once and its reading
  within seconds.
- **Live, never written down.** Nothing reached through an organization
  becomes a `drive_members` row, for the member or anyone else, because a row
  outlives the membership: share links are minted only on the caller's **own**
  grants (an org editor gets 403 — ask the drive's owner); an editor's
  `GET /shares` lists only their own links plus others' paid viewer links (the
  sale badges) — never someone else's free link or an editor link, whose token
  is the grant; accepting a paid link the organization already covers lets the
  member in without writing a row; a purchase records what was bought, merged
  with the buyer's own grants only (`access.ts personalRoleByUser`).
- **A ceiling like any grant.** An org viewer is a bare viewer: the paid
  carve-out applies, no writes, no share links. An org editor edits files;
  links, listing, members and invites stay with personal grants and owners.
  Members count as "related" for the showcase (list and Buy,
  `isRelatedToDrive`). A member can't `leave` an organization's drive (409) —
  the creator unshares it.
- **Who may share.** The creator only (co-owners see the share read-only),
  with an organization they are an active member of, **as its admin** (AIN SSO
  app role `admin`/`owner`). AIN SSO assigns aindrive with app role `member`
  unless an admin sets otherwise, so the operator can also allow named people:
  `AINDRIVE_ORG_SHARE_ALLOWLIST=<org slug|id>:<aindrive user id|AIN subject>,…`
  (stable ids only, never an email). This is deliberately narrower than "any
  active member": publishing a drive to a whole company is an admin decision.
  A creator who is neither sees, on the Manage card, that only an org admin
  can and that the operator can add the drive.
  Unsharing is always allowed to the creator. The operator binds any drive by
  id and org slug with `web/scripts/org-drive.mjs` (`docs/DEPLOY.md`
  "Organization drives"). Every share, role change and unshare is recorded in
  `sso_audit` (`org_drive_shared`, `org_drive_role_changed`,
  `org_drive_unshared`; actor `user:<id>` or `operator`).
- **What members see.** The signed-in home lists each of their organizations
  first — its drives; "ComCom's shared drive is paused" while its creator is
  not an active member; or "No ComCom drive yet … ask your ComCom admin" (one
  line when their own drives follow, `org-policy.js orgSectionState`) — then
  their personal drives. The app (`mobile/`, also the Mac app) groups them
  under the organization's name and offers no "Leave" on them. An AIN sign-in to the home page lands on the
  organization's drive on the person's first sign-in and whenever they own no
  personal drive (with one organization drive; several → the home page).

## What a member sees on entry

`entryView` (membership) plus a stat of the path decide where a user lands —
`web/lib/drive-location.ts`. A grant may be a folder or a single file (a paid
file share grants the file itself):

- **root** — owner, or a grant at `""`: enters the drive root.
- **single folder grant** — enters that folder; the breadcrumb tops out there.
- **several grants, or one file grant** — a **grant listing** shows those grant
  paths as the top level (the real drive root would 403); a lone file grant
  opens in the viewer.

`?path` names what the user is looking at, folder or file. A file opens in the
viewer inside its folder, or inside the grant listing when the member can't list
that folder (a file bought on its own). An unreadable `?path` is a uniform hard
deny — never a redirect to the entry, which would make the response a path
oracle. Navigation and breadcrumbs stay within what the grants cover; the server
re-checks every API call regardless of the UI. A grant row or `?path` inside a
sale the member hasn't paid for shows locked, and opening it shows the paywall
(`PERMISSIONS_MATRIX.md` R-VIS-PAID-002).

## Identity note

Identity is an **account** (`users` row); its id is the root that every drive,
grant, and receipt hangs off. An account is reached by **either** an
email+password credential, **a Google account** (`POST /api/auth/google`: the account linked to that Google `sub` in `account_google`, or a new account; an existing account is **never** linked because its email matches — email addresses get reassigned — so that case is refused with `email_in_use`), **a wallet** via SIWE (`POST /api/wallet/login`), **or**, where configured, an **AIN account** via AIN SSO ("Continue with AIN": the account linked to the AIN `(issuer, sub)`, never matched by email; an existing account is connected once with a proof of it, or by AIN SSO's `legacyUserId` after aindrive attested it — the Google `sub` of a Google sign-in, or a company address aindrive verified by email code — never by an unverified email match; `web/lib/sso/README.md`).

An account that AIN SSO suspends (or offboards) from every organization it
belongs to cannot sign in on any path and its sessions end; its drives,
grants and personal tokens are kept. Suspension from one organization ends
only that organization's drives (above). An AIN-linked account cannot reset its
password by email.

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

A wallet the owner **signs in with** (login-enabled) is also their default
**payout** wallet: linking it or signing in with it sets it as the root payout
wallet of every drive they own that has none (`adoptOwnerPayoutWallet`), and new
drives start with it. Drives that already have a payout wallet keep theirs.

## Delegated reads

An agent can read **one file (or folder)** on a user's behalf without holding
the user's session: a product (ainteams, ainmem, …) asks AIN SSO for a
**resource delegation** (`ain-rdlg+jwt`, AIN SSO `wallet-and-delegation.md` §5)
naming the account (`sub`), this server (`aud`), the resource keys
(`https://<origin>#<driveId>#<fileId>`, the `fileId` of the shared-file list)
and the actions, bound to the agent's key (`cnf`). The agent presents it to
`GET /api/drives/:id/fs/read` or `fs/list` as `Authorization: Bearer …` with a
per-request proof of possession (`X-AIN-PoP`). aindrive then applies the
**three-check rule** (`web/lib/resource-delegation.ts`, matrix
`R-DLG-READ-001`):

1. **The user may.** `sub` must be linked to an account here
   (`sso_identities`), and that account must hold `viewer+` at the path *at the
   time of the call* — ownership or a `drive_members` grant, with the paid
   carve-out and the reserved `.aindrive/` subtree exactly as for the account
   itself. A delegation never widens what the account may do, and losing the
   grant (or the AIN membership) ends the delegated access at once.
2. **The grant names it.** The file's own key, or the key of an **ancestor
   folder** (up to the drive root — the only inheritance; no wildcards), with
   the action; the token is for this origin, unexpired and not revoked
   (revocation is asked of AIN SSO and cached for at most 60 s; when AIN SSO
   cannot be reached and nothing is cached, the read is refused, never
   allowed).
3. **Product context.** aindrive has no per-product rule for a read; `prd`
   and `agt` are informational. The caller is bound to the **key** in `cnf`,
   not to the agent's name — a proof signed by another key fails.

Only `read` and `list` are delegated today. A `write` or `invoke` action in the
grant authorises nothing: the write, delete, share and member routes do not
accept the token, and the agent protocols (MCP/A2A/AG-UI) refuse it by name.
Refusals use the cross-product error body (`auth_required`, `forbidden`,
`source_offline`, `temporary_failure`) and never echo the token.
