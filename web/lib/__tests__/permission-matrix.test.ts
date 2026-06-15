// Executable mirror of docs/PERMISSIONS_MATRIX.md. Each test name carries the
// requirement ID from that file. CURRENT requirements are asserted; TARGET
// requirements that need code beyond the pure rule are `it.todo` — the
// build-this checklist. Keep this file and the matrix doc in lockstep: a
// permission change edits the doc row, then the matching test here.
import { describe, it, expect } from "vitest";
import {
  atLeast,
  bestMatchingRole,
  canReadContent,
  type Role,
  type RoleOrNone,
} from "../access-core.js";
import { type NormalizedPath } from "../path";

type Row = { path: NormalizedPath; role: Role };
const n = (s: string) => s as NormalizedPath;

// ── §1 Content access — the paid carve-out rule (R-ACC-*) ───────────────────
// canReadContent(role, classification, hasEntitlement) is the pure decision.
// This truth table IS the §1 matrix; every cell is a requirement.
describe("§1 canReadContent — read access by role × classification × entitlement", () => {
  type Case = { role: RoleOrNone; cls: "free" | "paid"; ent: boolean; want: boolean; req: string };
  const cases: Case[] = [
    // free: viewer+ read; none denied (entitlement irrelevant on free).
    { role: "none", cls: "free", ent: false, want: false, req: "R-ACC-FREE-001" },
    { role: "none", cls: "free", ent: true, want: false, req: "R-ACC-FREE-001 (entitlement irrelevant on free)" },
    { role: "viewer", cls: "free", ent: false, want: true, req: "R-ACC-FREE-001" },
    { role: "editor", cls: "free", ent: false, want: true, req: "R-ACC-FREE-001" },
    { role: "owner", cls: "free", ent: false, want: true, req: "R-ACC-FREE-001" },
    // paid, no entitlement: viewer carved OUT; editor+ (managers) keep access.
    { role: "none", cls: "paid", ent: false, want: false, req: "R-ACC-PAID-001" },
    { role: "viewer", cls: "paid", ent: false, want: false, req: "R-ACC-PAID-001 (the change: bare viewer ≠ access)" },
    { role: "editor", cls: "paid", ent: false, want: true, req: "R-ACC-PAID-002 (manager)" },
    { role: "owner", cls: "paid", ent: false, want: true, req: "R-ACC-PAID-002 (manager)" },
    // paid, entitled: access regardless of role (comp/receipt without a grant).
    { role: "none", cls: "paid", ent: true, want: true, req: "R-ACC-PAID-003 (entitlement without role)" },
    { role: "viewer", cls: "paid", ent: true, want: true, req: "R-ACC-PAID-003 (buyer)" },
    { role: "editor", cls: "paid", ent: true, want: true, req: "R-ACC-PAID-002" },
    { role: "owner", cls: "paid", ent: true, want: true, req: "R-ACC-PAID-002" },
  ];
  it.each(cases)("$req — role=$role cls=$cls ent=$ent ⇒ $want", ({ role, cls, ent, want }) => {
    expect(canReadContent(role, cls, ent)).toBe(want);
  });

  it("R-ACC-* — rejects unmodelled classifications (private/public are §10 future) so a miswired caller fails loud", () => {
    // @ts-expect-error intentionally passing an out-of-contract classification
    expect(() => canReadContent("viewer", "private", false)).toThrow();
    // @ts-expect-error intentionally passing an out-of-contract classification
    expect(() => canReadContent("viewer", "public", false)).toThrow();
  });
});

// ── Composed (end-to-end pure): resolve role, then apply the carve-out ───────
// Demonstrates the user-facing intent: a whole-drive viewer does NOT get paid
// content for free, but a buyer / comp / manager does.
describe("§1 composed — bestMatchingRole ∘ canReadContent", () => {
  const wholeDriveViewer: Row[] = [{ path: n(""), role: "viewer" }];
  const target = n("premium/report.pdf");

  it("R-ACC-PAID-001 — whole-drive viewer is denied a paid subtree without entitlement", () => {
    const role = bestMatchingRole(wholeDriveViewer, target);
    expect(role).toBe("viewer"); // covered by the path="" grant…
    expect(canReadContent(role, "paid", /*hasEntitlement*/ false)).toBe(false); // …but paid carves it out
  });

  it("R-ACC-PAID-003 — same viewer WITH a covering receipt/comp is allowed", () => {
    const role = bestMatchingRole(wholeDriveViewer, target);
    expect(canReadContent(role, "paid", true)).toBe(true);
  });

  it("R-ACC-PAID-002 — a whole-drive editor reads the paid subtree (manager)", () => {
    const role = bestMatchingRole([{ path: n(""), role: "editor" }], target);
    expect(canReadContent(role, "paid", false)).toBe(true);
  });

  it("R-ACC-FREE-001 — the same viewer still reads free content in scope", () => {
    const role = bestMatchingRole(wholeDriveViewer, n("docs/readme.md"));
    expect(canReadContent(role, "free", false)).toBe(true);
  });
});

// ── §3 Writes are never paywalled (invariant to preserve) ───────────────────
describe("§3 write ops ignore the paywall (R-ACC-PAID-004 / R-WRITE-003)", () => {
  it("editor+ is the write gate; the carve-out is read-only", () => {
    // Write gating stays role-only: atLeast(role,"editor"). canReadContent is
    // not consulted for writes, and editor+ reads paid content anyway.
    expect(atLeast("editor", "editor")).toBe(true);
    expect(atLeast("viewer", "editor")).toBe(false);
    expect(canReadContent("editor", "paid", false)).toBe(true);
  });
});

// ── TARGET wiring & future requirements — the build-this checklist ──────────
// These need code beyond the pure rule; convert each todo to a real test when
// implemented. IDs match docs/PERMISSIONS_MATRIX.md.
describe("TARGET — not yet implemented (see PERMISSIONS_MATRIX.md)", () => {
  it.todo("R-WIRE-001: fs/{read,download,list,stream} + yjs-read call canReadContent (today they gate on role only — viewer wrongly reads paid)");
  it.todo("R-WIRE-002: a nearest-ancestor `classify(path)` helper over `shares` (mirror payoutWalletFor) returns free|paid + gate path");
  it.todo("R-ACC-NEST-001: entitlement must cover the nearest-ancestor gate path; buying a parent does not unlock a separately-priced child");
  it.todo("R-PAY-ENT-001: the receipt (not the auto-written member row) is the access proof for a paid path");
  it.todo("R-COMP-001: owner can comp a paid path to an account (free read, no edit rights), revocable + auditable");
  it.todo("R-COMP-002: comp entitlements in a separate comp_grants table (decided); paid read gate checks payment_receipts OR comp_grants, nearest-ancestor");
  it.todo("R-VIS-PAID-001: folder listings mark non-entitled paid children as locked (visible, not hidden)");
  it.todo("R-STORE-003: after the carve-out a whole-drive viewer sees the storefront for paid items");
  it.todo("R-AGENT-WS-002: a shared test binds dochub.js role resolution to access.ts (no silent drift)");
  // DEFERRED, not planned (PERMISSIONS_MATRIX.md §10): private (free-but-restricted)
  // and public (anonymous) classifications. canReadContent intentionally rejects them.
});
