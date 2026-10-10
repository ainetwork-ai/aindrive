# web/components — React surfaces for the drive web app

## Responsibility

The browser-side UI: the file-browser shell, file viewer/editors, the per-item
Share drawer, the owner Settings page, the paywall, folder chat, and the
design-system primitives in `ui/`. Server brokering, protocol types, and access
logic live elsewhere (`web/lib`, `web/shared`); components only render + call
`apiFetch`.

## IA rule (drives the file split)

**Create in context, audit in Settings.** Selling/inviting/linking is created on
an item via `share-dialog` (the right-docked Share *drawer*); the whole-drive
ledger — member roster, all links, sales, payment settings — is read/managed on
`drive-manage` (`/d/[id]/manage`). One concept is never split across a create
surface and a separate list surface. Rationale: `../../CLAUDE.md` (product
principles) + `../../docs/superpowers/specs/2026-06-11-ux-overhaul-design.md`.

## Files

Convention: `X.tsx` = stateful shell (owns state/effects/actions); `X-parts.tsx`
= pure presentational render fns receiving data+handlers; `X-utils.ts` = pure
helpers. Shells lazy-load heavy children via `next/dynamic`.

Browser shell:
- `drive-shell(.tsx/-parts)` — file browser: sidebar, header/breadcrumbs,
  grid+list, selection, sort/search, showcase section. Its location (listed
  folder + open file) is mirrored in `?path` and history state.
- `git-panel` — shown above the listing when the folder is a git repo
  (`GET git-meta` answers `exists:true`); the folder is the repo's **working
  copy** (`lib/git-paths.ts`). Top to bottom: branch + HEAD (+ `ainize.json`
  name/kind) + **Push N / Pull N** (vs the bare remote; Pull only when clean) ·
  clone URL + copy · legacy-layout hint · **Run** (the project's entry: manifest
  `entry`, else the root's first runnable file; shares `useRunner`, output right
  under the panel) · **Deployments** (ainize Projects read from the browser,
  `lib/ainize-projects.ts`: Vercel-style rows with status dot / sha / time /
  Inspect / Visit; silent on any failure; re-read when HEAD moves, polled while
  building) · recent commits (toggle; links to `/commit/<sha>` on repo pages) ·
  **Source Control** (editors; VS Code-like: Staged Changes / Changes rows with
  M A D U badges, click opens the file, +/− per row, Stage all, Discard with
  confirm) · commit box ("stage all & commit" checkbox when something is staged;
  a commit deploys nothing — Push does, via `POST git-sc`). git-meta lives in the
  shell (one fetch per folder, refetched after every action / a save). `urls`
  switches its links to the pretty form on repo pages.
- `git-site-parts` (server-renderable) + `git-site` (client) — the GitHub-like
  repo pages (`app/d/by-slug`, `lib/git-urls.ts`): `GitPageFrame` (`org / repo /
  path` breadcrumb, `RefSwitcher`, Code · Commits · Deployments tabs, read-only
  banner for a ref that is not the checked-out branch), `GitTreeTable`,
  `GitBlobView` (lines, Raw · History), `GitCommitList`, `GitCommitDetailView` +
  `GitPatch`, `GitDeploymentsPage`. The checked-out branch is not rendered here:
  it is `DriveShell` with the `git` prop (pretty URLs in the address bar,
  `org / repo` crumbs, ref bar), so editing keeps working there.
- `viewer` — the file viewer/editor. In a repo, **▶ Run** sits next to Save for a
  runnable file (`.py`/`.js`/`.mjs` or the manifest's `entry`): first click opens
  the manifest's `inputs` inline under the header, output streams under the editor
  (`useRunner`); while the buffer has unsaved edits the button reads **Save & Run**
  and saves first — the run route reads the working tree at click time. Text-by-
  name (`lib/text-kind.ts`) and a Range-request NUL sniff decide what opens as code
  (`Dockerfile`, `.gitignore`, extensionless files). `links` adds Raw · History.
- `run-output` — ▶ Run for `.py`/`.js`/`.mjs` rows inside such a folder:
  `useRunner` streams `POST run` (ainize) into one state per file
  (`lib/git-panel.ts` reducer); `RunActions` = Vercel-style inline links + status
  dot (grey pulsing running / green exit 0 / red failed / amber runner
  unavailable); `RunOutput` = the panel under the row (stdout/stderr, exit code,
  duration, "Open in ainize").
- `file-icons` — file-type → icon+color map (list rows + grid cards share it).
- `row-menu` — single source for the `⋮` dropdown + right-click context-menu
  items, with permission gates (sell/share owner-only; rename/delete = canManage).

Viewer / editors:
- `viewer(.tsx/-parts/-utils)` — media preview (Range-streamed) + text editing.
  Picks Monaco (code) or the rich-text editor (.md), owns the Yjs collab lifecycle.
- `editors/rich-text-editor` — collaborative WYSIWYG Markdown (TipTap + Yjs).

Sharing / payments:
- `share-dialog(.tsx/-sections)` — the Share **drawer**, one flat sheet of
  sections (people, link sharing, sell) — card chrome is for wide surfaces.
  Shows the drive token policy READ-ONLY (accepted-currency line + Settings
  link) — editing is in manage (create in context, audit in settings). Still
  exports `PaymentTokensEditor`, which `drive-manage` renders.
- `drive-manage` — owner Settings page, Members/Links/Sales/Payments left-rail.
  Owns the editable drive token-policy editor (`PaymentTokensEditor`) + payout.
- `drive-org-access` — the Members tab's "Organizations" card: share the whole
  drive with an AIN SSO organization, change its role, stop sharing
  (`/api/drives/:id/orgs`; rules in `lib/org-policy.js`).
- `share-gate(.tsx/-client)` — the `/s/[token]` paywall: x402 pay + Permit2
  approve. `-client` is the SSR-skipping wrapper.
- `x402-badges` / `x402-logo` — price badge + brand mark.
- `wallet-provider` — wagmi + RainbowKit + react-query provider tree (used by
  the `/s/[token]` and `/account/wallet` layouts).
- `wallet-auth-panel` — the `/login` wallet sign-in flow, `dynamic({ ssr:false })`
  to keep the web3 bundle off the email form's critical path. Two paths:
  "Sign in with Base" drives the Base connector directly with `wallet_connect`
  + `signInWithEthereum` (one popup does passkey + SIWE — see `lib/base-siwe.ts`
  for why two popups can't work); "Other wallets" opens the RainbowKit picker
  and chains connect straight into a `personal_sign` SIWE. Both POST
  /api/wallet/login.
- `use-wallet-link` — SIWE-link the connected wallet to the logged-in account,
  opting into wallet-login (POST /api/wallet/link); powers `/account/wallet`.
- `use-wallet-login` — SIWE re-login for a wallet that already has access
  (re-issues `aindrive_wallet` cookie; not a payment).

Sign-in (`/login`, `/signup`):
- `google-signin-button` — Google Identity Services → POST /api/auth/google; goes
  through AIN SSO (`ain_idp=google`) when AIN SSO is on with legacy login off.
- `sso-signin-button` / `sso-signup-link` — "Continue with AIN" / "Sign up with
  AIN" (`prompt=create`); render nothing unless AIN SSO is on.
- `use-sso-status` — one shared GET /api/auth/sso per page (`lib/sso/README.md`).

Agents:
- `folder-chat(.tsx/-parts)` — picks a drive agent and asks it over the folder.
- `create-agent-modal(.tsx/-parts)` — owner-only RAG-agent registration.

Design system:
- `ui/` — primitives, barrel-exported from `ui/index.ts`: Button, IconButton,
  Modal (`center` | `drawer` variant), Input, Select, Toggle, Menu, Tooltip,
  Avatar, Badge, Card, SectionCard, EmptyState, Skeleton, Field. Live gallery:
  `app/_dev/ui`.

## Contracts & invariants

- Heavy/interactive children (`Viewer`, `ShareDialog`, `CreateAgentModal`,
  `FolderChat`, `ShareGate`) are `dynamic({ ssr: false })` — they pull Monaco /
  wagmi and have no SSR value; importing eagerly breaks the route or bloats JS.
- Permission gating in the UI is convenience only; the server re-validates. Some
  GETs 403 for non-owners/co-owners — components fall back to defaults rather
  than failing (e.g. share-dialog drive-token read, manage payment settings).
- A `.md` file opens Monaco **or** the rich-text editor, never both — the two
  bind to different Y.Doc roots. Crossing them risks disk data loss (see the
  editor file header + `specs/2026-06-10-editor-framework-design.md`).
- `share-gate`: the Permit2 approve + allowance probe must run on the **token's**
  chain, not wherever the wallet is connected, or settlement silently fails.
- `row-menu` items are defined once (`rowMenuItems`) so dropdown and context menu
  stay identical.

## Gotchas

- Monaco is self-hosted from `/monaco/vs` (CSP blocks the jsdelivr CDN); assets
  are copied by `scripts/copy-monaco.mjs` on pre(dev|build).
- `file-icons` colors are intentionally NOT design tokens — they're a type
  taxonomy (like Badge's warning amber).
- No Textarea primitive yet; multiline controls hand-roll Input's chrome.

## Related

- Product / UX principles, IA rule, package layout: `../../CLAUDE.md`
- Permission & identity model: `../../docs/PERMISSIONS.md`
- In-flight UX/editor design specs: `../../docs/superpowers/specs/`
- Protocol/access/payment-token logic the shells call: `../lib`, `../shared`

`folder-chat.tsx` mounts `ain-ui/react`'s FolderChat keyed by drive and folder. It offers exact-folder local agents and, for owners, remote agents from the folder-chat API. Remote exports are confirmed per agent and folder. Context IDs remain scoped to each agent and folder; unmount cancels the active response. Local agents retain their JSON response API.

AIN-UI 0.2.1 fixes gallery tile sizing for long filenames and failed thumbnails. The producer displays counts from the current listing, with photos separate from folders and other files; these are not recursive totals.
