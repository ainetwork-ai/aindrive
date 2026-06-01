# Unified Shared Drive — Permission Model Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hackathon 3-table / 5-role permission model with a single account-keyed membership source and a 3-rung role ladder, unify shared-link visitors into one role-aware drive surface, and attach purchases to accounts (account↔wallet linking) as the basis for the copyright-sale layer.

**Architecture:** Identity is a single axis — the logged-in account; wallet is a linked payment instrument. Access is one source: `resolveAccess` reads `drive_members` (account+path→role) plus `drives.owner_id`. Purchase is a separate ledger (`payment_receipts`, account-keyed) that grants a membership as a side effect. Phases are dependency-ordered so each ships working software: roles foundation → login-first CONSUME → role-aware surface → account↔wallet + paid-settle-to-account → collapse `resolveAccess` to single source → member management → cleanup. `resolveAccess` is collapsed only after both free and paid flows write `drive_members`, so no flow breaks mid-sequence.

**Tech Stack:** Next.js 15 App Router, custom WebSocket server (`web/server.js`), better-sqlite3 + Drizzle (`web/drizzle/schema.ts`), vitest, zod, x402 (USDC paywall), siwe v3 + viem v2 (wallet linking), Y.js CRDT (live editing via `web/lib/dochub.js`).

**Spec:** `docs/superpowers/specs/2026-05-31-unified-shared-drive-design.md`

**Verification per task:** `npm --prefix web run typecheck` + `npm --prefix web test` + (for build-affecting changes) `npm --prefix web run build`, all green before the commit step.

---

## Phase 1: Roles & merge helper
Collapse the role ladder to `none<viewer<editor<owner` (commenter removed) and add a pure upgrade-only merge helper, then apply it to the members-POST upsert so re-inviting an existing member can never silently downgrade them. | Ships: a four-rung role model with `mergeRoleUpgradeOnly`, commenter purged from every zod enum / UI dropdown / type in scope, and a members upsert that only ever upgrades a role. | Depends on: none (first phase).

All commands are run from the repo root. Tests run via `npm --prefix web test` (which is `vitest run lib/`); a single file is targeted by passing its path. Typecheck is `npm --prefix web run typecheck`.

---

### Task 1.1: Collapse ROLE_RANK and add mergeRoleUpgradeOnly (pure helper, TDD)

**Files:**
- Modify: `web/lib/access-core.js:11-17` (ROLE_RANK), `web/lib/access-core.js:38` & `:66` (jsdoc role unions), end-of-file (new export)
- Modify: `web/lib/access-core.d.ts:3` (Role type), after `:13` (new declaration)
- Test: `web/lib/__tests__/access-core.test.ts:24-32` (ROLE_RANK assertions), `:53-61` & `:118-125` (commenter rows), new `mergeRoleUpgradeOnly` describe block

- [ ] **Step 1: Write the failing ROLE_RANK + mergeRoleUpgradeOnly tests.** In `web/lib/__tests__/access-core.test.ts`, first update the import on line 2 to include the new helper:

```ts
import { ROLE_RANK, atLeast, bestMatchingRole, pickFreeShareRole, mergeRoleUpgradeOnly, type Role } from "../access-core.js";
```

Then replace the `ROLE_RANK` describe block (lines 24-32) with the four-rung version (commenter assertion removed):

```ts
describe("ROLE_RANK", () => {
  it("orders roles strictly", () => {
    expect(ROLE_RANK.none).toBe(0);
    expect(ROLE_RANK.viewer).toBeGreaterThan(ROLE_RANK.none);
    expect(ROLE_RANK.editor).toBeGreaterThan(ROLE_RANK.viewer);
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.editor);
  });
  it("has no commenter rung", () => {
    expect((ROLE_RANK as Record<string, number>).commenter).toBeUndefined();
  });
});
```

- [ ] **Step 2: Add the mergeRoleUpgradeOnly describe block.** Append this new block immediately after the `ROLE_RANK` block (before `describe("atLeast", ...)`):

```ts
describe("mergeRoleUpgradeOnly", () => {
  it("returns incoming when it outranks current", () => {
    expect(mergeRoleUpgradeOnly("viewer", "editor")).toBe("editor");
    expect(mergeRoleUpgradeOnly("none", "viewer")).toBe("viewer");
    expect(mergeRoleUpgradeOnly("editor", "owner")).toBe("owner");
  });
  it("keeps current when incoming would downgrade", () => {
    expect(mergeRoleUpgradeOnly("owner", "viewer")).toBe("owner");
    expect(mergeRoleUpgradeOnly("editor", "viewer")).toBe("editor");
  });
  it("is a no-op when ranks are equal", () => {
    expect(mergeRoleUpgradeOnly("editor", "editor")).toBe("editor");
  });
  it("treats current 'none' as the floor", () => {
    expect(mergeRoleUpgradeOnly("none", "owner")).toBe("owner");
  });
});
```

- [ ] **Step 3: Strip commenter rows from existing bestMatchingRole / pickFreeShareRole cases.** In `bestMatchingRole` replace the commenter row (line 56) — the `docs` grant — with an `editor` grant so the longest-prefix-highest-role outcome is preserved (`docs/q1` exact `editor` still wins over a broader grant):

```ts
  it("returns the highest-rank role among matching ancestors", () => {
    const rows: Row[] = [
      { path: n(""), role: "viewer" },          // drive-wide viewer
      { path: n("docs"), role: "viewer" },       // covers target
      { path: n("docs/q1"), role: "editor" },    // exact cover
      { path: n("docs/q2"), role: "owner" },      // does NOT cover docs/q1
    ];
    expect(bestMatchingRole(rows, n("docs/q1"))).toBe("editor");
  });
```

In the `pickFreeShareRole` "picks the highest role" case (lines 118-125) replace the `commenter` row with a `viewer` row so `editor` is still the unambiguous winner:

```ts
  it("picks the highest role across multiple matching free shares", () => {
    const rows = [
      share({ path: n(""), role: "viewer" }),
      share({ path: n("docs"), role: "editor" }),
      share({ path: n("docs"), role: "viewer" }),
    ];
    expect(pickFreeShareRole(rows, "d1", n("docs/a.md"), NOW)).toBe("editor");
  });
```

- [ ] **Step 4: Run the test — expect FAIL.** Run: `npm --prefix web test lib/__tests__/access-core.test.ts`
  Expected: FAIL — `mergeRoleUpgradeOnly` is not exported (`mergeRoleUpgradeOnly is not a function`) and the "has no commenter rung" assertion fails because `ROLE_RANK.commenter` is still `2`.

- [ ] **Step 5: Collapse ROLE_RANK in access-core.js.** Replace lines 11-17:

```js
export const ROLE_RANK = Object.freeze({
  none: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
});
```

- [ ] **Step 6: Add the mergeRoleUpgradeOnly implementation.** Insert this function in `web/lib/access-core.js` after `pickFreeShareRole` (after line 78, before the `export { normalizePath, isAncestorOrSelf };` line):

```js
/**
 * Merge an incoming role into a current one WITHOUT ever downgrading.
 *
 * Used on the members upsert path: re-inviting / re-accepting a share for a
 * user who already has access must only ever raise their role. Returns
 * whichever of `current` / `incoming` has the higher ROLE_RANK; ties keep
 * `incoming` (same rank, same role).
 *
 * @param {"none"|"viewer"|"editor"|"owner"} current   existing role (may be "none")
 * @param {"viewer"|"editor"|"owner"} incoming          requested role (never "none")
 * @returns {"viewer"|"editor"|"owner"} the higher-ranked role
 */
export function mergeRoleUpgradeOnly(current, incoming) {
  return (ROLE_RANK[current] ?? 0) > (ROLE_RANK[incoming] ?? 0) ? current : incoming;
}
```

- [ ] **Step 7: Fix the jsdoc role unions.** In `bestMatchingRole`'s jsdoc (line 38) and `pickFreeShareRole`'s jsdoc (line 66), drop `"commenter"` from the `@returns` union so the docs match the new ladder. Both currently read:

```
 * @returns {string} one of "none" | "viewer" | "commenter" | "editor" | "owner"
```

Change each to:

```
 * @returns {string} one of "none" | "viewer" | "editor" | "owner"
```

- [ ] **Step 8: Update the type declarations in access-core.d.ts.** Change line 3:

```ts
export type Role = "viewer" | "editor" | "owner";
```

Then add the `mergeRoleUpgradeOnly` declaration after the `bestMatchingRole` declaration (after line 13):

```ts
export declare function mergeRoleUpgradeOnly(
  current: RoleOrNone,
  incoming: Role
): Role;
```

- [ ] **Step 9: Run the test — expect PASS.** Run: `npm --prefix web test lib/__tests__/access-core.test.ts`
  Expected: PASS (all describe blocks green, including the new `mergeRoleUpgradeOnly` block).

- [ ] **Step 10: Typecheck.** Run: `npm --prefix web run typecheck`
  Expected: PASS — no errors. (`Role` no longer includes `"commenter"`; this surfaces the downstream `.tsx`/route enum edits done in Tasks 1.2–1.3, so if this fails here, those tasks are not yet applied. If running tasks in order, expect failures pointing at `share-dialog-sections.tsx` / `share-dialog.tsx` until Task 1.3 lands — that is acceptable; the green-typecheck gate is the final commit step of Task 1.3.)

- [ ] **Step 11: Commit.** Run: `git add web/lib/access-core.js web/lib/access-core.d.ts web/lib/__tests__/access-core.test.ts && git commit -m "feat(access): collapse role ladder to viewer/editor/owner; add mergeRoleUpgradeOnly"`

---

### Task 1.2: Drop commenter from server zod role enums and apply upgrade-only merge to members POST

**Files:**
- Modify: `web/app/api/drives/[driveId]/members/route.ts:13` (Body role enum), `:1-8` (import), `:45-49` (upsert)
- Modify: `web/app/api/drives/[driveId]/shares/route.ts:15` (Body role enum)

- [ ] **Step 1: Narrow the members Body role enum.** In `web/app/api/drives/[driveId]/members/route.ts` change line 13:

```ts
  role: z.enum(["viewer", "editor", "owner"]),
```

- [ ] **Step 2: Import the merge helper into the members route.** The route imports from `@/lib/access`; `mergeRoleUpgradeOnly` lives in `@/lib/access-core`. Add a second import line after line 8 (`import { resolveRole, atLeast } from "@/lib/access";`):

```ts
import { mergeRoleUpgradeOnly } from "@/lib/access-core";
```

- [ ] **Step 3: Replace the blind-downgrade upsert with upgrade-only logic.** The current upsert (lines 45-49) does `ON CONFLICT ... DO UPDATE SET role = excluded.role`, which downgrades an existing higher role. SQLite exposes the pre-existing row's role as the bare column name and the proposed value as `excluded.role` inside the conflict clause, so the upgrade rule can be expressed entirely in SQL with a `CASE` over `ROLE_RANK`. Replace lines 44-49:

```ts
  const id = nanoid(12);
  // Upgrade-only upsert: re-inviting an existing member must never lower
  // their role (mergeRoleUpgradeOnly, expressed inline in SQL). The CASE
  // mirrors ROLE_RANK (none<viewer<editor<owner); on conflict we keep
  // whichever of the existing role / the requested role ranks higher.
  db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role =
      CASE
        WHEN (CASE drive_members.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
           > (CASE excluded.role       WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END)
        THEN drive_members.role
        ELSE excluded.role
      END
  `).run(id, driveId, invitee.id, body.data.path, body.data.role);
  return NextResponse.json({ ok: true });
```

Note: the import added in Step 2 documents the rule and is used by no other path in this file today; keep it as the canonical reference even though the merge is inlined in SQL (the pure helper is unit-tested in Task 1.1 and reused by the CONSUME route in Phase 2). If `npm --prefix web run typecheck` flags the import as unused under `noUnusedLocals`, drop the Step 2 import line and instead leave a comment above the upsert: `// upgrade-only merge — see mergeRoleUpgradeOnly in lib/access-core`.

- [ ] **Step 4: Narrow the shares Body role enum.** In `web/app/api/drives/[driveId]/shares/route.ts` change line 15:

```ts
  role: z.enum(["viewer", "editor"]),
```

(The shares enum never offered `owner`; it offered `viewer | commenter | editor`. Dropping `commenter` leaves `viewer | editor`, matching the share-creation UI which only renders Viewer/Editor.)

- [ ] **Step 5: Typecheck.** Run: `npm --prefix web run typecheck`
  Expected: PASS for both route files (the `.tsx` dropdown is fixed in Task 1.3; if running in order this may still flag `share-dialog-sections.tsx` until Task 1.3 — that is expected).

- [ ] **Step 6: Re-run the lib tests to confirm nothing regressed.** Run: `npm --prefix web test`
  Expected: PASS (full `lib/` suite green).

- [ ] **Step 7: Commit.** Run: `git add "web/app/api/drives/[driveId]/members/route.ts" "web/app/api/drives/[driveId]/shares/route.ts" && git commit -m "feat(access): drop commenter from member/share role enums; upgrade-only members upsert"`

---

### Task 1.3: Remove commenter from the share-dialog UI dropdowns and types

**Files:**
- Modify: `web/components/share-dialog-sections.tsx:18-26` (`Access` type), `:194-205` (`WalletAccessSection` prop types), `:218-226` (the wallet role `<select>`)
- Modify: `web/components/share-dialog.tsx:25` (`walletRole` state type)

- [ ] **Step 1: Narrow the `Access` type role union.** In `web/components/share-dialog-sections.tsx` change line 22 (inside the `Access` type):

```ts
  role: "viewer" | "editor";
```

(Wallet-access rows only ever carried viewer/commenter/editor; the wallet-access feature is removed wholesale in Phase 5/7, but until then its role surface must match the four-rung ladder.)

- [ ] **Step 2: Narrow the `WalletAccessSection` prop types.** Change the `walletRole` / `setWalletRole` types in the component signature (lines 199-200):

```tsx
  walletRole: "viewer" | "editor";
  setWalletRole: (v: "viewer" | "editor") => void;
```

- [ ] **Step 3: Remove the Commenter option and fix the select cast.** Replace the wallet role `<select>` (lines 218-226) so it offers only Viewer/Editor and casts to the narrowed union:

```tsx
        <select
          value={walletRole}
          onChange={(e) => setWalletRole(e.target.value as "viewer" | "editor")}
          className="rounded-lg border border-drive-border px-2 text-sm"
        >
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
```

- [ ] **Step 4: Narrow the `walletRole` state in the parent shell.** In `web/components/share-dialog.tsx` change line 25:

```tsx
  const [walletRole, setWalletRole] = useState<"viewer" | "editor">("viewer");
```

- [ ] **Step 5: Typecheck — expect PASS (clean).** Run: `npm --prefix web run typecheck`
  Expected: PASS with no errors. This is the gate: every `"commenter"` literal in scope is gone and the `Role`/state/prop types all line up, so `tsc --noEmit` is fully green across the touched `.ts`/`.tsx` files.

- [ ] **Step 6: Confirm no stray commenter literals remain in scope.** Run: `git grep -n commenter -- web/lib web/components "web/app/api/drives/[driveId]/members/route.ts" "web/app/api/drives/[driveId]/shares/route.ts"`
  Expected: no output (empty). Note: `web/app/api/drives/[driveId]/access/route.ts` still contains a `commenter` zod literal — that is the wallet-access route, out of Phase 1 scope; it is removed when the wallet branch is deleted in Phase 5/7. Leave it untouched.

- [ ] **Step 7: Build sanity check.** Run: `npm --prefix web run build`
  Expected: PASS — Next.js build completes (the narrowed unions and removed option compile cleanly).

- [ ] **Step 8: Commit.** Run: `git add web/components/share-dialog-sections.tsx web/components/share-dialog.tsx && git commit -m "feat(ui): remove commenter from share-dialog role dropdowns and types"`

---

**Migrations note:** No schema change in Phase 1, so no migration command runs here. (Migration mechanics — `drizzle-kit` vs runtime table creation — are discovered and exercised starting in Phase 4 / Phase 5 where `account_wallets` is added and `folder_access` is dropped.) The `drive_members.role` column already stores free-form text, so existing rows holding the literal `"commenter"` are not rejected by the DB; they simply rank as an unknown role (`ROLE_RANK[...] ?? 0` → `0`, treated as `none`) until re-granted. This is acceptable for the lossy demo data per the contract; no backfill is required.

**Out of scope for Phase 1 (cross-ref):** `resolveAccess` / `resolveRoleByUser` signatures and the `resolveRole`→`resolveRoleByUser` rename are Phase 5; the `access/route.ts` wallet enum and `PaidContentView` are Phase 7; `account_wallets` is Phase 4.

---

## Phase 2: Login-first share entry (CONSUME + next wiring)

Turn share-link entry into an authenticated flow: visitors log in first, then a new POST `/api/s/[token]/accept` route writes an upgrade-only `drive_members` row and the client redirects into the real drive at the share path. | Ships: opening `/s/<token>` while logged out routes through `/login?next=/s/<token>` (signup forwards `next` too); after auth, free shares are consumed into a persistent `drive_members` grant and land the user at `/d/<driveId>?path=<share.path>`; paid shares still pay via the existing x402 GET, then also consume. | Depends on: Phase 1 (`ROLE_RANK` without `commenter`, `mergeRoleUpgradeOnly`, `Role`/`RoleOrNone` in `web/lib/access-core.js`; `resolveRoleByUser` in `web/lib/access.ts`).

Note on migrations: tables are created at runtime by `CREATE TABLE IF NOT EXISTS` in `web/lib/db.js` (the `drive_members` block already matches the target shape — `UNIQUE(drive_id, user_id, path)`). There is no `drizzle-kit push`/`migrate` script in `web/package.json` and `web/drizzle/migrations/` is empty, so this phase adds NO migration step; the CONSUME route writes into the existing `drive_members` table.

---

### Task 2.1: CONSUME route — `POST /api/s/[token]/accept`

Creates the authenticated consume endpoint. Logged-in caller; validates the share like the existing GET; for paid shares with no covering grant returns 402 (pay via GET first); owner is a no-op; otherwise upserts an upgrade-only `drive_members` row using `mergeRoleUpgradeOnly`.

**Files:**
- Create: `web/app/api/s/[token]/accept/route.ts`
- Reference (read-only): `web/app/api/s/[token]/route.ts:31-44` (share lookup), `web/app/api/drives/[driveId]/members/route.ts:44-49` (drive_members upsert), `web/lib/access.ts:12-30` (`resolveRoleByUser`)
- Test: `web/lib/__tests__/share-consume.test.ts` (pure-logic guard for the upgrade-only decision; the route's DB/cookie deps are not unit-tested here, mirroring that the repo only has pure-logic tests under `lib/`)

Steps:

- [ ] **Step 1: Write the upgrade-only decision test (failing).** This locks the contract rule "CONSUME never downgrades" against `mergeRoleUpgradeOnly` from Phase 1. Create `web/lib/__tests__/share-consume.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeRoleUpgradeOnly } from "../access-core.js";

// CONSUME upserts drive_members(user, share.path, share.role) UPGRADE-ONLY:
// the persisted role is mergeRoleUpgradeOnly(existingRow?.role ?? "none", share.role).
describe("share CONSUME — upgrade-only role merge", () => {
  it("grants the share role when the caller has no existing row", () => {
    expect(mergeRoleUpgradeOnly("none", "viewer")).toBe("viewer");
    expect(mergeRoleUpgradeOnly("none", "editor")).toBe("editor");
  });

  it("upgrades a lower existing role to the share role", () => {
    expect(mergeRoleUpgradeOnly("viewer", "editor")).toBe("editor");
  });

  it("never downgrades a higher existing role", () => {
    expect(mergeRoleUpgradeOnly("editor", "viewer")).toBe("editor");
    expect(mergeRoleUpgradeOnly("owner", "viewer")).toBe("owner");
    expect(mergeRoleUpgradeOnly("owner", "editor")).toBe("owner");
  });

  it("is a no-op when roles are equal", () => {
    expect(mergeRoleUpgradeOnly("editor", "editor")).toBe("editor");
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL only if Phase 1 helper is missing, else PASS.** Run: `npm --prefix web test lib/__tests__/share-consume.test.ts`. Expected: PASS (Phase 1 already shipped `mergeRoleUpgradeOnly`). If it FAILs with "mergeRoleUpgradeOnly is not a function", Phase 1 is not applied in this worktree — stop and apply Phase 1 first.

- [ ] **Step 3: Create the route file with imports + share lookup.** Mirror the lookup shape from `web/app/api/s/[token]/route.ts:34-44`. Create `web/app/api/s/[token]/accept/route.ts`:

```ts
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { resolveRoleByUser, type Role } from "@/lib/access";
import { mergeRoleUpgradeOnly, atLeast } from "@/lib/access-core.js";

type ShareRow = {
  id: string;
  drive_id: string;
  path: string;
  role: Role;
  expires_at: string | null;
  price_usdc: number | null;
  owner_id: string;
};

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Auth is mandatory for CONSUME — anonymous link-only access is gone.
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const share = db.prepare(`
    SELECT s.id, s.drive_id, s.path, s.role, s.expires_at, s.price_usdc, d.owner_id
    FROM shares s JOIN drives d ON d.id = s.drive_id
    WHERE s.token = ?
  `).get(token) as ShareRow | undefined;

  if (!share) return NextResponse.json({ error: "share not found" }, { status: 404 });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return NextResponse.json({ error: "share expired" }, { status: 410 });
  }

  // Drive creator already has authority everywhere — nothing to persist.
  if (user.id === share.owner_id) {
    return NextResponse.json({ driveId: share.drive_id, path: share.path });
  }

  // Paid share: CONSUME does not settle payment. The caller must already
  // hold a covering grant (written by the paid GET flow). Without one,
  // bounce them back to pay via GET /api/s/[token].
  if (share.price_usdc) {
    const role = resolveRoleByUser(share.drive_id, user.id, share.path);
    if (!atLeast(role, "viewer")) {
      return NextResponse.json({ error: "payment required" }, { status: 402 });
    }
  }

  // Free share (or paid-and-already-covered): upsert an upgrade-only member row.
  const existing = db.prepare(
    "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
  ).get(share.drive_id, user.id, share.path) as { role: Role } | undefined;
  const nextRole = mergeRoleUpgradeOnly(existing?.role ?? "none", share.role);

  db.prepare(`
    INSERT INTO drive_members (id, drive_id, user_id, path, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role
  `).run(nanoid(12), share.drive_id, user.id, share.path, nextRole);

  return NextResponse.json({ driveId: share.drive_id, path: share.path });
}
```

- [ ] **Step 4: Typecheck.** Run: `npm --prefix web run typecheck`. Expected: PASS (no `tsc --noEmit` errors). Confirms imports resolve — `mergeRoleUpgradeOnly`/`atLeast` from `@/lib/access-core.js`, `resolveRoleByUser`/`Role` from `@/lib/access`, `db`/`getUser` from their modules.

- [ ] **Step 5: Run the pure-logic test again + the full lib suite.** Run: `npm --prefix web test lib/__tests__/share-consume.test.ts`. Expected: PASS. Then run: `npm --prefix web test`. Expected: PASS (all `lib/` tests green; the new file added no regressions).

- [ ] **Step 6: Commit.**
```
git add web/app/api/s/[token]/accept/route.ts web/lib/__tests__/share-consume.test.ts
git commit -m "$(cat <<'EOF'
feat(web): add POST /api/s/[token]/accept CONSUME route

Logged-in callers consume a share into an upgrade-only drive_members row
(mergeRoleUpgradeOnly). Owner is a no-op; paid shares without a covering
grant return 402 (pay via GET first).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2: signup honors `?next` with open-redirect guard

`web/app/signup/page.tsx` hardcodes `router.push("/")`. Make it read `?next` and redirect there after signup, reusing the exact guard already proven in `web/app/login/page.tsx:10` (must start with a single `/`). `useSearchParams` requires a Suspense boundary in Next 15 App Router, so wrap the form like `login/page.tsx` already does.

**Files:**
- Modify: `web/app/signup/page.tsx:1-50` (whole file — restructure into a Suspense-wrapped inner form, mirroring `login/page.tsx`)

Steps:

- [ ] **Step 1: Add `useSearchParams` + `Suspense` imports.** In `web/app/signup/page.tsx`, replace the top imports:

```tsx
"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
```

- [ ] **Step 2: Rename the component to an inner `SignupForm` and compute `safeNext`.** Replace the `export default function SignupPage() {` line and its body opener with the inner form that reads `next`. Change:

```tsx
export default function SignupPage() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
```
to:
```tsx
function SignupForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next");
  // Open-redirect guard: only same-origin paths ("/x"), never "//evil.com".
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
```

- [ ] **Step 3: Redirect to `safeNext` instead of `/`.** In the submit handler, change `router.push("/");` to:

```tsx
    router.push(safeNext);
```

- [ ] **Step 4: Forward `next` on the "Sign in" link and unwrap the form's `<main>`.** The inner `SignupForm` should return just the `<form>` (drop the outer `<main>` wrapper from it, like `LoginForm` does). Change the form's "Sign in" link to forward `next`, and make the closing tags end at `</form>`. Replace:

```tsx
        <p className="mt-4 text-sm text-drive-muted text-center">
          Already have an account? <Link className="text-drive-accent hover:underline" href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  );
}
```
with:
```tsx
        <p className="mt-4 text-sm text-drive-muted text-center">
          Already have an account?{" "}
          <Link
            className="text-drive-accent hover:underline"
            href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          >
            Sign in
          </Link>
        </p>
      </form>
  );
}
```
Also remove the now-orphaned `<main ...>` opener that wrapped the form. Change:
```tsx
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
```
to:
```tsx
  return (
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
```

- [ ] **Step 5: Add the Suspense-wrapped default export.** Append, mirroring `login/page.tsx:46-54`:

```tsx
export default function SignupPage() {
  return (
    <main className="min-h-screen min-h-[100dvh] flex items-center justify-center px-6">
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
    </main>
  );
}
```

- [ ] **Step 6: Typecheck.** Run: `npm --prefix web run typecheck`. Expected: PASS.

- [ ] **Step 7: Commit.**
```
git add web/app/signup/page.tsx
git commit -m "$(cat <<'EOF'
feat(web): signup honors ?next with open-redirect guard

Reads ?next (single-slash guard, same as login), redirects there after
signup, and forwards next to the login link. Wraps the form in Suspense
for useSearchParams (Next 15 App Router).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: login link forwards `?next`

`web/app/login/page.tsx` already honors `next` for its own redirect (`safeNext`, line 10/24), but its "Create an account" link drops it. Forward `next` to `/signup` so a visitor bouncing between the two screens keeps their destination.

**Files:**
- Modify: `web/app/login/page.tsx:39-41` (the "Create an account" link)

Steps:

- [ ] **Step 1: Forward `next` on the signup link.** Replace:

```tsx
      <p className="mt-4 text-sm text-drive-muted text-center">
        New here? <Link className="text-drive-accent hover:underline" href="/signup">Create an account</Link>
      </p>
```
with:
```tsx
      <p className="mt-4 text-sm text-drive-muted text-center">
        New here?{" "}
        <Link
          className="text-drive-accent hover:underline"
          href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
        >
          Create an account
        </Link>
      </p>
```
(`next` is already in scope from `web/app/login/page.tsx:9`.)

- [ ] **Step 2: Typecheck.** Run: `npm --prefix web run typecheck`. Expected: PASS.

- [ ] **Step 3: Commit.**
```
git add web/app/login/page.tsx
git commit -m "$(cat <<'EOF'
feat(web): login forwards ?next to signup link

Keeps the share-entry destination intact when a visitor switches from
login to signup.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.4: ShareGate — login-first entry + client redirect into the drive

`web/components/share-gate.tsx` is a client component (rendered via `share-gate-client.tsx`'s `ssr:false` dynamic import). Today, on `ok` state it renders `PaidContentView` in place. Rewire it: if the GET returns 401 (not logged in), send the visitor to `/login?next=/s/<token>`; on `ok`, POST to `/api/s/[token]/accept` and `router.replace("/d/<driveId>?path=<path>")`. Keep the paywall UI + `pay()`; after a successful `pay()`, also call `accept`. Do NOT delete `PaidContentView` (Phase 7) — just stop routing to it.

**Files:**
- Modify: `web/components/share-gate.tsx:1-140` (imports, `State` type, `check()`, `pay()`, the `ok`-state branch; add an `accept()` helper and `useRouter`)

Steps:

- [ ] **Step 1: Add router + drop the now-unused `PaidContentView` import.** Replace the import block at `web/components/share-gate.tsx:1-9`:

```tsx
"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useWalletClient } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { wrapFetchWithPayment } from "x402-fetch";
import { toast } from "sonner";
import { Lock, Loader2 } from "lucide-react";
```
(Removes the `DriveShell` and `PaidContentView` imports — neither is rendered after this phase. `PaidContentView` the file stays; Phase 7 deletes it.)

- [ ] **Step 2: Grab `router` in the component body.** Right after `const [paying, setPaying] = useState(false);` (line ~32), add:

```tsx
  const router = useRouter();
```

- [ ] **Step 3: Add an `accept()` helper that consumes the share then redirects.** Insert this function inside `ShareGate`, after the `check()` function (before the `useEffect`):

```tsx
  // Consume the share into a persistent drive_members grant, then hand the
  // visitor off to the real drive at the share's path (not root).
  async function accept(driveId: string, path: string) {
    const res = await fetch(`/api/s/${token}/accept`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error || "could not open share");
      setState("error");
      setData(body);
      return;
    }
    const body = (await res.json()) as { driveId: string; path: string };
    router.replace(`/d/${body.driveId}?path=${encodeURIComponent(body.path)}`);
  }
```

- [ ] **Step 4: Make `check()` redirect to login on 401 and auto-accept on ok.** Replace the `check()` body (`web/components/share-gate.tsx:36-44`):

```tsx
  async function check() {
    setState("loading");
    const res = await fetch(`/api/s/${token}`);
    // Login-first: an unauthenticated visitor is bounced to /login with a
    // next param so they return to this exact share after signing in.
    if (res.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(`/s/${token}`)}`);
      return;
    }
    const body = await res.json();
    setData(body);
    if (res.ok && "driveId" in body) {
      // Free share (or already-covered paid share): consume + redirect.
      await accept(body.driveId, body.path);
    } else if (res.status === 402) {
      setState("paywall");
    } else {
      setState("error");
    }
  }
```

- [ ] **Step 5: After `pay()` succeeds, consume the share too.** In `pay()`, replace the success branch (`web/components/share-gate.tsx:67-73`):

```tsx
      if (res.ok) {
        const okBody = body as { driveId: string; path: string };
        toast.success("Payment settled. Permanent access granted.");
        // Paid GET wrote the covering grant; CONSUME now upserts the
        // drive_members row and redirects into the drive.
        await accept(okBody.driveId, okBody.path);
      } else {
        toast.error(body.error || "payment failed");
      }
```

- [ ] **Step 6: Replace the `ok`-state render with a spinner (redirect is in flight).** The `ok` branch no longer renders `PaidContentView`; by the time `state` could be `"ok"` we are already navigating, so show a loader. Replace `web/components/share-gate.tsx:92-104`:

```tsx
  if (state === "ok") {
    // accept() has fired router.replace; render a spinner until navigation.
    return (
      <main className="min-h-screen min-h-[100dvh] flex items-center justify-center text-drive-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </main>
    );
  }
```
(Note: `check()`/`pay()` no longer call `setState("ok")` — they go straight to `accept()`. This branch is a defensive fallback; keep it so the state machine stays total. Leave the `paywall` branch and `Row` helper untouched.)

- [ ] **Step 7: Typecheck.** Run: `npm --prefix web run typecheck`. Expected: PASS. Confirms the removed `PaidContentView`/`DriveShell` imports are no longer referenced and `useRouter` is typed.

- [ ] **Step 8: Build (catches client-component / dynamic-import wiring the typecheck misses).** Run: `npm --prefix web run build`. Expected: build succeeds; `/s/[token]`, `/login`, `/signup` compile. (`share-gate-client.tsx`'s `ssr:false` dynamic import is unchanged, so the WagmiProvider hydration path is preserved.)

- [ ] **Step 9: Commit.**
```
git add web/components/share-gate.tsx
git commit -m "$(cat <<'EOF'
feat(web): login-first share entry in ShareGate

401 -> /login?next=/s/<token>. On ok or after pay(), POST
/api/s/[token]/accept then router.replace to /d/<driveId>?path=<path>.
Stops rendering PaidContentView (kept for Phase 7).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Role-aware scoped drive surface
Make `/d/[driveId]` evaluate access at the requested `?path` (not root) and render a single `DriveShell` that is correctly scoped and gated for sub-path members — so a viewer/editor granted a sub-folder sees their folder as the visual root, cannot navigate above their grant, and never calls owner-only endpoints; owner-only actions (Share, Sell, Manage) are gated to `role === "owner"`. | Ships: a member granted access to a sub-path (via a Phase 2 CONSUME) can open `/d/<driveId>?path=<grant>` and use the same drive UI as the owner, scoped to their grant; the former separate PaidContentView visitor experience is unified into this surface. | Depends on: Phase 1 (role ladder, `mergeRoleUpgradeOnly`), Phase 2 (CONSUME writes `drive_members` rows so sub-path members exist).

### Task 3.1: Scope the drive page to `?path`

Resolve role at the requested path instead of root, and pass `initialPath` + `initialRole` into `DriveShell`. Keep the existing "no access" message when the resolved role is `none`.

**Files:**
- Modify: `web/app/d/[driveId]/page.tsx:7-18`

- [ ] **Step 1: Widen the page signature to accept `searchParams`.**
  In Next 15 App Router both `params` and `searchParams` are Promises. Replace the function signature and `params` await:
  ```tsx
  export default async function DrivePage({
    params,
    searchParams,
  }: {
    params: Promise<{ driveId: string }>;
    searchParams: Promise<{ path?: string | string[] }>;
  }) {
    const { driveId } = await params;
    const sp = await searchParams;
    const rawPath = Array.isArray(sp.path) ? sp.path[0] : sp.path;
    const initialPath = rawPath ?? "";
  ```

- [ ] **Step 2: Resolve the role at `initialPath`, not `""`.**
  Replace the existing `const role = resolveRole(driveId, user.id, "");` line with the scoped lookup:
  ```tsx
    const role = resolveRole(driveId, user.id, initialPath);
  ```
  (`resolveRole` is the user-only alias kept verbatim in `web/lib/access.ts`; it delegates to `resolveRoleByUser`, which already prefix-matches `drive_members.path` against the target — so a row at the sub-path covers it.)

- [ ] **Step 3: Pass the scoped props into `DriveShell` and keep the no-access guard.**
  The full body after the `getDrive` check becomes:
  ```tsx
    const drive = getDrive(driveId);
    if (!drive) return <main className="p-10">Drive not found.</main>;
    const role = resolveRole(driveId, user.id, initialPath);
    if (!atLeast(role, "viewer")) {
      return <main className="p-10">You don’t have access to this drive. Ask the owner to invite you.</main>;
    }
    return (
      <DriveShell
        driveId={drive.id}
        driveName={drive.name}
        initialPath={initialPath}
        initialRole={role}
      />
    );
  ```
  Note: `role` here is `RoleOrNone`; after the `atLeast(role, "viewer")` guard it is narrowed to a real `Role`, but TS keeps the union — `DriveShell`'s `initialRole` prop is typed `string` (Step 3.2), so this passes without a cast.

- [ ] **Step 4: Typecheck.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS (no errors). The page now references `initialPath`/`initialRole` props that Task 3.2 adds; if 3.2 is not yet applied this step FAILS with `Property 'initialPath' does not exist on type ...` — apply 3.2 first or in the same commit.

- [ ] **Step 5: Commit.**
  Run: `git add web/app/d/[driveId]/page.tsx web/components/drive-shell.tsx && git commit -m "feat(drive): resolve access at ?path and pass scoped props to DriveShell"`
  (Commit together with Task 3.2 since the prop contract spans both files.)

### Task 3.2: Seed `DriveShell` state from props and clamp the root to `initialPath`

`DriveShell` must accept `initialPath`/`initialRole`, seed its `path`/`role` state from them (falling back to the URL only when a prop is absent, so the existing `share-gate` import stays buildable), clamp the breadcrumb so `initialPath` is the visual root, and gate `loadDrives()`/`loadShares()` behind owner so viewers don't hit owner-only endpoints.

**Files:**
- Modify: `web/components/drive-shell.tsx:23-30` (props + path seed)
- Modify: `web/components/drive-shell.tsx:56-58` (role seed)
- Modify: `web/components/drive-shell.tsx:85-87` (gate owner-only loaders)
- Modify: `web/components/drive-shell.tsx:98-105` (clamp breadcrumb)

- [ ] **Step 1: Extend the `Props` type and the function signature.**
  Replace lines 23-25:
  ```tsx
  type Props = {
    driveId: string;
    driveName: string;
    initialPath?: string;
    initialRole?: string;
  };

  export function DriveShell({ driveId, driveName, initialPath, initialRole }: Props) {
  ```
  `initialPath`/`initialRole` are optional with URL/`"viewer"` fallbacks (Steps 2-3) so the dangling `DriveShell` import in `web/components/share-gate.tsx` keeps compiling without change in this phase (its render path uses `PaidContentView`, not removed until Phase 7).

- [ ] **Step 2: Seed `path` from `initialPath` before falling back to the URL.**
  Replace the `useState(() => {...})` initializer at lines 26-30:
  ```tsx
    const [path, setPathState] = useState(() => {
      if (initialPath !== undefined) return initialPath;
      if (typeof window === "undefined") return "";
      const url = new URL(window.location.href);
      return url.searchParams.get("path") || "";
    });
  ```
  WHY: the server already resolved access at `initialPath`; seeding from it avoids a flash of the root listing (which a sub-path member would get a 401 on).

- [ ] **Step 3: Seed `role` from `initialRole`.**
  Replace line 58:
  ```tsx
    const [role, setRole] = useState<string>(initialRole ?? "viewer");
  ```
  (`load()` still overwrites `role` from `/api/drives/${driveId}/fs/list`'s response per-folder, so this is only the first-paint value — but it must be correct on first paint to gate owner-only loaders in Step 4 before `load()` returns.)

- [ ] **Step 4: Gate the owner-only loaders.**
  `/api/drives` and `/api/drives/${driveId}/shares` are owner-scoped (they 401/403 for a non-owner sub-path member). Replace the two effects at lines 86-87 so they only fire for owners; also short-circuit inside the callbacks so a stale closure can't fire them. Replace `loadDrives`/`loadShares` (lines 75-83) and their effects (lines 86-87):
  ```tsx
    const isOwner = role === "owner";

    const loadDrives = useCallback(async () => {
      if (!isOwner) return;
      const res = await apiFetch<{ drives: DriveSummary[] }>(`/api/drives`);
      if (res.ok) setDrives(res.data.drives);
    }, [isOwner]);

    const loadShares = useCallback(async () => {
      if (!isOwner) return;
      const res = await apiFetch<{ shares: ShareSummary[] }>(`/api/drives/${driveId}/shares`);
      if (res.ok) setShares(res.data.shares);
    }, [driveId, isOwner]);
  ```
  Leave the effects at lines 86-87 as-is (`useEffect(() => { loadDrives(); }, [loadDrives]);` / `useEffect(() => { loadShares(); }, [loadShares]);`) — they now no-op for non-owners and re-run if `role` is upgraded to owner. The `ShareDialog` `onClose` handler at line 251 also calls `loadShares()`, which now safely no-ops for non-owners.
  NOTE: `isOwner` must be declared before `loadDrives`/`loadShares`. It is defined here (replacing the standalone `const canEdit = ...` block is done in Step 5); keep `canEdit` too.

- [ ] **Step 5: Clamp the breadcrumb so `initialPath` is the visual root.**
  Replace the `canEdit`/`crumbs` block at lines 98-105. The crumb list must start at `initialPath` (labeled with the drive name) and only append segments *below* it, so a sub-path member cannot click up past their grant:
  ```tsx
    const canEdit = role === "editor" || role === "owner";
    const rootPath = initialPath ?? "";
    const crumbs = useMemo(() => {
      // Visual root is the member's grant (rootPath), not the drive root: a
      // sub-path member must not be able to navigate above what they were
      // granted. Only render segments at-or-below rootPath.
      const rel = rootPath && path.startsWith(rootPath + "/")
        ? path.slice(rootPath.length + 1)
        : path === rootPath ? "" : path;
      const parts = rel.split("/").filter(Boolean);
      const acc: { label: string; path: string }[] = [{ label: driveName, path: rootPath }];
      let cur = rootPath;
      for (const p of parts) { cur = cur ? `${cur}/${p}` : p; acc.push({ label: p, path: cur }); }
      return acc;
    }, [path, driveName, rootPath]);
  ```
  WHY the `rel` computation: when `rootPath` is `""` (owner at drive root) this reduces to the original behavior (`rel === path`). When `rootPath` is a sub-path, the first crumb points back to `rootPath` (the grant), never to `""`.

- [ ] **Step 6: Typecheck.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS. Confirms the new props, the `isOwner` gate, and the clamped `crumbs` all type-check; `share-gate.tsx` still compiles because the new props are optional.

- [ ] **Step 7: Build (catches client/server boundary + unused-var issues the tests don't).**
  Run: `npm --prefix web run build`
  Expected: build succeeds (`✓ Compiled successfully`). The drive page is now a dynamic route reading `searchParams`; Next must still compile it without error.

- [ ] **Step 8: Commit.**
  Run: `git add web/components/drive-shell.tsx web/app/d/[driveId]/page.tsx && git commit -m "feat(drive): scope DriveShell to initialPath/initialRole, clamp breadcrumb, gate owner-only loaders"`

### Task 3.3: Owner-gate the Share button and sell/manage actions (O2 owner-only)

`drive-shell-parts.tsx` currently shows the header **Share** button to everyone and the per-row ⋮ menu (which exposes **sell**/**share**) to anyone with `canEdit` (editor *or* owner). Per O2 these selling/sharing/management actions are owner-only. Gate them on a new `isOwner` prop threaded from the shell, leaving file-editing actions (rename/delete/upload) on `canEdit`.

**Files:**
- Modify: `web/components/drive-shell-parts.tsx:99-114` (`DriveHeader` props)
- Modify: `web/components/drive-shell-parts.tsx:179-185` (header Share button)
- Modify: `web/components/drive-shell-parts.tsx:212-223` (`FileTable` props)
- Modify: `web/components/drive-shell-parts.tsx:273-280` (row ⋮ menu)
- Modify: `web/components/drive-shell.tsx:198-224` (pass `isOwner` into header + table)

- [ ] **Step 1: Add `isOwner` to `DriveHeader`'s prop type and destructure.**
  In `DriveHeader` (line 99) add `isOwner` to the destructure and to the prop type:
  ```tsx
  export function DriveHeader({
    setSidebarOpen, crumbs, setPath, canEdit, onUpload, setShareOpen, path, role,
    setAgentModalOpen, setChatOpen, chatOpen, isOwner,
  }: {
    setSidebarOpen: (v: boolean) => void;
    crumbs: Crumb[];
    setPath: (next: string) => void;
    canEdit: boolean;
    onUpload: (files: FileList | null) => void;
    setShareOpen: (v: { path: string; focus?: "sell" } | null) => void;
    path: string;
    role: string;
    setAgentModalOpen: (v: boolean) => void;
    setChatOpen: (fn: (v: boolean) => boolean) => void;
    chatOpen: boolean;
    isOwner: boolean;
  }) {
  ```

- [ ] **Step 2: Owner-gate the header Share button.**
  Wrap the Share `<button>` (lines 179-185) in an `isOwner` guard:
  ```tsx
        {isOwner && (
          <button
            aria-label="Share"
            onClick={() => setShareOpen({ path })}
            className="flex items-center gap-2 rounded-full bg-drive-accent text-white px-2.5 sm:px-3 py-1.5 text-sm hover:bg-drive-accentHover"
          >
            <Share2 className="w-4 h-4" /> <span className="hidden sm:inline">Share</span>
          </button>
        )}
  ```
  (The existing Agent button at lines 186-195 is already `role === "owner"`-gated — leave it. Upload stays on `canEdit`; folder-chat stays ungated.)

- [ ] **Step 3: Add `isOwner` to `FileTable`'s prop type and destructure.**
  In `FileTable` (line 212):
  ```tsx
  export function FileTable({
    loading, err, entries, paidByPath, selected, setSelected, setPath, canEdit, onRowAction, isOwner,
  }: {
    loading: boolean;
    err: string | null;
    entries: DriveEntry[];
    paidByPath: Map<string, ShareSummary>;
    selected: DriveEntry | null;
    setSelected: (e: DriveEntry | null) => void;
    setPath: (next: string) => void;
    canEdit: boolean;
    onRowAction: (entry: DriveEntry, action: "sell" | "share" | "rename" | "delete") => void;
    isOwner: boolean;
  }) {
  ```

- [ ] **Step 4: Owner-gate the row ⋮ menu.**
  The `RowMenu` exposes sell/share (owner-only) alongside rename/delete (editor-ok). For this phase the whole menu is owner-only — render it for owners only; editors keep upload/rename via other surfaces. Replace lines 273-280:
  ```tsx
              <td className="py-3 sm:py-2 text-right whitespace-nowrap">
                {isOwner && (
                  <RowMenu
                    hasPaidShare={!!paid}
                    onAction={(a) => onRowAction(e, a)}
                  />
                )}
              </td>
  ```
  WHY whole-menu: `RowMenu` mixes sell/share (owner-only per O2) with rename/delete; splitting it is out of scope for this phase. Gating the menu on `isOwner` keeps the sell/manage surface owner-only without changing `RowMenu`'s internals.

- [ ] **Step 5: Thread `isOwner` from the shell into both children.**
  In `web/components/drive-shell.tsx`, `isOwner` already exists from Task 3.2 Step 4. Pass it to `DriveHeader` (after line 209, inside the `<DriveHeader ... />` props) and to `FileTable` (inside the `<FileTable ... />` props). The `DriveHeader` JSX becomes:
  ```tsx
          <DriveHeader
            setSidebarOpen={setSidebarOpen}
            crumbs={crumbs}
            setPath={setPath}
            canEdit={canEdit}
            onUpload={onUpload}
            setShareOpen={setShareOpen}
            path={path}
            role={role}
            setAgentModalOpen={setAgentModalOpen}
            setChatOpen={setChatOpen}
            chatOpen={chatOpen}
            isOwner={isOwner}
          />
  ```
  and the `FileTable` JSX becomes:
  ```tsx
              <FileTable
                loading={loading}
                err={err}
                entries={entries}
                paidByPath={paidByPath}
                selected={selected}
                setSelected={setSelected}
                setPath={setPath}
                canEdit={canEdit}
                onRowAction={onRowAction}
                isOwner={isOwner}
              />
  ```

- [ ] **Step 6: Typecheck.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS. Both children now require `isOwner` and the shell supplies it; a missing prop would surface here as `Property 'isOwner' is missing`.

- [ ] **Step 7: Build.**
  Run: `npm --prefix web run build`
  Expected: `✓ Compiled successfully`. Confirms the gated JSX (no dangling braces / unused imports) compiles in the production bundle.

- [ ] **Step 8: Run the lib test suite (regression guard — no behavior in `lib/` changed, but the contract requires it green).**
  Run: `npm --prefix web test`
  Expected: PASS (all existing `lib/` vitest suites green; this phase touches only `app/` + `components/`, which the suite does not cover, so nothing should newly fail).

- [ ] **Step 9: Commit.**
  Run: `git add web/components/drive-shell-parts.tsx web/components/drive-shell.tsx && git commit -m "feat(drive): owner-gate Share button and sell/manage row actions (O2)"`
```

The plan above is grounded in the actual files. Key real-code facts I verified and relied on:

- `web/app/d/[driveId]/page.tsx` currently calls `resolveRole(driveId, user.id, "")` at line 13 and renders `<DriveShell driveId={drive.id} driveName={drive.name} />` at line 17 with no path/role props.
- `web/lib/access.ts` exports `resolveRole` (line 120-122) as the user-only alias delegating to `resolveRoleByUser`, which prefix-matches `drive_members.path` via `bestMatchingRole` — so resolving at a sub-path works for sub-path member rows. No edit to `access.ts` is needed in this phase; it's in scope only as a read dependency.
- `DriveShell` (`web/components/drive-shell.tsx`) seeds `path` from the window URL (lines 26-30), defaults `role` to `"viewer"` (line 58), unconditionally calls `loadDrives()`/`loadShares()` (lines 86-87) against owner-only endpoints, and builds `crumbs` rooted at `""` (lines 99-105).
- `DriveShell` is also imported by `web/components/share-gate.tsx:8` but rendered only via `PaidContentView` in its actual branches — so making the new props optional keeps that import buildable (PaidContentView is not deleted until Phase 7, per scope).
- `drive-shell-parts.tsx`: the header Share button (lines 179-185) is ungated; the Agent button (186-195) is already `role === "owner"`-gated; the row `RowMenu` (273-280) is gated only on `canEdit`.
- Scripts confirmed in `web/package.json`: `test` = `vitest run lib/`, `typecheck` = `tsc --noEmit`, `build` = `next build`.

One cross-phase note for the orchestrator: the on-disk files still show the pre-Phase-1 ladder (`commenter` present in `access-core.js`/`.d.ts`/`access-core.test.ts`). Phase 3 does not touch the ladder and assumes Phase 1 already removed `commenter`; nothing in this section depends on `commenter` existing or being gone. No DB migration is involved in Phase 3.

---

## Phase 4: account↔wallet linking + paid settle to account

Introduce `account_wallets` as the bridge between EVM wallets and `users` rows, add `payment_receipts.account_id`, and rewrite the paid-share settle tail so every payment grants access via `drive_members` (UPGRADE-ONLY) keyed to an account — not just `folder_access` keyed to a wallet. | Ships: a logged-in user can SIWE-link a wallet (`POST /api/wallet/link`, 409 on conflict) and reclaim past anonymous receipts; a paid `/s/[token]` settle now resolves/creates an account, writes a `drive_members` grant, and stamps the receipt with `account_id` (while still writing the legacy `folder_access` row, removed in Phase 5). | Depends on: Phase 1 (`mergeRoleUpgradeOnly`, role ladder without `commenter`), Phase 2 (free CONSUME writes `drive_members`).

> Migration mechanism (discovered): `web/lib/db.js` creates every table at runtime via `handle.exec(CREATE TABLE IF NOT EXISTS ...)` plus an idempotent `ALTER TABLE ... ADD COLUMN` loop (better-sqlite3 has no `IF NOT EXISTS` for `ALTER`). `drizzle.config.ts` exists but **no `drizzle-kit` script is wired into `package.json`** and there is no `drizzle/migrations/` dir — `web/drizzle/schema.ts` is a hand-maintained mirror for typing/introspection, NOT the applied DDL. **Therefore schema changes in this phase are applied by editing `web/lib/db.js` (runtime DDL) AND mirroring into `web/drizzle/schema.ts` for Drizzle types.** No `drizzle-kit push` is run.

---

### Task 4.1: Add `account_wallets` table + `payment_receipts.account_id` (runtime DDL + schema mirror)

**Files:**
- Modify: `web/lib/db.js:23-110` (add `account_wallets` CREATE + indexes), `web/lib/db.js:111-124` (add `account_id` ALTER)
- Modify: `web/drizzle/schema.ts:141-165` (mirror `account_id`), `web/drizzle/schema.ts:165` (append `account_wallets`)
- Modify: `web/drizzle/schema.js` (mirror the same — `db.js` imports `../drizzle/schema.js`)

- [ ] **Step 1: Add `account_wallets` CREATE TABLE + indexes to the runtime DDL block in `web/lib/db.js`.** Insert immediately after the `payment_receipts` CREATE (`web/lib/db.js:100`, before the `CREATE INDEX` lines at 101):

```js
    CREATE TABLE IF NOT EXISTS account_wallets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL UNIQUE,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_via TEXT NOT NULL DEFAULT 'siwe',
      FOREIGN KEY(account_id) REFERENCES users(id) ON DELETE CASCADE
    );
```

  Then add two indexes alongside the existing `CREATE INDEX` lines (after `web/lib/db.js:109`, the `idx_payment_receipts_drive_wallet` line):

```js
    CREATE INDEX IF NOT EXISTS idx_account_wallets_account ON account_wallets(account_id);
    CREATE INDEX IF NOT EXISTS idx_payment_receipts_account ON payment_receipts(account_id);
```

- [ ] **Step 2: Add the `payment_receipts.account_id` column via the idempotent ALTER loop.** In the array at `web/lib/db.js:112-119`, append one entry (it must run for DBs that pre-date this table-create, since `CREATE TABLE IF NOT EXISTS` won't add a column to an existing table):

```js
    "ALTER TABLE payment_receipts ADD COLUMN account_id TEXT",
```

- [ ] **Step 3: Mirror `account_id` into `payment_receipts` in `web/drizzle/schema.ts`.** Add the column inside the `payment_receipts` table object (after `share_id` at `web/drizzle/schema.ts:156`):

```ts
    // NEW (Phase 4): the account this payment is attributed to. Nullable for
    // legacy/anonymous receipts settled before the payer linked a wallet;
    // POST /api/wallet/link backfills these on link.
    account_id: text("account_id").references(() => users.id),
```

- [ ] **Step 4: Append the `account_wallets` table to `web/drizzle/schema.ts`** (after the `payment_receipts` block, at end of file `web/drizzle/schema.ts:165`):

```ts
// ---------------------------------------------------------------------------
// account_wallets — links an EVM wallet to a users row. One wallet maps to at
// most one account (wallet_address UNIQUE); an account may link many wallets.
// This is how a paid x402 payer (identified only by wallet) gets a durable
// drive_members grant: settle resolves the wallet to an account through here.
// ---------------------------------------------------------------------------
export const account_wallets = sqliteTable(
  "account_wallets",
  {
    id: text("id").primaryKey(),
    account_id: text("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    wallet_address: text("wallet_address").notNull().unique(),
    linked_at: text("linked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    verified_via: text("verified_via").notNull().default("siwe"),
  },
  (t) => [index("idx_account_wallets_account").on(t.account_id)]
);
```

- [ ] **Step 5: Mirror both edits into `web/drizzle/schema.js`** (the JS twin imported by `db.js`). Make the identical `account_id` addition to `payment_receipts` and append the identical `account_wallets` definition, matching the existing JS style in that file (same `text(...).references(...)`, `index(...)`, `sql\`(datetime('now'))\`` calls).

- [ ] **Step 6: Verify the runtime DDL applies cleanly against a fresh DB.** Run: `AINDRIVE_DATA_DIR=$(mktemp -d) node -e "import('./web/lib/db.js').then(({db})=>{const cols=db.prepare('PRAGMA table_info(payment_receipts)').all().map(c=>c.name); console.log('account_id in receipts:', cols.includes('account_id')); console.log('account_wallets table:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='account_wallets'\").get()); })"`
  Expected output:
  ```
  account_id in receipts: true
  account_wallets table: { name: 'account_wallets' }
  ```

- [ ] **Step 7: Typecheck the schema mirror.** Run: `npm --prefix web run typecheck` Expected: PASS (no errors).

- [ ] **Step 8: Commit.** Run: `git add web/lib/db.js web/drizzle/schema.ts web/drizzle/schema.js && git commit -m "feat(db): add account_wallets table + payment_receipts.account_id"`

---

### Task 4.2: Add `linkWalletToAccount` helper to `web/lib/wallet.ts`

Centralize the link write + receipt reclaim so both `POST /api/wallet/link` (Task 4.3) and the settle tail (Task 4.4) share one implementation.

**Files:**
- Modify: `web/lib/wallet.ts:1-10` (imports), `web/lib/wallet.ts` (append helper)
- Test: `web/lib/__tests__/wallet-link.test.ts` (new)

- [ ] **Step 1: Write a failing test** for the link + reclaim behavior. Create `web/lib/__tests__/wallet-link.test.ts`. It drives a fresh in-memory-ish sqlite via a temp `AINDRIVE_DATA_DIR` so it exercises the real `db.js` DDL:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (module-level open()).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-walletlink-"));

const { db } = await import("../db.js");
const { linkWalletToAccount, WalletAlreadyLinkedError } = await import("../wallet.ts");

const WALLET = "0xABCdef0000000000000000000000000000000001";

describe("linkWalletToAccount", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("u1", "u1@example.com", "U1", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("u2", "u2@example.com", "U2", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("d1", "u1", "D1", "h", "s");
    // An anonymous receipt for WALLET, settled before any account linked it.
    db.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network) VALUES (?,?,?,?,?,?,?)"
    ).run("r1", "d1", "docs", WALLET.toLowerCase(), "0xtx1", 1.5, "base-sepolia");
  });

  it("inserts a lowercased link row and reclaims unattributed receipts", () => {
    const reclaimed = linkWalletToAccount("u1", WALLET, "siwe");
    expect(reclaimed).toBe(1);
    const row = db.prepare("SELECT account_id, wallet_address, verified_via FROM account_wallets WHERE wallet_address = ?")
      .get(WALLET.toLowerCase()) as { account_id: string; wallet_address: string; verified_via: string };
    expect(row).toMatchObject({ account_id: "u1", wallet_address: WALLET.toLowerCase(), verified_via: "siwe" });
    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE id = ?").get("r1") as { account_id: string };
    expect(receipt.account_id).toBe("u1");
  });

  it("throws WalletAlreadyLinkedError when the wallet is taken by another account", () => {
    expect(() => linkWalletToAccount("u2", WALLET, "siwe")).toThrow(WalletAlreadyLinkedError);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL** (helper not implemented). Run: `npm --prefix web test lib/__tests__/wallet-link.test.ts`
  Expected: FAIL — `linkWalletToAccount is not a function` / import error.

- [ ] **Step 3: Add imports to `web/lib/wallet.ts`.** At the top (after the existing `import { SiweMessage } from "siwe";` at `web/lib/wallet.ts:3`), add:

```ts
import { nanoid } from "nanoid";
import { db } from "./db";
```

- [ ] **Step 4: Append the helper + error class to `web/lib/wallet.ts`** (end of file, after `challengeMessage` at `web/lib/wallet.ts:90`):

```ts
/** Thrown when a wallet is already linked to a DIFFERENT account. */
export class WalletAlreadyLinkedError extends Error {
  constructor() {
    super("wallet already linked to another account");
    this.name = "WalletAlreadyLinkedError";
  }
}

/**
 * Link `wallet` to `accountId` and reclaim any unattributed payment_receipts
 * for that wallet (account_id IS NULL) by stamping them with `accountId`.
 *
 * The link row is the bridge that lets a paid x402 settle (which only knows a
 * wallet) resolve a durable account. wallet_address is stored lowercased and
 * is UNIQUE — re-linking the SAME wallet to the SAME account is a no-op (we
 * still reclaim receipts); linking to a DIFFERENT account throws.
 *
 * @returns number of receipts reclaimed
 */
export function linkWalletToAccount(accountId: string, wallet: string, verifiedVia: string): number {
  const addr = wallet.toLowerCase();
  const existing = db
    .prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
    .get(addr) as { account_id: string } | undefined;
  if (existing && existing.account_id !== accountId) throw new WalletAlreadyLinkedError();
  if (!existing) {
    db.prepare(
      "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?, ?, ?, ?)"
    ).run(nanoid(12), accountId, addr, verifiedVia);
  }
  const res = db
    .prepare("UPDATE payment_receipts SET account_id = ? WHERE wallet = ? AND account_id IS NULL")
    .run(accountId, addr);
  return res.changes;
}
```

- [ ] **Step 5: Run the test — expect PASS.** Run: `npm --prefix web test lib/__tests__/wallet-link.test.ts`
  Expected: PASS (2 passed).

- [ ] **Step 6: Typecheck.** Run: `npm --prefix web run typecheck` Expected: PASS.

- [ ] **Step 7: Commit.** Run: `git add web/lib/wallet.ts web/lib/__tests__/wallet-link.test.ts && git commit -m "feat(wallet): linkWalletToAccount helper with receipt reclaim"`

---

### Task 4.3: Create `POST /api/wallet/link` (SIWE verify, logged-in, 409 on conflict)

Mirrors the SIWE flow in `web/app/api/wallet/verify/route.ts` (nonce consume + `SiweMessage.verify`), but requires a logged-in session and writes an `account_wallets` link instead of a wallet cookie.

**Files:**
- Create: `web/app/api/wallet/link/route.ts`

- [ ] **Step 1: Create `web/app/api/wallet/link/route.ts`.** Reuse the rate-limit + nonce + SIWE pattern from the verify route, gate on `getUser()`, delegate the write to `linkWalletToAccount`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { SiweMessage } from "siwe";
import { consumeNonce, linkWalletToAccount, WalletAlreadyLinkedError } from "@/lib/wallet";
import { getUser } from "@/lib/session";
import { tryConsume, clientKey } from "@/lib/rate-limit";

const Body = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  signature: z.string().min(2),
  nonce: z.string().min(8),
  message: z.string().min(10),
});

export async function POST(req: Request) {
  const rl = tryConsume({ name: "wallet-link", key: clientKey(req, "wallet-link"), limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }

  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { address, signature, nonce, message } = body.data;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip")
    || "anon";
  if (!consumeNonce(ip, nonce)) {
    return NextResponse.json({ error: "unknown or expired nonce" }, { status: 400 });
  }

  let ok = false;
  try {
    const siweMsg = new SiweMessage(message);
    if (siweMsg.nonce !== nonce) {
      return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
    }
    if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "address mismatch" }, { status: 400 });
    }
    const result = await siweMsg.verify({ signature });
    ok = result.success;
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let reclaimed: number;
  try {
    reclaimed = linkWalletToAccount(user.id, address, "siwe");
  } catch (e) {
    if (e instanceof WalletAlreadyLinkedError) {
      return NextResponse.json({ error: "wallet already linked" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ ok: true, address: address.toLowerCase(), reclaimedReceipts: reclaimed });
}
```

- [ ] **Step 2: Typecheck.** Run: `npm --prefix web run typecheck` Expected: PASS.

- [ ] **Step 3: Build to confirm the route compiles under Next.** Run: `npm --prefix web run build` Expected: PASS — `/api/wallet/link` appears in the route manifest output.

- [ ] **Step 4: Commit.** Run: `git add "web/app/api/wallet/link/route.ts" && git commit -m "feat(api): POST /api/wallet/link — SIWE-link wallet to logged-in account"`

---

### Task 4.4: Add `resolveSettleAccount` helper (getUser → linked wallet → create placeholder account)

The settle tail needs to turn a payer wallet into an account id. Extract the resolution policy into a tested helper before wiring it into the route. Placeholder users follow the real `users` schema (`email` NOT NULL UNIQUE, `name` NOT NULL, `password_hash` NOT NULL) — we synthesize a deterministic-per-wallet email and an unusable bcrypt-shaped placeholder hash (never matches any password since `bcrypt.compare` against it requires the original input, which is random).

**Files:**
- Modify: `web/lib/wallet.ts:1-12` (imports), `web/lib/wallet.ts` (append helper)
- Test: `web/lib/__tests__/wallet-link.test.ts` (extend)

- [ ] **Step 1: Add a failing test** for the three resolution branches. Append to `web/lib/__tests__/wallet-link.test.ts`:

```ts
const { resolveAccountForWallet } = await import("../wallet.ts");

describe("resolveAccountForWallet", () => {
  it("returns the account already linked to the wallet", () => {
    // u1 ↔ WALLET linked in the earlier suite.
    const id = resolveAccountForWallet(WALLET);
    expect(id).toBe("u1");
  });

  it("creates a placeholder account + link for an unknown wallet", () => {
    const fresh = "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed";
    const id = resolveAccountForWallet(fresh);
    expect(id).toMatch(/^w_/); // placeholder id scheme
    const u = db.prepare("SELECT email, name, password_hash FROM users WHERE id = ?").get(id) as { email: string; name: string; password_hash: string };
    expect(u.email).toBe(`${fresh.toLowerCase()}@wallet.aindrive.local`);
    expect(u.password_hash.length).toBeGreaterThan(0);
    const link = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?").get(fresh.toLowerCase()) as { account_id: string };
    expect(link.account_id).toBe(id);
  });

  it("is idempotent for the same unknown wallet (no duplicate account)", () => {
    const fresh = "0x0101010101010101010101010101010101010101";
    const a = resolveAccountForWallet(fresh);
    const b = resolveAccountForWallet(fresh);
    expect(a).toBe(b);
    const count = db.prepare("SELECT count(*) c FROM account_wallets WHERE wallet_address = ?").get(fresh.toLowerCase()) as { c: number };
    expect(count.c).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `npm --prefix web test lib/__tests__/wallet-link.test.ts`
  Expected: FAIL — `resolveAccountForWallet is not a function`.

- [ ] **Step 3: Add the `bcryptjs` import to `web/lib/wallet.ts`** (after the `import { db } from "./db";` added in Task 4.2):

```ts
import bcrypt from "bcryptjs";
```

- [ ] **Step 4: Append `resolveAccountForWallet` to `web/lib/wallet.ts`** (after `linkWalletToAccount`):

```ts
/**
 * Resolve the account that a paid-share payer should be credited to:
 *   1. an account already linked to this wallet (account_wallets), else
 *   2. a freshly created wallet-only placeholder account + link.
 *
 * Wallet-only accounts have no real email/password: we mint a deterministic
 * `<wallet>@wallet.aindrive.local` email (satisfies the UNIQUE NOT NULL email
 * column without colliding with human signups) and an unusable random-input
 * bcrypt hash for password_hash (NOT NULL). The user can later claim the
 * account by linking the same wallet through POST /api/wallet/link while
 * logged in to their real account — that path throws on the wallet UNIQUE,
 * so claiming is a future-phase concern; here we only need a stable id.
 *
 * @returns the account id (never null)
 */
export function resolveAccountForWallet(wallet: string): string {
  const addr = wallet.toLowerCase();
  const linked = db
    .prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
    .get(addr) as { account_id: string } | undefined;
  if (linked) return linked.account_id;

  const id = "w_" + nanoid(10);
  const email = `${addr}@wallet.aindrive.local`;
  // Random input → resulting hash can never be reproduced by a login attempt.
  const placeholderHash = bcrypt.hashSync(nanoid(24), 10);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)"
  ).run(id, email, `wallet:${addr.slice(0, 10)}`, placeholderHash);
  db.prepare(
    "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?, ?, ?, ?)"
  ).run(nanoid(12), id, addr, "payment");
  return id;
}
```

- [ ] **Step 5: Run — expect PASS.** Run: `npm --prefix web test lib/__tests__/wallet-link.test.ts`
  Expected: PASS (5 passed).

- [ ] **Step 6: Typecheck.** Run: `npm --prefix web run typecheck` Expected: PASS.

- [ ] **Step 7: Commit.** Run: `git add web/lib/wallet.ts web/lib/__tests__/wallet-link.test.ts && git commit -m "feat(wallet): resolveAccountForWallet — link-or-create placeholder account"`

---

### Task 4.5: Rework the settle tail of `web/app/api/s/[token]/route.ts` to write `drive_members` keyed by account

After a successful settle, resolve the account (`getUser()` if logged in, else `resolveAccountForWallet(payerWallet)`), upsert a `drive_members` grant UPGRADE-ONLY via `mergeRoleUpgradeOnly`, and write the receipt **with** `account_id`. The legacy `folder_access` write stays (removed in Phase 5).

**Files:**
- Modify: `web/app/api/s/[token]/route.ts:9` (imports), `web/app/api/s/[token]/route.ts:231-280` (settle tail)

- [ ] **Step 1: Update imports in `web/app/api/s/[token]/route.ts`.** Replace the access/wallet imports (`web/app/api/s/[token]/route.ts:7,9`) so the route pulls in the account resolver, the merge helper, and `resolveRoleByUser` (used to read the member's current role for the upgrade check). Change:

```ts
import { getWallet, setWalletCookie } from "@/lib/wallet";
```
to:
```ts
import { getWallet, setWalletCookie, resolveAccountForWallet } from "@/lib/wallet";
```

  and change:
```ts
import { resolveRoleByWallet, atLeast, ROLE_RANK, type Role } from "@/lib/access";
```
to:
```ts
import { resolveRoleByWallet, resolveRoleByUser, atLeast, ROLE_RANK, type Role } from "@/lib/access";
import { mergeRoleUpgradeOnly } from "@/lib/access-core.js";
```

- [ ] **Step 2: Insert account resolution + `drive_members` upsert into the settle tail.** Immediately after the `folder_access` write/upgrade `try/catch` block (after `web/app/api/s/[token]/route.ts:260`, before the `payment_receipts` INSERT at 261), add:

```ts
  // Resolve the account this payment credits: a logged-in user wins; else the
  // wallet's linked account; else a freshly minted wallet-only account. This
  // is the Phase 4 pivot — paid access now lives in drive_members keyed by an
  // account, not only in folder_access keyed by a wallet (folder_access write
  // above is kept until Phase 5).
  const settleAccountId = user?.id ?? resolveAccountForWallet(payerWallet);

  // UPGRADE-ONLY grant: never downgrade a member who already holds a higher
  // role at this path (e.g. an owner-added editor paying through a viewer
  // share). mergeRoleUpgradeOnly returns the higher of current/incoming.
  const currentRole = resolveRoleByUser(share.drive_id, settleAccountId, share.path);
  const mergedRole = mergeRoleUpgradeOnly(currentRole, share.role);
  db.prepare(
    `INSERT INTO drive_members (id, drive_id, user_id, path, role)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(drive_id, user_id, path) DO UPDATE SET role = excluded.role`
  ).run(nanoid(12), share.drive_id, settleAccountId, share.path, mergedRole);
```

- [ ] **Step 3: Stamp the receipt with `account_id`.** Replace the `payment_receipts` INSERT (`web/app/api/s/[token]/route.ts:262-264`) — add the `account_id` column + value:

```ts
    db.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(nanoid(12), share.drive_id, share.path, payerWallet, txHash, share.price_usdc, X402_NETWORK, share.id, settleAccountId);
```

- [ ] **Step 4: Typecheck.** Run: `npm --prefix web run typecheck`
  Expected: PASS. (If `mergeRoleUpgradeOnly` or `resolveRoleByUser` are reported missing, Phase 1 / its access.ts re-export was not applied — stop and resolve the dependency before continuing.)

- [ ] **Step 5: Add an end-to-end settle test** that drives the real route handler against a temp DB in `DEV_BYPASS` mode (no facilitator). Create `web/lib/__tests__/paid-settle.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-settle-"));
process.env.AINDRIVE_DEV_BYPASS_X402 = "1";

const { db } = await import("../db.js");
const { GET } = await import("../../app/api/s/[token]/route.ts");

const PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00001";

function devPaymentHeader(from: string): string {
  // DEV_BYPASS accepts any well-formed JSON; reads authorization.from.
  const payload = { payload: { authorization: { from } } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("paid share settle → drive_members", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("owner1", "o@example.com", "Owner", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("d1", "owner1", "D1", "h", "s");
    db.prepare(
      "INSERT INTO shares (id, drive_id, path, role, token, price_usdc) VALUES (?,?,?,?,?,?)"
    ).run("sh1", "d1", "docs", "editor", "tok1", 2.0);
  });

  it("writes a drive_members grant for a placeholder account + receipt with account_id", async () => {
    const req = new Request("http://localhost/api/s/tok1", {
      headers: { "X-PAYMENT": devPaymentHeader(PAYER) },
    });
    const res = await GET(req, { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(200);

    const link = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
      .get(PAYER.toLowerCase()) as { account_id: string };
    expect(link.account_id).toMatch(/^w_/);

    const member = db.prepare(
      "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
    ).get("d1", link.account_id, "docs") as { role: string };
    expect(member.role).toBe("editor");

    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE wallet = ?")
      .get(PAYER.toLowerCase()) as { account_id: string };
    expect(receipt.account_id).toBe(link.account_id);

    // Legacy folder_access row still written (removed in Phase 5).
    const fa = db.prepare(
      "SELECT role FROM folder_access WHERE drive_id = ? AND path = ? AND wallet_address = ?"
    ).get("d1", "docs", PAYER.toLowerCase()) as { role: string };
    expect(fa.role).toBe("editor");
  });
});
```

- [ ] **Step 6: Run the settle test — expect PASS.** Run: `npm --prefix web test lib/__tests__/paid-settle.test.ts`
  Expected: PASS (1 passed). (The handler reads cookies via `getUser`/`getWallet`; with no cookies present both return null, so the wallet-derived placeholder branch runs — exactly what this test asserts.)

- [ ] **Step 7: Run the full lib test suite** to confirm no regressions in access-core / path / wallet-link. Run: `npm --prefix web test`
  Expected: PASS (all suites green).

- [ ] **Step 8: Build.** Run: `npm --prefix web run build` Expected: PASS.

- [ ] **Step 9: Commit.** Run: `git add "web/app/api/s/[token]/route.ts" web/lib/__tests__/paid-settle.test.ts && git commit -m "feat(s): paid settle writes drive_members grant keyed by account"`
```

---

Notes I grounded the plan on, surfaced for the orchestrator:

- **No `db.ts`** — the contract listed `web/lib/db.ts` but the real file is `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/lib/db.js`. Imports resolve via `@/lib/db`.
- **Migration mechanism**: runtime DDL in `web/lib/db.js` (`CREATE TABLE IF NOT EXISTS` + idempotent `ALTER TABLE ADD COLUMN` loop). `drizzle.config.ts` exists but **no `drizzle-kit` script in `package.json`** and no `drizzle/migrations/` dir, so there is **no `drizzle-kit push` command** — schema changes are applied by editing `db.js` and mirroring `web/drizzle/schema.ts` + `web/drizzle/schema.js` (the JS twin `db.js` actually imports). Task 4.1 reflects this.
- **`account_wallets` is NEW** in `db.js` — it does not exist yet (the `db.js` comment at line 92 and `schema.ts` line 152 already say "Phase 4", so this is the intended target).
- **`payment_receipts.account_id` ALTER is required** in addition to the CREATE, because existing DBs already have the table — `CREATE TABLE IF NOT EXISTS` won't add the column.
- **`mergeRoleUpgradeOnly` is a Phase 1 dependency** — not present in `web/lib/access-core.js` yet; the plan imports it from `@/lib/access-core.js` and Step 4.5/Step 4 flags a stop-condition if Phase 1 wasn't applied.
- **SIWE/nonce reuse**: `POST /api/wallet/link` mirrors the existing `web/app/api/wallet/verify/route.ts` flow (`consumeNonce` + `SiweMessage.verify`, `tryConsume`/`clientKey` from `lib/rate-limit.js`), differing only by requiring `getUser()` and writing a link instead of a wallet cookie. `viem`/`siwe` are project deps (used by the verify route + `wallet.ts`) though not installed in this worktree's `node_modules`.
- **Placeholder users** follow the real `users` schema (`email`/`name`/`password_hash` all NOT NULL; `email` UNIQUE): synthetic `<wallet>@wallet.aindrive.local` email + unusable random-input `bcrypt` hash, matching `bcryptjs` already used in `web/app/api/auth/signup/route.ts`.
- The existing settle tail (`web/app/api/s/[token]/route.ts:241-271`) writes `folder_access` + `payment_receipts` + `setWalletCookie` + `onPaymentSettled`; my plan **adds** the account/`drive_members` write and the `account_id` receipt column while **keeping** the `folder_access` write (Phase 5 removes it).

---

## Phase 5: Collapse `resolveAccess` to a single source (drive_members only)

Make `drive_members` the sole access source: `resolveAccess` delegates to `resolveRoleByUser`, the wallet + free-share-grant resolution branches are deleted (HTTP and WS), `pickFreeShareRole` and `folder_access` are removed, and the paid-settle tail stops writing `folder_access`. | Ships: every access decision (HTTP routes + WS doc hub) resolves through `drive_members`; no wallet-cookie or share-grant-cookie read path remains in resolution; `folder_access` no longer exists. | Depends on: Phase 1 (role ladder + `mergeRoleUpgradeOnly`), Phase 2 (free CONSUME writes `drive_members`), Phase 4 (paid settle writes `drive_members`). Both writers landed before this collapse, so no flow loses access mid-sequence.

> Migration model (discovered): this repo has **no drizzle-kit migrate/push step** — there is no `drizzle/migrations/` dir and no migrate script in `web/package.json`. Tables are created at runtime in `web/lib/db.js` (`CREATE TABLE IF NOT EXISTS` + idempotent `ALTER`), and one-shot data migrations run at every server start via `web/lib/migrations/run.js`. `web/drizzle/schema.ts` / `schema.js` are the typed source of truth consumed by Drizzle queries. **Therefore "drop `folder_access`" = remove its runtime DDL from `db.js`, remove its export from `schema.ts` + `schema.js`, and remove the startup-migration references. No `drizzle-kit` command is involved.** Demo data is lossy/OK to discard (contract): an existing `folder_access` table simply stops being read/written; we do not `DROP TABLE` it.

---

### Task 5.1: Drop `pickFreeShareRole` from the pure core + its tests

Remove the free-share decision helper and its test block. It is the pure half of the share-grant path being deleted; nothing in the single-source model uses it.

**Files:**
- Modify: `web/lib/access-core.js:50-78` (delete `pickFreeShareRole`)
- Modify: `web/lib/access-core.d.ts:15-26` (delete the declaration)
- Test: `web/lib/__tests__/access-core.test.ts:83-135` (delete the `describe("pickFreeShareRole", …)` block + its `ShareRow`/`share()` fixtures at lines 8-22)

- [ ] **Step 1: Delete the `pickFreeShareRole` describe block and its fixtures from the test.** Remove lines 8-22 (`ShareRow` type + `share` helper) and the entire `describe("pickFreeShareRole", …)` block (lines 83-135). After editing, the top of the file is:

```ts
import { describe, it, expect } from "vitest";
import { ROLE_RANK, atLeast, bestMatchingRole, type Role } from "../access-core.js";
import { type NormalizedPath } from "../path";

type Row = { path: NormalizedPath; role: Role };
const n = (s: string) => s as NormalizedPath;

describe("ROLE_RANK", () => {
```

and the file ends after the final `bestMatchingRole` test:

```ts
  it("rejects similar-but-not-ancestor (path prefix without slash boundary)", () => {
    const rows: Row[] = [{ path: n("docs"), role: "editor" }];
    expect(bestMatchingRole(rows, n("document"))).toBe("none");
  });
});
```

Note: the `ROLE_RANK` test still asserts `commenter` ordering (lines 28-29). Phase 1 already removed `commenter` from `ROLE_RANK`; if that block was left referencing `commenter` it is out of this task's scope — do not touch it here.

- [ ] **Step 2: Run the test, expect FAIL (import of removed symbol).** The import on line 2 still references `pickFreeShareRole` only after impl deletion; right now the test compiles but the impl still exists. To drive the deletion TDD-style, instead first confirm the suite is green, then delete impl and watch it fail:

  Run: `npm --prefix web test lib/__tests__/access-core.test.ts`
  Expected: PASS (the `pickFreeShareRole` describe block is gone; `ROLE_RANK`, `atLeast`, `bestMatchingRole` still pass).

- [ ] **Step 3: Delete `pickFreeShareRole` from `web/lib/access-core.js`.** Remove the entire JSDoc + function (lines 50-78). The file goes straight from `bestMatchingRole`'s closing brace to the final re-export:

```js
export function bestMatchingRole(rows, targetPath) {
  let best = "none";
  for (const r of rows) {
    if (isAncestorOrSelf(r.path, targetPath) && (ROLE_RANK[r.role] ?? 0) > (ROLE_RANK[best] ?? 0)) {
      best = r.role;
    }
  }
  return best;
}

export { normalizePath, isAncestorOrSelf };
```

  Also tighten `bestMatchingRole`'s JSDoc (line 31-32) which name-drops `folder_access` as a source table — `drive_members` is now the only source:

```js
/**
 * Pick the highest matching role from a list of grant rows.
 *
 * Rows must come from a table where `path` is already stored in normalized
 * form (drive_members — written through API routes that normalize on the way
 * in). `targetPath` should also be normalized by the caller before being
 * passed here.
 *
 * @param {Array<{path: string, role: string}>} rows
 * @param {string} targetPath  pre-normalized target
 * @returns {string} one of "none" | "viewer" | "editor" | "owner"
 */
```

- [ ] **Step 4: Delete the `pickFreeShareRole` declaration from `web/lib/access-core.d.ts`.** Remove lines 15-26. The file becomes:

```ts
import type { PathError, NormalizedPath } from "./path";

export type Role = "viewer" | "editor" | "owner";
export type RoleOrNone = Role | "none";

export declare const ROLE_RANK: Readonly<Record<RoleOrNone, number>>;

export declare function atLeast(level: RoleOrNone | string, required: RoleOrNone | string): boolean;

export declare function bestMatchingRole(
  rows: { path: NormalizedPath; role: Role }[],
  targetPath: NormalizedPath
): RoleOrNone;

export { normalizePath, isAncestorOrSelf } from "./path";
export type { PathError, NormalizedPath };
```

(The `Role` union here drops `commenter` per Phase 1; if Phase 1 already did so, leave it.)

- [ ] **Step 5: Run the test again, expect PASS.**
  Run: `npm --prefix web test lib/__tests__/access-core.test.ts`
  Expected: PASS. The suite no longer imports or references `pickFreeShareRole`.

- [ ] **Step 6: Commit.**
  Run: `git add web/lib/access-core.js web/lib/access-core.d.ts web/lib/__tests__/access-core.test.ts && git commit -m "refactor(access-core): drop pickFreeShareRole free-share decision helper"`

---

### Task 5.2: Collapse `resolveAccess` and delete the wallet + share-grant resolvers (HTTP)

Rewrite `resolveAccess` in `web/lib/access.ts` to delegate to `resolveRoleByUser` only. Delete `resolveRoleByWallet` and `resolveRoleByShareGrants`, and drop the now-dead imports (`getWallet`, `readShareGrants`, `pickFreeShareRole`, `folder_access`).

**Files:**
- Modify: `web/lib/access.ts:1-117` (rewrite imports + delete two resolvers + collapse `resolveAccess`)

- [ ] **Step 1: Rewrite the import block (lines 1-7).** Drop `folder_access` from the schema import, drop `getWallet`, drop `readShareGrants`, drop `pickFreeShareRole`. `shares` is no longer used by this file after the resolvers are deleted (it was only read by `resolveRoleByShareGrants`), so drop it too:

```ts
import { eq, and } from "drizzle-orm";
import { drizzleDb } from "./db";
import { drives, drive_members } from "../drizzle/schema";
import { ROLE_RANK, atLeast, bestMatchingRole, normalizePath, type Role, type RoleOrNone } from "./access-core.js";
import { type NormalizedPath } from "./path";

export type { Role, RoleOrNone };
```

- [ ] **Step 2: Keep `resolveRoleByUser` verbatim (lines 12-30).** No edit — contract pins it. Confirm it still reads only `drives` + `drive_members` (it does).

- [ ] **Step 3: Delete `resolveRoleByWallet` (lines 32-43) and `resolveRoleByShareGrants` (lines 45-86) entirely.** Both DB-backed resolvers are gone.

- [ ] **Step 4: Replace `resolveAccess` (lines 88-117) with the single-source delegate.** Signature stays `async` to avoid call-site churn (contract):

```ts
/**
 * Combined role resolution — now a single source.
 *
 * Access is granted ONLY through drive ownership or a covering drive_members
 * row (resolveRoleByUser). Both free shares (CONSUME -> drive_members) and
 * paid shares (settle -> drive_members) write membership rows, so there is no
 * separate wallet-allowlist or free-share-cookie path to consult.
 *
 * Stays async (and tolerates a null userId) so existing call sites — many of
 * which await this and pass a possibly-null session id — don't have to change.
 */
export async function resolveAccess(
  driveId: string,
  targetPath: string,
  userId: string | null
): Promise<RoleOrNone> {
  if (!userId) return "none";
  return resolveRoleByUser(driveId, userId, targetPath);
}
```

- [ ] **Step 5: Keep the `resolveRole` back-compat alias (lines 119-122) and the trailing re-export (line 124) unchanged.** Confirm the file's tail reads:

```ts
/** Backwards compat — keep the old name pointing at the user-only path. */
export function resolveRole(driveId: string, userId: string, targetPath: string): RoleOrNone {
  return resolveRoleByUser(driveId, userId, targetPath);
}

export { atLeast, ROLE_RANK };
```

`atLeast`, `ROLE_RANK`, `bestMatchingRole`, `normalizePath`, `NormalizedPath` remain imported because `resolveRoleByUser` uses `normalizePath` + `bestMatchingRole` + the `NormalizedPath` cast, and `atLeast`/`ROLE_RANK` are re-exported for consumers.

- [ ] **Step 6: Typecheck — expect FAIL pointing at `app/api/s/[token]/route.ts`.** The share route still imports `resolveRoleByWallet` (line 9) and calls it (line 71); that import is now a missing export.
  Run: `npm --prefix web run typecheck`
  Expected: FAIL — error like `Module '"@/lib/access"' has no exported member 'resolveRoleByWallet'.` in `app/api/s/[token]/route.ts`. (Fixed in Task 5.3.) Do not commit yet.

---

### Task 5.3: Stop the paid-settle tail from writing `folder_access`; drop the wallet pre-check

Phase 4 left `folder_access` as a second write alongside `drive_members`. Now `drive_members` is authoritative, so remove the `folder_access` INSERT/UPDATE block and the `resolveRoleByWallet` pre-payment short-circuit from the share route. The paid settle already upserts `drive_members` (Phase 4) — that write stays.

**Files:**
- Modify: `web/app/api/s/[token]/route.ts:9` (import), `:68-73` (wallet pre-check), `:231-260` (folder_access write)

- [ ] **Step 1: Trim the import (line 9).** `resolveRoleByWallet` is gone; `ROLE_RANK` was only used by the `folder_access` downgrade-guard being deleted, so drop it too. Keep `atLeast` and `type Role`:

```ts
import { atLeast, type Role } from "@/lib/access";
```

- [ ] **Step 2: Delete the paid-share wallet pre-check (lines 68-73).** Under the new model a returning payer's covering grant lives in `drive_members`, surfaced by the upstream entry flow (`resolveRoleByUser`), not a wallet allowlist. Remove:

```ts
  // Paid share — check existing wallet allowlist with prefix matching
  const wallet = await getWallet();
  if (wallet) {
    const role = resolveRoleByWallet(share.drive_id, wallet, share.path);
    if (atLeast(role, "viewer")) return NextResponse.json({ ...okBody, role });
  }
```

The GET flow then proceeds from the owner-bypass / free-share branch straight into building x402 requirements. `getWallet` is still imported (line 7) and used later for `setWalletCookie`'s sibling and the dev-bypass payer derivation — confirm `getWallet` remains referenced; if after this deletion `getWallet` is unused, drop it from the line-7 import (`import { setWalletCookie } from "@/lib/wallet";`). Check with: `grep -n "getWallet" web/app/api/s/[token]/route.ts`.

- [ ] **Step 3: Delete the `folder_access` write block (lines 231-260).** Remove the entire leading comment (231-240) and the `try { INSERT INTO folder_access … } catch { … UPDATE … }` block (241-260). The Phase-4 `drive_members` upsert and the `payment_receipts` insert (lines 261-270) remain. After the edit, the settle tail goes directly from the `payerWallet`/`txHash` assignment into the receipts insert:

```ts
  try {
    db.prepare(
      "INSERT INTO payment_receipts (id, drive_id, path, wallet, tx_hash, amount_usdc, network, share_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(nanoid(12), share.drive_id, share.path, payerWallet, txHash, share.price_usdc, X402_NETWORK, share.id);
  } catch (e) {
    if (!/UNIQUE/i.test((e as Error).message)) throw e;
    console.warn(`[receipts] tx_hash UNIQUE collision — assuming replay: ${txHash} share=${share.id} payer=${payerWallet}`);
  }
  await setWalletCookie(payerWallet);
```

> Assumption: the Phase-4 `drive_members` upsert sits ABOVE the old `folder_access` block (Phase 4 wrote `drive_members` "IN ADDITION to" the existing `folder_access` write). When applying, leave that upsert in place and delete only the `folder_access` lines. If the Phase-4 upsert was instead interleaved, keep the `drive_members` statements and remove only the `folder_access` ones.

- [ ] **Step 4: Fix the stale free-share comment (lines ~58-66).** The free-share branch comment still says `resolveRoleByShareGrants`; Phase 2 changed the free path to CONSUME -> `drive_members`. If Phase 2 already rewrote this branch to redirect into `/accept`, leave it; otherwise update the comment to reference the CONSUME flow rather than the deleted resolver. Verify: `grep -n "resolveRoleByShareGrants\|addShareGrant" web/app/api/s/[token]/route.ts`.

- [ ] **Step 5: Typecheck — expect PASS for access.ts + share route.** Other files (the `/access` routes, dochub) may still fail; those are Tasks 5.4-5.5.
  Run: `npm --prefix web run typecheck`
  Expected: the `resolveRoleByWallet` errors from Task 5.2 are gone. Remaining errors, if any, point only at files handled in later tasks (TS won't flag `db.js`/route SQL strings). If typecheck is fully green here, proceed.

- [ ] **Step 6: Commit (access.ts + share route together — they are mutually dependent).**
  Run: `git add web/lib/access.ts "web/app/api/s/[token]/route.ts" && git commit -m "refactor(access): collapse resolveAccess to drive_members; drop wallet+share-grant resolvers and folder_access settle write"`

---

### Task 5.4: WS doc hub resolves by user only (delete the wallet + free-share branches in `dochub.js`)

`web/lib/dochub.js` mirrors the HTTP resolution path for the raw-node WebSocket server. Collapse it to the same single source: drop `readShareGrantsFromCookie`, drop the `folder_access` wallet read and the `pickFreeShareRole` free-share branch in `resolveRole`, and stop reading the wallet/share cookies in `onDocConnect`.

**Files:**
- Modify: `web/lib/dochub.js:9` (import), `:50-57` (`readWalletFromCookie` — now unused), `:68-78` (`readShareGrantsFromCookie`), `:80-123` (`resolveRole`), `:125-136` (`onDocConnect` credential extraction)

- [ ] **Step 1: Trim the access-core import (line 9).** Drop `pickFreeShareRole`. `ROLE_RANK` stays (used for the `viewer`/`editor` gates in `onDocConnect` and the message handler); `bestMatchingRole` + `normalizePath` stay (used by `resolveRole`):

```js
import { ROLE_RANK, bestMatchingRole, normalizePath } from "./access-core.js";
```

- [ ] **Step 2: Delete `readShareGrantsFromCookie` (lines 68-78) and `readWalletFromCookie` (lines 50-57).** Both feed branches we are removing. (`readUserFromCookie`, lines 59-66, stays — it is the single remaining credential.)

- [ ] **Step 3: Rewrite `resolveRole` (lines 80-123) to user-only.** Mirror `resolveRoleByUser`: owner-of-drive, else best matching `drive_members` row. No `folder_access` read, no share-token branch:

```js
// Mirrors lib/access.ts resolveRoleByUser: drive owner, else best-matching
// drive_members row. Kept here (not imported) because access.ts depends on
// next/headers, which is unavailable under raw `node server.js`. drive_members
// is the single access source — paid (settle) and free (accept) shares both
// write rows here, so the WS hub needs no wallet/share-cookie branch.
function resolveRole(driveId, userId, path) {
  if (!userId) return "none";
  const target = normalizePath(path);
  const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
  if (!drive) return "none";
  if (drive.owner_id === userId) return "owner";
  const rows = db
    .prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?")
    .all(driveId, userId);
  return bestMatchingRole(rows, target);
}
```

- [ ] **Step 4: Simplify `onDocConnect` credential extraction (lines 130-136).** Only the session cookie is read now; drop the `Promise.all` over wallet + share grants and the `address`/`shareTokens` locals:

```js
  const cookie = req.headers["cookie"];
  const userId = await readUserFromCookie(cookie);
  const role = resolveRole(driveId, userId, path);
  if (ROLE_RANK[role] < ROLE_RANK.viewer) { ws.close(4401, "no access"); return; }
```

- [ ] **Step 5: Drop the now-dead `address` field from the peer + logs (lines 140, 145, 149).** `address` no longer exists. Update the peer object and the two log/trace sites:

```js
  const docId = docIdFor(driveId, path);
  const peer = { ws, role, userId, docId };
  let bucket = hubs.get(docId);
  if (!bucket) { bucket = new Set(); hubs.set(docId, bucket); }
  bucket.add(peer);

  log.info({ docId, role, user: userId || "anon", peers: bucket.size }, "[doc] sub");
  try {
    ws.send(JSON.stringify({ t: "sub-ok", role, peers: bucket.size }));
  } catch {}
  try { trace("server", "ws-doc-sub", { docId, extra: { role, peers: bucket.size, userId } }); } catch {}
```

- [ ] **Step 6: Smoke-check the module loads (no syntax / unresolved-import errors).** `dochub.js` is plain ESM run by `server.js`, not covered by `tsc`. Verify it imports cleanly:
  Run: `node --input-type=module -e "import('./web/lib/dochub.js').then(()=>console.log('dochub OK')).catch(e=>{console.error(e);process.exit(1)})"`
  Expected: `dochub OK` (better-sqlite3 opens against `AINDRIVE_DATA_DIR`/default `~/.aindrive`; the import must not throw on missing `pickFreeShareRole`/`folder_access` symbols). Confirm no leftover refs: `grep -n "pickFreeShareRole\|folder_access\|readShareGrantsFromCookie\|readWalletFromCookie\|address" web/lib/dochub.js` returns nothing.

- [ ] **Step 7: Commit.**
  Run: `git add web/lib/dochub.js && git commit -m "refactor(dochub): WS access resolves by drive_members only; drop wallet+share-grant branches"`

---

### Task 5.5: Drop the `folder_access` table (schema + runtime DDL + startup migrations) and remove its orphaned consumers

`folder_access` has no readers left in the resolution path. Remove it from the typed schema, the runtime DDL in `db.js`, and the startup migrations. The owner wallet-allowlist routes (`/api/drives/[driveId]/access`) and the wallet section of `share-dialog.tsx` are the only remaining `folder_access` consumers — they are the wallet-allowlist surface the single-source model eliminates, so delete them here to keep the build and server startup green. No data migration; an existing `folder_access` table is simply left untouched on disk and never queried again (demo data lossy/OK to discard).

**Files:**
- Modify: `web/drizzle/schema.ts:103-134` and `web/drizzle/schema.js:83-106` (delete `folder_access` export)
- Modify: `web/lib/db.js:66-76, 105-107, 117` (delete runtime DDL + indexes + ALTER)
- Modify: `web/lib/migrations/0001-normalize-paths.js:16-32` (remove `folder_access` from `TABLES`)
- Modify: `web/lib/migrations/0002-backfill-receipts.js` + `web/lib/migrations/run.js` (drop the backfill, which only reads `folder_access`)
- Delete: `web/app/api/drives/[driveId]/access/route.ts`, `web/app/api/drives/[driveId]/access/[id]/route.ts`
- Modify: `web/components/share-dialog.tsx` (remove the wallet-allowlist UI + `/access` fetches)

- [ ] **Step 1: Delete the `folder_access` export from `web/drizzle/schema.ts` (lines 103-134).** Remove the `// folder_access` banner + the whole `export const folder_access = sqliteTable(…)`. The file goes from the `shares` block straight to the `payment_receipts` banner. Also fix the stale `payment_receipts` header comment (lines 136-139) that says "folder_access tells you WHO has access":

```ts
// ---------------------------------------------------------------------------
// payment_receipts — append-only ledger of every settled x402 payment.
// drive_members tells you WHO has access; payment_receipts tells you HOW a
// paid grant was settled. tx_hash UNIQUE doubles as replay defense.
// ---------------------------------------------------------------------------
```

- [ ] **Step 2: Delete the mirrored `folder_access` export from `web/drizzle/schema.js` (lines 83-106).** Same removal — the runtime JS mirror must match `schema.ts` (it is what `db.js` imports via `drizzle(db, { schema })`).

- [ ] **Step 3: Remove `folder_access` runtime DDL from `web/lib/db.js`.** Delete the `CREATE TABLE IF NOT EXISTS folder_access (…)` block (lines 66-76), the two folder_access index `CREATE INDEX` lines (105-107), and the `"ALTER TABLE folder_access ADD COLUMN role …"` entry in the idempotent-ALTER array (line 117). Leave every other table/index/ALTER intact.

- [ ] **Step 4: Remove `folder_access` from the path-normalize migration.** In `web/lib/migrations/0001-normalize-paths.js`, drop the `{ name: "folder_access" }` entry from `TABLES` (line 18) and simplify the now-dead `added_by` special-case (lines 31-32, 46, 56) since only `shares` + `drive_members` remain (neither has `added_by`):

```js
const TABLES = [
  { name: "shares" },
  { name: "drive_members" },
];

export function runNormalizePathsMigration({ dryRun = false } = {}) {
  let changed = 0;
  let dropped = 0;
  let skippedInvalid = 0;

  for (const t of TABLES) {
    const rows = db.prepare(`SELECT id, path FROM ${t.name}`).all();
    for (const r of rows) {
      let norm;
      try {
        norm = normalizePath(r.path);
      } catch (e) {
        log.warn({ table: t.name, id: r.id, path: r.path, err: e.message }, "[migrate] invalid path, leaving as-is");
        skippedInvalid++;
        continue;
      }
      if (norm === r.path) continue;

      if (dryRun) {
        log.info({ table: t.name, id: r.id, from: r.path, to: norm }, "[migrate dry] would update");
        changed++;
        continue;
      }
      try {
        db.prepare(`UPDATE ${t.name} SET path = ? WHERE id = ?`).run(norm, r.id);
        changed++;
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) {
          log.warn(
            { table: t.name, id: r.id, from: r.path, to: norm },
            "[migrate] UNIQUE collision — dropping younger row",
          );
          db.prepare(`DELETE FROM ${t.name} WHERE id = ?`).run(r.id);
          dropped++;
        } else throw e;
      }
    }
  }
  log.info({ changed, dropped, skippedInvalid, dryRun }, "[migrate 0001-normalize-paths] done");
  return { changed, dropped, skippedInvalid };
}
```

- [ ] **Step 5: Drop the receipts backfill (it only reads `folder_access`).** The `0002` backfill seeds `payment_receipts` from `folder_access.payment_tx`; with `folder_access` gone its `SELECT … FROM folder_access` would throw `no such table` at startup. Remove its wiring from `web/lib/migrations/run.js`:

```js
/**
 * Run every one-shot migration in order, once per server startup.
 * Each migration MUST be idempotent so re-running on the next boot is safe.
 */
import { runNormalizePathsMigration } from "./0001-normalize-paths.js";
import { runReceiptsAmountNullableMigration } from "./0003-receipts-amount-nullable.js";

export function runAllMigrations({ dryRun = process.env.AINDRIVE_DRY_RUN === "1" } = {}) {
  runNormalizePathsMigration({ dryRun });
  runReceiptsAmountNullableMigration({ dryRun });
}
```

  Then delete the now-unreferenced file: `git rm web/lib/migrations/0002-backfill-receipts.js`. (Legacy receipts already seeded on prior boots are untouched in `payment_receipts`.)

- [ ] **Step 6: Delete the owner wallet-allowlist routes.** These are the only HTTP `folder_access` consumers left; the new model grants access via `drive_members` (member management lands in Phase 6), not a wallet allowlist:
  Run: `git rm "web/app/api/drives/[driveId]/access/route.ts" "web/app/api/drives/[driveId]/access/[id]/route.ts"`

- [ ] **Step 7: Remove the wallet-allowlist UI from `web/components/share-dialog.tsx`.** Strip the `/access` fetch from `load()` and the `addWallet`/`removeAccess` handlers + their JSX (the "add wallet" form and the access list). Concretely: delete the `apiFetch<{ access: Access[] }>(\`/api/drives/${driveId}/access\`)` line and its `a` destructure/`setAccess(a.data.access)` in `load()`; delete the `addWallet` and `removeAccess` functions; remove the `access`/`wallet`/`walletRole` state and any JSX block rendering them. Drive the cuts with the compiler in Step 8 (each removed symbol surfaces as an unused-var or missing-handler error until fully excised). Keep the shares list, receipts list, and payout-wallet sections untouched.

- [ ] **Step 8: Typecheck — expect PASS.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS. No file imports the deleted `folder_access` schema export, the deleted routes, or `Access`-typed `/access` data. If an error names a leftover `folder_access` / `access` reference, remove it and re-run.

- [ ] **Step 9: Confirm no `folder_access` references remain anywhere in `web/`.**
  Run: `grep -rn "folder_access" web --exclude-dir=node_modules --exclude-dir=.next`
  Expected: only the comment in `web/lib/share-grant.ts` (that file is kept until Phase 7 for cookie back-compat per the contract) and, optionally, the historical comment in `web/components/share-gate.tsx:94` — neither is a code reference. No `*.ts`/`*.js` SQL string, schema export, or DDL should match. If `share-gate.tsx`'s comment is misleading post-collapse, update it; otherwise leave it for Phase 7.

- [ ] **Step 10: Server-start smoke test — runtime DDL + migrations load without `folder_access`.** `db.js` and the migration runner are plain ESM (not type-checked). Verify they initialize against a throwaway data dir so a stale `folder_access` table is not present:
  Run: `AINDRIVE_DATA_DIR=$(mktemp -d) node --input-type=module -e "import('./web/lib/migrations/run.js').then(m=>{m.runAllMigrations({dryRun:false});console.log('migrations OK')}).catch(e=>{console.error(e);process.exit(1)})"`
  Expected: `migrations OK` with no `no such table: folder_access` error. (This loads `db.js`'s runtime DDL via the migration imports and runs `0001` + `0003` against fresh tables.)

- [ ] **Step 11: Run the full lib test suite.**
  Run: `npm --prefix web test`
  Expected: PASS (vitest runs `lib/`; `access-core.test.ts` already trimmed in Task 5.1).

- [ ] **Step 12: Build to confirm the route deletions don't break Next's route manifest.**
  Run: `npm --prefix web run build`
  Expected: build succeeds; the App Router no longer lists `/api/drives/[driveId]/access`.

- [ ] **Step 13: Commit.**
  Run: `git add -A && git commit -m "refactor(schema): drop folder_access table and its orphaned wallet-allowlist consumers; drive_members is the single access source"`

---

> Out of Phase 5 scope (cross-refs): `web/lib/share-grant.ts` is intentionally kept (cookie back-compat) and deleted in **Phase 7**, alongside `PaidContentView`, password shares, the free-share cookie, and the owner `atLeast` gate. The new member-management routes (`PATCH`/`DELETE /api/drives/[driveId]/members/[memberId]`) that replace the deleted wallet-allowlist UI land in **Phase 6**.

Primary files touched: `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/lib/access.ts`, `web/lib/access-core.js`, `web/lib/access-core.d.ts`, `web/lib/__tests__/access-core.test.ts`, `web/lib/dochub.js`, `web/app/api/s/[token]/route.ts`, `web/drizzle/schema.ts`, `web/drizzle/schema.js`, `web/lib/db.js`, `web/lib/migrations/0001-normalize-paths.js`, `web/lib/migrations/0002-backfill-receipts.js`, `web/lib/migrations/run.js`, `web/app/api/drives/[driveId]/access/route.ts`, `web/app/api/drives/[driveId]/access/[id]/route.ts`, `web/components/share-dialog.tsx`.

---

## Phase 6: Member management (remove + role change)

Give drive owners (and co-owners) a way to remove members and change their role from the share dialog, backed by a new owner-gated `DELETE`/`PATCH` route on a single `drive_members` row. | Ships: owners see the live member list with a per-row role `<select>` and remove button; changing a role or removing a member persists through `/api/drives/[driveId]/members/[memberId]`; the drive creator (`drives.owner_id`) can never be removed. | Depends on: Phase 1 (role ladder + `atLeast`), and the existing `GET /api/drives/[driveId]/members` list route.

Grounding facts confirmed from the repo (do not re-discover):
- The DB is created at runtime via `CREATE TABLE IF NOT EXISTS` in `web/lib/db.js` (see the `drive_members` block, lines ~43-53). There is **no** drizzle-kit migration step for this phase — `drive_members(id, drive_id, user_id, path, role, created_at)` with `UNIQUE(drive_id,user_id,path)` already exists with the exact shape Phase 6 needs. No schema change, no `drizzle-kit push`.
- `web/lib/access.ts` already exports `resolveRole(driveId, userId, targetPath)` and `atLeast`. Owner-gating uses `atLeast(resolveRole(driveId, user.id, ""), "owner")` so co-owner `drive_members` rows (role=`owner`) pass too (D2).
- `getDrive(driveId).owner_id` is the creator/final-authority (`web/lib/drives.ts:69`).
- Routes use `better-sqlite3` via `db.prepare(...).get/run`, `zod` for input, `NextResponse` for output, and `await params` (Next 15 async params) — matching `web/app/api/drives/[driveId]/members/route.ts` and `.../access/[id]/route.ts`.
- `npm --prefix web test` runs `vitest run lib/` — only `lib/**` is collected, so route handlers are verified by manual curl; pure guard logic gets a unit test in `web/lib/__tests__/`.

---

### Task 6.1: Extract + unit-test the member-mutation guard (pure helper)

The route needs one non-trivial decision the access helpers don't cover: "may this row be deleted/changed?" — specifically, the creator row (`user_id === drives.owner_id`) must never be removed even by another owner. Put that rule in a pure, testable function rather than burying it in the handler.

**Files:**
- Create: `web/lib/member-guard.ts`
- Test: `web/lib/__tests__/member-guard.test.ts`

- [ ] **Step 1: Write the failing test.** Create `web/lib/__tests__/member-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canRemoveMember } from "../member-guard";

describe("canRemoveMember", () => {
  it("allows removing a non-creator member", () => {
    expect(canRemoveMember({ memberUserId: "u2", driveOwnerId: "u1" })).toBe(true);
  });
  it("refuses to remove the drive creator's own row", () => {
    expect(canRemoveMember({ memberUserId: "u1", driveOwnerId: "u1" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.** Run: `npm --prefix web test lib/__tests__/member-guard.test.ts`
  Expected: FAIL — `Cannot find module '../member-guard'` (or "canRemoveMember is not a function").

- [ ] **Step 3: Minimal implementation.** Create `web/lib/member-guard.ts`:

```ts
// Pure guard for member-row mutations on /api/drives/[driveId]/members/[memberId].
// The creator (drives.owner_id) is the final authority and must always retain a
// row — even another owner (co-owner, D2) cannot remove it. Kept pure so the
// rule is unit-tested without a DB; the route supplies the two ids.

export function canRemoveMember(args: {
  memberUserId: string;
  driveOwnerId: string;
}): boolean {
  return args.memberUserId !== args.driveOwnerId;
}
```

- [ ] **Step 4: Run it — expect PASS.** Run: `npm --prefix web test lib/__tests__/member-guard.test.ts`
  Expected: PASS (2 passing).

- [ ] **Step 5: Typecheck.** Run: `npm --prefix web run typecheck`
  Expected: no errors.

- [ ] **Step 6: Commit.**
  Run: `git add web/lib/member-guard.ts web/lib/__tests__/member-guard.test.ts && git commit -m "feat(members): add canRemoveMember guard (creator row is protected)"`

---

### Task 6.2: Create the `[memberId]` route — `DELETE` + `PATCH`

Owner-gated mutations on a single `drive_members` row. `DELETE` refuses the creator row (via `canRemoveMember`). `PATCH` sets `role` explicitly to one of `{viewer,editor,owner}` (owner may downgrade here — unlike CONSUME).

**Files:**
- Create: `web/app/api/drives/[driveId]/members/[memberId]/route.ts`
- Read (for shape/style): `web/app/api/drives/[driveId]/members/route.ts`, `web/app/api/drives/[driveId]/access/[id]/route.ts`

- [ ] **Step 1: Create the route file.** Create `web/app/api/drives/[driveId]/members/[memberId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { canRemoveMember } from "@/lib/member-guard";

const PatchBody = z.object({
  role: z.enum(["viewer", "editor", "owner"]),
});

type MemberRow = { id: string; user_id: string };

/** Load the target row, scoped to this drive so a foreign memberId 404s. */
function getMemberRow(driveId: string, memberId: string): MemberRow | undefined {
  return db
    .prepare("SELECT id, user_id FROM drive_members WHERE id = ? AND drive_id = ?")
    .get(memberId, driveId) as MemberRow | undefined;
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ driveId: string; memberId: string }> },
) {
  const { driveId, memberId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const member = getMemberRow(driveId, memberId);
  if (!member) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canRemoveMember({ memberUserId: member.user_id, driveOwnerId: drive.owner_id })) {
    return NextResponse.json({ error: "cannot remove the drive creator" }, { status: 400 });
  }
  db.prepare("DELETE FROM drive_members WHERE id = ? AND drive_id = ?").run(memberId, driveId);
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ driveId: string; memberId: string }> },
) {
  const { driveId, memberId } = await params;
  const body = PatchBody.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const member = getMemberRow(driveId, memberId);
  if (!member) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Explicit set (may downgrade) — distinct from CONSUME's upgrade-only merge.
  db.prepare("UPDATE drive_members SET role = ? WHERE id = ? AND drive_id = ?")
    .run(body.data.role, memberId, driveId);
  return NextResponse.json({ ok: true, role: body.data.role });
}
```

- [ ] **Step 2: Typecheck.** Run: `npm --prefix web run typecheck`
  Expected: no errors. (`@/lib/db` resolves to `lib/db.js` via its `lib/db.d.ts`; `resolveRole`/`atLeast` are exported from `lib/access.ts`.)

- [ ] **Step 3: Manual verification (route is outside `lib/`, so not vitest-covered).** Start the dev server, then with an owner session cookie and a real `driveId`/`memberId` from `GET /api/drives/<driveId>/members`:
  - `curl -X DELETE` on a non-creator memberId → expect `{"ok":true}` (200), and the row gone from the members list.
  - `curl -X DELETE` on the creator's own memberId → expect `{"error":"cannot remove the drive creator"}` (400).
  - `curl -X PATCH -H 'content-type: application/json' -d '{"role":"editor"}'` on a member → expect `{"ok":true,"role":"editor"}` (200).
  - Same `PATCH` with no session cookie → `401`; with a viewer session → `403`; body `{"role":"commenter"}` → `400` (commenter removed in Phase 1).
  - `DELETE`/`PATCH` with a memberId from another drive → `404`.

- [ ] **Step 4: Commit.**
  Run: `git add "web/app/api/drives/[driveId]/members/[memberId]/route.ts" && git commit -m "feat(members): owner-gated DELETE + PATCH on a member row"`

---

### Task 6.3: Wire member management into the share dialog UI

Surface the member list (already available via `GET /api/drives/[driveId]/members`) in `ShareDialog`, with a role `<select>` and a remove button per row, shown only to owners. Owner-gating in the UI mirrors the route: derive `isOwner` from the current user's role at the drive root.

**Files:**
- Modify: `web/components/share-dialog-sections.tsx` (add `MembersSection` + `Member` type)
- Modify: `web/components/share-dialog.tsx:21-49` (state + `load`), `:128-143` (after `invite`), `:217-224` (render)

- [ ] **Step 1: Add the `Member` type + `MembersSection` to `share-dialog-sections.tsx`.** After the `Receipt` type (ends at `web/components/share-dialog-sections.tsx:36`), insert the new type:

```tsx
export type Member = {
  id: string;
  path: string;
  role: "viewer" | "editor" | "owner";
  email: string;
  name: string;
};
```

  Then add the section component (place it just before the `EmailInviteSection` export, around `web/components/share-dialog-sections.tsx:273`):

```tsx
export function MembersSection({
  members, isOwner, currentUserEmail, changeMemberRole, removeMember, busy,
}: {
  members: Member[];
  isOwner: boolean;
  currentUserEmail: string;
  changeMemberRole: (id: string, role: "viewer" | "editor" | "owner") => void;
  removeMember: (id: string) => void;
  busy: boolean;
}) {
  if (members.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 text-sm font-medium mb-2">
        <Users className="w-4 h-4" /> Members
      </div>
      <ul className="space-y-1.5 max-h-40 overflow-auto scrollbar-thin">
        {members.map((m) => (
          <li
            key={m.id}
            className="text-xs flex items-center gap-2 bg-drive-sidebar rounded-lg px-2 py-1.5"
          >
            <span className="truncate flex-1">{m.name || m.email}</span>
            <span className="text-drive-muted truncate w-16 shrink-0">{m.path || "/"}</span>
            {isOwner ? (
              <select
                value={m.role}
                disabled={busy}
                onChange={(e) =>
                  changeMemberRole(m.id, e.target.value as "viewer" | "editor" | "owner")
                }
                className="rounded-lg border border-drive-border px-1.5 py-0.5 text-[11px] disabled:opacity-50"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="owner">Owner</option>
              </select>
            ) : (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-700">
                {m.role}
              </span>
            )}
            {isOwner && m.email !== currentUserEmail && (
              <button
                onClick={() => removeMember(m.id)}
                disabled={busy}
                className="p-1 rounded hover:bg-drive-hover disabled:opacity-50"
                title="Remove member"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Import the `Users` icon.** In `web/components/share-dialog-sections.tsx:6-8`, add `Users` to the `lucide-react` import (`Trash2` is already imported):

```tsx
import {
  Copy, LinkIcon, UserPlus, Wallet, Trash2, DollarSign, TrendingUp, ExternalLink, Users,
} from "lucide-react";
```

- [ ] **Step 3: Add members state + fetch in `share-dialog.tsx`.** Update the import block (`web/components/share-dialog.tsx:6-9`) to pull in the new symbols:

```tsx
import {
  EarningsSection, SellSection, WalletAccessSection, EmailInviteSection, FreeLinkSection,
  MembersSection,
  type Share, type Access, type Receipt, type Member,
} from "./share-dialog-sections";
```

  Add state next to the other `useState` calls (after `web/components/share-dialog.tsx:30`, the `receipts` line):

```tsx
  const [members, setMembers] = useState<Member[]>([]);
  const [me, setMe] = useState<{ email: string; role: "viewer" | "editor" | "owner" | "none" }>({
    email: "",
    role: "none",
  });
```

- [ ] **Step 4: Fetch members + current-user role in `load()`.** Replace the `load()` body (`web/components/share-dialog.tsx:34-48`) so it also pulls the member list and the caller's identity/role. The members list comes from `GET /api/drives/[driveId]/members`; the caller's email comes from `/api/auth/me` and their owner status from whether their email appears as an `owner` member or is the drive creator. To keep it grounded in existing endpoints, derive `isOwner` purely from the members list (the creator and co-owners both appear there with `role: "owner"`):

```tsx
  async function load() {
    const [s, a, r, d, mem, who] = await Promise.all([
      apiFetch<{ shares: Share[] }>(`/api/drives/${driveId}/shares`),
      apiFetch<{ access: Access[] }>(`/api/drives/${driveId}/access`),
      apiFetch<{ receipts: Receipt[] }>(`/api/drives/${driveId}/receipts`),
      apiFetch<{ payout_wallet: string | null }>(`/api/drives/${driveId}`),
      apiFetch<{ members: Member[] }>(`/api/drives/${driveId}/members`),
      apiFetch<{ user: { email: string } | null }>(`/api/auth/me`),
    ]);
    if (s.ok) setShares(s.data.shares);
    if (a.ok) setAccess(a.data.access);
    if (r.ok) setReceipts(r.data.receipts ?? []);
    if (d.ok) {
      setPayoutWallet(d.data.payout_wallet ?? "");
      setPayoutInput(d.data.payout_wallet ?? "");
    }
    if (mem.ok) setMembers(mem.data.members);
    if (who.ok && who.data.user) {
      const email = who.data.user.email;
      const myRow = mem.ok ? mem.data.members.find((m) => m.email === email && m.path === "") : undefined;
      setMe({ email, role: myRow?.role ?? "none" });
    }
  }
```

  Note for the implementer: confirm `/api/auth/me` exists and returns `{ user: { email } | null }`. If the real endpoint differs (e.g. it returns the user object at the top level), adapt the `apiFetch<...>` generic and the `who.data.user` access to match — grep `web/app/api/auth` first. If no such endpoint exists, add a thin `GET /api/auth/me` returning `{ user: await getUser() }` (using `getUser` from `@/lib/session`) in its own small route file and commit it as part of this step.

- [ ] **Step 5: Add the mutation handlers in `share-dialog.tsx`.** Insert after the `invite()` function (`web/components/share-dialog.tsx:143`):

```tsx
  async function changeMemberRole(id: string, newRole: "viewer" | "editor" | "owner") {
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    setBusy(false);
    if (!res.ok) toast.error(res.error || "Failed to change role");
    else { toast.success("Role updated"); load(); }
  }

  async function removeMember(id: string) {
    if (!confirm("Remove this member?")) return;
    setBusy(true);
    const res = await apiFetch(`/api/drives/${driveId}/members/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) toast.error(res.error || "Failed to remove member");
    else { toast.success("Member removed"); load(); }
  }
```

- [ ] **Step 6: Render `MembersSection`.** In the dialog body, add the section right before `EmailInviteSection` (`web/components/share-dialog.tsx:217`):

```tsx
          <MembersSection
            members={members}
            isOwner={atLeast(me.role, "owner")}
            currentUserEmail={me.email}
            changeMemberRole={changeMemberRole}
            removeMember={removeMember}
            busy={busy}
          />
```

  Import `atLeast` at the top of `share-dialog.tsx` (add to the existing imports, after the `apiFetch` import at `web/components/share-dialog.tsx:5`):

```tsx
import { atLeast } from "@/lib/access-core.js";
```

  (`atLeast` lives in the pure `lib/access-core.js` — safe to import into a client component, unlike `lib/access.ts` which touches the DB. Mirrors the existing `import { ROLE_RANK, atLeast } from "./access-core.js"` style in `lib/access.ts`.)

- [ ] **Step 7: Typecheck + build.**
  Run: `npm --prefix web run typecheck`
  Expected: no errors.
  Run: `npm --prefix web run build`
  Expected: build succeeds (the `[memberId]` route compiles as a route segment).

- [ ] **Step 8: Manual smoke test.** As an owner, open the share dialog on a drive that has at least one extra member: confirm the Members section lists them with a role `<select>` and a remove button, the creator row shows no remove button (own email), changing a role toasts "Role updated" and persists on reload, and removing a member toasts "Member removed" and drops the row. As a viewer/editor (non-owner), confirm roles render as read-only badges with no remove button.

- [ ] **Step 9: Commit.**
  Run: `git add web/components/share-dialog.tsx web/components/share-dialog-sections.tsx && git commit -m "feat(members): member list with role select + remove in share dialog"`
  (If a new `web/app/api/auth/me/route.ts` was created in Step 4, include it in this commit.)

---

Files touched in Phase 6 (all absolute paths):
- `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/lib/member-guard.ts` (new)
- `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/lib/__tests__/member-guard.test.ts` (new)
- `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/app/api/drives/[driveId]/members/[memberId]/route.ts` (new)
- `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/components/share-dialog.tsx` (modified)
- `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/components/share-dialog-sections.tsx` (modified)
- (possibly new) `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/app/api/auth/me/route.ts` — only if no current-user endpoint exists.

---

## Phase 7: Cleanup (PaidContentView, password share, free-share cookie, owner gate)
Delete the last dead surfaces left behind by the redesign — the buyer-only `PaidContentView`, the write-only share password, the free-share cookie path, and the `aindrive_share` cookie reader — and make management gates honor co-ownership. | Ships: A single access source of truth with no orphaned UI, no dead `password_hash` column in the schema-of-record, no signed-cookie grant path, and owner-gated routes that respect `role=owner` drive_members (D2). | Depends on: Phases 1-6 (roles collapsed to viewer/editor/owner, free + paid both write `drive_members`, `resolveAccess` collapsed to `resolveRoleByUser` only, `folder_access` dropped, member-management routes live).

> Grounding notes (read from the real tree):
> - **There are no drizzle-kit migration files.** `drizzle.config.ts` points `out: "./drizzle/migrations"` but that dir does not exist; the actual schema-of-record is created at runtime by `web/lib/db.js` via `CREATE TABLE IF NOT EXISTS` + idempotent `ALTER`s. "Drop a column + migration" therefore means: remove it from `web/drizzle/schema.ts`, `web/drizzle/schema.js` (manual mirror, per repo convention), and the `CREATE TABLE` body in `web/lib/db.js`. SQLite legacy rows keep a now-unused nullable column; that is acceptable (demo data is lossy, and a nullable orphan column is inert).
> - **`web/components/share-dialog.tsx` and `web/components/share-dialog-sections.tsx` have NO password input** — the password was a write-only control that only ever existed in the POST route's zod schema. So "remove from the share-dialog UI" is a no-op verified by grep, not an edit.
> - **`web/lib/dochub.js` independently reads the `aindrive_share` cookie** (`readShareGrantsFromCookie`) and mirrors the old `resolveAccess` (session + wallet + share-cookie). Deleting `web/lib/share-grant.ts` doesn't break dochub (it's a hand-mirrored copy, not an import), but the cookie path is now dead there too and must be removed to keep dochub consistent with the collapsed `resolveAccess`.

---

### Task 7.1: Delete PaidContentView and its import

**Files:**
- Delete: `web/components/paid-content-view.tsx`
- Modify: `web/components/share-gate.tsx:9` (import), `web/components/share-gate.tsx:92-104` (the `state === "ok"` branch that still renders `<PaidContentView>`)

- [ ] **Step 1: Confirm PaidContentView has no other importers.** Phase 2 stopped the page from routing to it, but verify nothing else references it.
  Run: `grep -rn "paid-content-view\|PaidContentView" web --include="*.ts" --include="*.tsx" | grep -v node_modules`
  Expected: only `web/components/share-gate.tsx:9` (import) and `web/components/share-gate.tsx:97` (JSX usage). No page/test references.

- [ ] **Step 2: Delete the component file.**
  Run: `rm web/components/paid-content-view.tsx`
  Expected: no output, exit 0.

- [ ] **Step 3: Remove the import line from `share-gate.tsx`.** Replace line 9:
  ```diff
  -import { PaidContentView } from "./paid-content-view";
  ```
  (delete the line entirely; `DriveShell` import on line 8 stays.)

- [ ] **Step 4: Replace the dead `state === "ok"` render branch.** The post-Phase-2 entry flow is: `/s/[token]` resolves server-side, redirects to `/login?next=...` if needed, runs the x402 paywall, POSTs `/api/s/[token]/accept`, then redirects to `/d/<driveId>?path=<share.path>`. `ShareGate` no longer needs to render a scoped buyer view — after `check()` returns `ok`, it should navigate to the drive. Replace lines 92-104:
  ```tsx
  // old:
  if (state === "ok" && data && "driveId" in data) {
    // ... <PaidContentView .../>
  }
  ```
  with a redirect into the real drive surface at the share's path (Phase 3 made `/d/[driveId]` role-aware at `?path`):
  ```tsx
  if (state === "ok" && data && "driveId" in data) {
    // Free + paid shares both write drive_members (Phases 2 & 4), so the
    // visitor now has real, scoped drive access. Hand off to the role-aware
    // drive surface at the share's path instead of a buyer-only view.
    window.location.href = `/d/${data.driveId}?path=${encodeURIComponent(data.path)}`;
    return (
      <main className="min-h-screen min-h-[100dvh] flex items-center justify-center text-drive-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </main>
    );
  }
  ```
  (`Loader2` is already imported on line 7; `DriveShell` import on line 8 is now unused — drop it in Step 5.)

- [ ] **Step 5: Drop the now-unused `DriveShell` import.** `ShareGate` no longer renders `DriveShell` directly. Remove line 8:
  ```diff
  -import { DriveShell } from "./drive-shell";
  ```
  Run: `grep -n "DriveShell" web/components/share-gate.tsx` Expected: no matches.

- [ ] **Step 6: Typecheck the touched files.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS (no `Cannot find module './paid-content-view'`, no unused-import error).

- [ ] **Step 7: Commit.**
  Run: `git add web/components/paid-content-view.tsx web/components/share-gate.tsx && git commit -m "$(cat <<'EOF'
refactor(web): delete PaidContentView, route shares to drive surface

Phase 2 made /s/[token] redirect into /d/[driveId]?path=... after CONSUME;
the buyer-only scoped view is now dead. ShareGate hands off to the
role-aware drive surface instead.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

---

### Task 7.2: Remove the share password (O1, write-only dead control)

**Files:**
- Modify: `web/app/api/drives/[driveId]/shares/route.ts:4` (bcrypt import), `:13-19` (zod `Body`), `:63-67` (hash + INSERT)
- Modify: `web/drizzle/schema.ts:91` (drop `password_hash` from `shares`)
- Modify: `web/drizzle/schema.js:71` (manual mirror — drop same column)
- Modify: `web/lib/db.js:54-65` (drop `password_hash TEXT` from the `CREATE TABLE shares` body)

- [ ] **Step 1: Confirm the password was never read.** It only existed at write time; the GET route (`shares/route.ts:27-30`) and `/api/s/[token]` never select it.
  Run: `grep -rn "password_hash\|\.password\b" web/app/api/drives web/app/api/s --include="*.ts" | grep -v node_modules`
  Expected: only the share POST route write site (lines 63, 65) and the `Body` field (line 17). No reader anywhere.

- [ ] **Step 2: Confirm there is no password input in the share dialog UI.** Scope mentions removing it "from the share-dialog UI" — verify it does not exist (it was route-only).
  Run: `grep -rn "password" web/components/share-dialog.tsx web/components/share-dialog-sections.tsx`
  Expected: no matches. (No UI edit needed.)

- [ ] **Step 3: Remove the bcrypt import and password field from the POST route.** In `web/app/api/drives/[driveId]/shares/route.ts`, delete line 4:
  ```diff
  -import bcrypt from "bcryptjs";
  ```
  Then in `Body`, delete the `password` field (line 17). Final `Body`:
  ```ts
  const Body = z.object({
    path: zPath.default(""),
    role: z.enum(["viewer", "editor", "owner"]),
    expiresAt: z.string().datetime().optional(),
    price_usdc: z.number().positive().optional(),
  });
  ```
  (Phase 1 already collapsed roles to `viewer|editor|owner` — `commenter` is gone from the enum.)

- [ ] **Step 4: Drop the hash + the column from the INSERT.** Replace lines 63-67:
  ```ts
  const id = nanoid(12);
  const token = nanoid(24);
  db.prepare(`
    INSERT INTO shares (id, drive_id, path, role, token, expires_at, created_by, price_usdc, payment_chain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, driveId, body.data.path, body.data.role, token, body.data.expiresAt ?? null, user.id, body.data.price_usdc ?? null, body.data.price_usdc ? "base-sepolia" : null);
  ```
  (One fewer column and one fewer bind param — `password_hash` and its `null`/`passwordHash` arg are gone.)

- [ ] **Step 5: Drop `password_hash` from the schema-of-record (`schema.ts`).** In `web/drizzle/schema.ts`, delete line 91:
  ```diff
       token: text("token").notNull().unique(),
  -    password_hash: text("password_hash"),
       expires_at: text("expires_at"),
  ```
  (Leave the `users.password_hash` column on line 18 untouched — that is account auth, unrelated.)

- [ ] **Step 6: Drop the same column from the JS mirror (`schema.js`).** Per repo convention (`schema.js` hand-mirrors `schema.ts`), delete the matching line in `web/drizzle/schema.js` (line 71):
  ```diff
       token: text("token").notNull().unique(),
  -    password_hash: text("password_hash"),
       expires_at: text("expires_at"),
  ```

- [ ] **Step 7: Drop the column from the runtime `CREATE TABLE` (the real "migration").** There are no drizzle-kit migration files; `web/lib/db.js` is the schema-of-record applied at startup. In the `CREATE TABLE IF NOT EXISTS shares (...)` body remove the `password_hash TEXT,` line (line 60):
  ```diff
         token TEXT UNIQUE NOT NULL,
  -      password_hash TEXT,
         expires_at TEXT,
  ```
  Note in the commit body: fresh DBs no longer get the column; existing dev DBs keep an inert nullable `password_hash` (SQLite has no cheap `DROP COLUMN` and demo data is discardable per the redesign), and nothing reads it.

- [ ] **Step 8: Typecheck + build.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS (no reference to `bcrypt`/`password_hash` in the shares route; drizzle `shares` type no longer has `password_hash`).
  Run: `npm --prefix web run build`
  Expected: PASS.

- [ ] **Step 9: Commit.**
  Run: `git add web/app/api/drives/\[driveId\]/shares/route.ts web/drizzle/schema.ts web/drizzle/schema.js web/lib/db.js && git commit -m "$(cat <<'EOF'
refactor(web): remove write-only share password (O1)

password_hash on shares was written but never read — no verify path ever
existed and no UI collected it. Dropped from the POST route, the drizzle
schema (ts + js mirror), and the runtime CREATE TABLE in lib/db.js.
Existing dev DBs keep an inert nullable column; nothing reads it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

---

### Task 7.3: Remove the free-share cookie path

**Files:**
- Delete: `web/lib/share-grant.ts`
- Modify: `web/app/api/s/[token]/route.ts:10` (drop `addShareGrant` import), `:58-66` (drop the free-share `addShareGrant` branch — free shares now CONSUME via `POST /api/s/[token]/accept` after login)
- Modify: `web/lib/dochub.js:68-83` (drop `readShareGrantsFromCookie`), `:100-138` (drop the share-token branch + the `aindrive_share` read in `onDocConnect`)

> Assumes Phase 5 already removed `readShareGrants`/`resolveRoleByShareGrants` from `web/lib/access.ts` and collapsed `resolveAccess` to user-only. This task removes the remaining producers/readers of the cookie. (Back-compat note: this is the post-window removal — links issued before Phase 2 that relied on the cookie now require login + CONSUME.)

- [ ] **Step 1: Inventory every remaining reference to the cookie path.**
  Run: `grep -rn "share-grant\|addShareGrant\|readShareGrants\|aindrive_share\|resolveRoleByShareGrants\|readShareGrantsFromCookie" web --include="*.ts" --include="*.tsx" --include="*.js" | grep -v node_modules`
  Expected (post-Phase-5): producers/readers limited to `web/lib/share-grant.ts`, `web/app/api/s/[token]/route.ts`, and `web/lib/dochub.js`. (If `web/lib/access.ts` still appears here, Phase 5 was not applied — stop and reconcile.)

- [ ] **Step 2: Delete the cookie helper module.**
  Run: `rm web/lib/share-grant.ts`
  Expected: exit 0.

- [ ] **Step 3: Drop the `addShareGrant` import + free-share write branch from the share GET route.** In `web/app/api/s/[token]/route.ts` delete line 10:
  ```diff
  -import { addShareGrant } from "@/lib/share-grant";
  ```
  Then replace the free-share branch (lines 58-66):
  ```ts
  // old:
  if (!share.price_usdc) {
    await addShareGrant(token);
    return NextResponse.json(okBody);
  }
  ```
  with the cookie-free version — a free share still resolves OK here; the actual grant is written by `POST /api/s/[token]/accept` after login (Phase 2):
  ```ts
  // Free share resolves OK here; the visitor gets real, scoped access only
  // after login via POST /api/s/[token]/accept (which upserts drive_members).
  // No signed cookie is issued — drive_members is the single access source.
  if (!share.price_usdc) {
    return NextResponse.json(okBody);
  }
  ```

- [ ] **Step 4: Remove the cookie reader from dochub.** In `web/lib/dochub.js` delete the `readShareGrantsFromCookie` function (the block at lines 68-83, including its leading comment):
  ```diff
  -// Free-share grant tokens from the aindrive_share cookie. Mirrors
  -// lib/share-grant.ts (readShareGrants), but reads from the raw WS cookie
  -// header instead of next/headers (which is unavailable under raw node).
  -async function readShareGrantsFromCookie(cookieHeader) {
  -  const m = /aindrive_share=([^;]+)/.exec(cookieHeader || "");
  -  if (!m) return [];
  -  try {
  -    const { payload } = await jwtVerify(m[1], enc.encode(getSessionSecret()));
  -    return Array.isArray(payload.tokens) ? payload.tokens : [];
  -  } catch { return []; }
  -}
  ```

- [ ] **Step 5: Drop the share-token branch from dochub's `resolveRole`.** The WS `resolveRole` (lines ~84-130) mirrors the collapsed `resolveAccess`: session/member only (Phase 5 removed the wallet + cookie fallbacks from the HTTP side). Reduce it to the user-member path. Replace the function with:
  ```js
  // Mirrors lib/access.ts resolveAccess (collapsed in Phase 5): owner or
  // drive_members only. drive_members is the single access source — free
  // and paid shares both write rows there via the HTTP accept/settle flows.
  function resolveRole(driveId, userId, path) {
    const target = normalizePath(path);
    const drive = db.prepare("SELECT owner_id FROM drives WHERE id = ?").get(driveId);
    if (!drive) return "none";
    if (userId && drive.owner_id === userId) return "owner";
    const rows = userId
      ? db
          .prepare("SELECT path, role FROM drive_members WHERE drive_id = ? AND user_id = ?")
          .all(driveId, userId)
      : [];
    return bestMatchingRole(rows, target);
  }
  ```
  (The `address`/`folder_access` and `shareTokens`/`pickFreeShareRole` branches are gone — `folder_access` was dropped in Phase 5 and `pickFreeShareRole` deleted in Phase 5.)

- [ ] **Step 6: Update `onDocConnect` to stop reading wallet/share cookies.** In `web/lib/dochub.js`, the connect handler (lines ~131-138) currently `Promise.all`s three cookie reads. Reduce to the session read and drop the wallet read too (Phase 5 collapsed access to user-only):
  ```js
  const cookie = req.headers["cookie"];
  const userId = await readUserFromCookie(cookie);
  const role = resolveRole(driveId, userId, path);
  if (ROLE_RANK[role] < ROLE_RANK.viewer) { ws.close(4401, "no access"); return; }

  const docId = docIdFor(driveId, path);
  const peer = { ws, role, userId, docId };
  ```
  (`address` is no longer resolved; if `readWalletFromCookie` becomes unreferenced after this, remove its definition + the `peer.address` field. Verify with the grep in Step 8.)

- [ ] **Step 7: Confirm no `pickFreeShareRole` import dangles in dochub.** Phase 5 deleted `pickFreeShareRole` from `access-core.js`; dochub must not import it.
  Run: `grep -n "pickFreeShareRole" web/lib/dochub.js`
  Expected: no matches. (If present, remove it from the `import { ... } from "./access-core.js"` line — keep `ROLE_RANK`, `bestMatchingRole`, `normalizePath`.)

- [ ] **Step 8: Verify the cookie path is fully gone.**
  Run: `grep -rn "share-grant\|addShareGrant\|readShareGrants\|aindrive_share\|resolveRoleByShareGrants\|readShareGrantsFromCookie" web --include="*.ts" --include="*.tsx" --include="*.js" | grep -v node_modules`
  Expected: no matches.
  Run: `grep -rn "readWalletFromCookie\|getWallet\b" web/lib/dochub.js`
  Expected: no matches (or, if some other dochub feature still needs the wallet, only that justified site).

- [ ] **Step 9: Typecheck + build.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS (no `Cannot find module '@/lib/share-grant'`).
  Run: `npm --prefix web run build`
  Expected: PASS.

- [ ] **Step 10: Commit.**
  Run: `git add web/lib/share-grant.ts web/app/api/s/\[token\]/route.ts web/lib/dochub.js && git commit -m "$(cat <<'EOF'
refactor(web): remove free-share grant cookie path

drive_members is now the single access source: free shares write a member
row via POST /api/s/[token]/accept (Phase 2), so the signed aindrive_share
cookie is dead. Deleted lib/share-grant.ts, the addShareGrant write in the
share GET route, and dochub's readShareGrantsFromCookie + share-token
branch. dochub.resolveRole now mirrors the collapsed resolveAccess
(owner/drive_members only). Post-window removal — pre-Phase-2 cookie links
now require login + CONSUME.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

---

### Task 7.4: Make management gates honor co-ownership (D2)

**Files:**
- Modify: `web/app/api/drives/[driveId]/members/route.ts:7` (import `resolveRole`), `:39` (replace `drive.owner_id !== user.id` with an `atLeast(role, "owner")` gate)
- Create: `web/lib/__tests__/member-invite-gate.test.ts` (pure-logic test; lives under `lib/` so `vitest run lib/` picks it up)

> D2: co-owners are `drive_members` rows with `role=owner`. The invite gate currently checks `drive.owner_id === user.id` (creator only), which locks co-owners out of inviting. The fix uses `resolveRole(driveId, user.id, "")` + `atLeast(role, "owner")`. `resolveRoleByUser` already returns `"owner"` for both `drives.owner_id` and `role=owner` member rows, so this is a one-line gate swap. The `DELETE`/`PATCH` member routes (Phase 6) already owner-gate via `atLeast`; this task aligns the invite POST with them.

- [ ] **Step 1: Write a failing pure-logic test for the gate decision.** The route's gate decision is `atLeast(resolveRoleByUser(...), "owner")`; we can unit-test the `atLeast`-over-`bestMatchingRole` composition without a DB, asserting a `role=owner` member row at root passes the gate while an `editor` does not. Create `web/lib/__tests__/member-invite-gate.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import { atLeast, bestMatchingRole, type Role } from "../access-core.js";
  import { type NormalizedPath } from "../path";

  // The invite gate is: atLeast(resolveRoleByUser(driveId, user, ""), "owner").
  // resolveRoleByUser returns "owner" for both drives.owner_id and a
  // drive_members row with role="owner" (D2: co-owners). Here we exercise the
  // member-row half: a root-scoped owner member must clear the gate; an editor
  // must not.
  type Row = { path: NormalizedPath; role: Role };
  const n = (s: string) => s as NormalizedPath;
  const gate = (rows: Row[]) => atLeast(bestMatchingRole(rows, n("")), "owner");

  describe("member invite gate (D2 co-ownership)", () => {
    it("co-owner member (role=owner at root) clears the owner gate", () => {
      expect(gate([{ path: n(""), role: "owner" }])).toBe(true);
    });
    it("editor member does NOT clear the owner gate", () => {
      expect(gate([{ path: n(""), role: "editor" }])).toBe(false);
    });
    it("no member rows => gate closed", () => {
      expect(gate([])).toBe(false);
    });
  });
  ```
  Run: `npm --prefix web test lib/__tests__/member-invite-gate.test.ts`
  Expected: PASS immediately — this test pins the *helper* contract Phase 1 already established (`owner` rank > `editor`), guarding against a future regression in `ROLE_RANK`. (It is a guard test, not red-green for new helper code; the route change in Step 2 is what consumes it.)

- [ ] **Step 2: Swap the invite gate to `atLeast(role, "owner")`.** In `web/app/api/drives/[driveId]/members/route.ts`, the import on line 7 is `import { resolveRole, atLeast } from "@/lib/access";` (already imports both). Replace the creator-only gate on line 39:
  ```diff
  -  if (drive.owner_id !== user.id) return NextResponse.json({ error: "only owner can invite" }, { status: 403 });
  +  // D2: co-owners (drive_members role=owner) may invite too, not just the
  +  // creator. resolveRole returns "owner" for both drives.owner_id and an
  +  // owner-role member row.
  +  const role = resolveRole(driveId, user.id, "");
  +  if (!atLeast(role, "owner")) return NextResponse.json({ error: "only owner can invite" }, { status: 403 });
  ```
  (Also confirm the `Body` role enum here is `["viewer", "editor", "owner"]` — Phase 1 dropped `commenter`. The file as drafted still lists `commenter` on line 13; if Phase 1 missed it, fix to `z.enum(["viewer", "editor", "owner"])` in the same commit.)

- [ ] **Step 3: Re-run the gate test.**
  Run: `npm --prefix web test lib/__tests__/member-invite-gate.test.ts`
  Expected: PASS.

- [ ] **Step 4: Typecheck.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS (`resolveRole` and `atLeast` are both exported from `@/lib/access`).

- [ ] **Step 5: Commit.**
  Run: `git add web/app/api/drives/\[driveId\]/members/route.ts web/lib/__tests__/member-invite-gate.test.ts && git commit -m "$(cat <<'EOF'
fix(web): invite gate honors co-owners (D2)

Members route POST gated on drives.owner_id === user.id, locking out
co-owners (drive_members role=owner). Switch to atLeast(resolveRole(...,
""), "owner"), which resolveRoleByUser already returns "owner" for both the
creator and owner-role member rows. Adds a helper-contract guard test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

---

### Task 7.5: Final verification — typecheck, test, build all green

**Files:**
- Test/verify only (no source changes; add fixes here only if a check fails)

- [ ] **Step 1: Full typecheck.**
  Run: `npm --prefix web run typecheck`
  Expected: PASS — no dangling imports of `paid-content-view`, `@/lib/share-grant`, `bcrypt` (in shares route), `password_hash` (in `shares` drizzle type), `pickFreeShareRole`/`resolveRoleByShareGrants`/`readShareGrants`.

- [ ] **Step 2: Unit tests (vitest, `lib/` only — matches `npm test` = `vitest run lib/`).**
  Run: `npm --prefix web test`
  Expected: PASS, including `lib/__tests__/member-invite-gate.test.ts`. Note: `lib/__tests__/access-core.test.ts` still references `pickFreeShareRole`; if Phase 5 already deleted that helper, that test file was removed/updated in Phase 5 — if it still imports `pickFreeShareRole` and now fails to import, that is a Phase-5 regression, not Phase 7. Confirm with `grep -n pickFreeShareRole web/lib/__tests__/access-core.test.ts`; if present, the Phase 5 hand-off was incomplete — reconcile before claiming green.

- [ ] **Step 3: Production build.**
  Run: `npm --prefix web run build`
  Expected: PASS — Next.js compiles every route (`/api/s/[token]`, `/api/drives/[driveId]/shares`, `/api/drives/[driveId]/members`) and client components (`share-gate.tsx`, `share-dialog.tsx`) with no missing-module or type errors.

- [ ] **Step 4: Final dead-surface sweep (belt-and-suspenders).**
  Run: `grep -rn "PaidContentView\|paid-content-view\|share-grant\|addShareGrant\|aindrive_share\|password_hash" web --include="*.ts" --include="*.tsx" --include="*.js" | grep -v node_modules | grep -v "users\b"`
  Expected: only `users.password_hash` references survive (account auth — out of scope). No share-password, no cookie, no PaidContentView matches.

- [ ] **Step 5: Commit (only if Steps 1-4 required a fix; otherwise skip — nothing to commit).**
  Run: `git commit -am "$(cat <<'EOF'
chore(web): phase 7 verification fixups

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

---

Relevant absolute paths used to ground this plan: `/Users/comcom/Git/aindrive/.claude/worktrees/unified-shared-drive/web/components/paid-content-view.tsx`, `.../web/components/share-gate.tsx`, `.../web/components/share-dialog.tsx`, `.../web/components/share-dialog-sections.tsx`, `.../web/lib/share-grant.ts`, `.../web/lib/dochub.js`, `.../web/lib/access.ts`, `.../web/lib/access-core.js`, `.../web/lib/db.js`, `.../web/drizzle/schema.ts`, `.../web/drizzle/schema.js`, `.../web/drizzle.config.ts`, `.../web/app/api/drives/[driveId]/shares/route.ts`, `.../web/app/api/drives/[driveId]/members/route.ts`, `.../web/app/api/s/[token]/route.ts`, `.../web/lib/__tests__/access-core.test.ts`.
