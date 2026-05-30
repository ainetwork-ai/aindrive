import { describe, it, expect } from "vitest";
import { ROLE_RANK, atLeast, bestMatchingRole, pickFreeShareRole, type Role } from "../access-core.js";
import { type NormalizedPath } from "../path";

type Row = { path: NormalizedPath; role: Role };
const n = (s: string) => s as NormalizedPath;

type ShareRow = {
  drive_id: string;
  path: NormalizedPath;
  role: Role;
  price_usdc: number | null;
  expires_at: string | null;
};
const share = (over: Partial<ShareRow>): ShareRow => ({
  drive_id: "d1",
  path: n(""),
  role: "viewer",
  price_usdc: null,
  expires_at: null,
  ...over,
});

describe("ROLE_RANK", () => {
  it("orders roles strictly", () => {
    expect(ROLE_RANK.none).toBe(0);
    expect(ROLE_RANK.viewer).toBeGreaterThan(ROLE_RANK.none);
    expect(ROLE_RANK.commenter).toBeGreaterThan(ROLE_RANK.viewer);
    expect(ROLE_RANK.editor).toBeGreaterThan(ROLE_RANK.commenter);
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.editor);
  });
});

describe("atLeast", () => {
  it("compares ranks", () => {
    expect(atLeast("editor", "viewer")).toBe(true);
    expect(atLeast("viewer", "editor")).toBe(false);
    expect(atLeast("none", "viewer")).toBe(false);
    expect(atLeast("owner", "owner")).toBe(true);
  });
  it("treats unknown role names as none", () => {
    expect(atLeast("garbage", "viewer")).toBe(false);
    expect(atLeast("viewer", "garbage")).toBe(true);
  });
});

describe("bestMatchingRole", () => {
  it("returns 'none' when no row matches", () => {
    expect(bestMatchingRole([], n("docs/q1"))).toBe("none");
    expect(bestMatchingRole([{ path: n("other"), role: "editor" }], n("docs/q1"))).toBe("none");
  });

  it("returns the highest-rank role among matching ancestors", () => {
    const rows: Row[] = [
      { path: n(""), role: "viewer" },             // drive-wide viewer
      { path: n("docs"), role: "commenter" },      // covers target
      { path: n("docs/q1"), role: "editor" },      // exact cover
      { path: n("docs/q2"), role: "owner" },       // does NOT cover docs/q1
    ];
    expect(bestMatchingRole(rows, n("docs/q1"))).toBe("editor");
  });

  it("returns drive-wide grant when target has no specific ancestor", () => {
    const rows: Row[] = [
      { path: n(""), role: "viewer" },
      { path: n("specific"), role: "editor" },
    ];
    expect(bestMatchingRole(rows, n("unrelated"))).toBe("viewer");
  });

  it("respects exact match", () => {
    const rows: Row[] = [{ path: n("docs/q1"), role: "owner" }];
    expect(bestMatchingRole(rows, n("docs/q1"))).toBe("owner");
    expect(bestMatchingRole(rows, n("docs/q1/note.md"))).toBe("owner");
  });

  it("rejects similar-but-not-ancestor (path prefix without slash boundary)", () => {
    const rows: Row[] = [{ path: n("docs"), role: "editor" }];
    expect(bestMatchingRole(rows, n("document"))).toBe("none");
  });
});

describe("pickFreeShareRole", () => {
  const NOW = new Date("2026-05-30T00:00:00Z");

  it("grants a free share's role when path matches", () => {
    const rows = [share({ path: n("research"), role: "viewer", price_usdc: null })];
    expect(pickFreeShareRole(rows, "d1", n("research/notes.md"), NOW)).toBe("viewer");
  });

  it("SECURITY: a paid share (price set) does NOT grant via the free path", () => {
    // This is the paywall-bypass guard. Even if a paid share's token ends
    // up in the grant cookie, price_usdc != null must block it.
    const rows = [share({ path: n("research"), role: "editor", price_usdc: 0.5 })];
    expect(pickFreeShareRole(rows, "d1", n("research/notes.md"), NOW)).toBe("none");
  });

  it("ignores shares belonging to a different drive", () => {
    const rows = [share({ drive_id: "other", path: n(""), role: "viewer" })];
    expect(pickFreeShareRole(rows, "d1", n("anything"), NOW)).toBe("none");
  });

  it("ignores expired free shares", () => {
    const rows = [share({ path: n(""), role: "viewer", expires_at: "2020-01-01T00:00:00Z" })];
    expect(pickFreeShareRole(rows, "d1", n("x"), NOW)).toBe("none");
  });

  it("honors a future expiry", () => {
    const rows = [share({ path: n(""), role: "viewer", expires_at: "2099-01-01T00:00:00Z" })];
    expect(pickFreeShareRole(rows, "d1", n("x"), NOW)).toBe("viewer");
  });

  it("rejects when the share path is not an ancestor of the target", () => {
    const rows = [share({ path: n("research"), role: "viewer" })];
    expect(pickFreeShareRole(rows, "d1", n("private/secret.md"), NOW)).toBe("none");
  });

  it("picks the highest role across multiple matching free shares", () => {
    const rows = [
      share({ path: n(""), role: "viewer" }),
      share({ path: n("docs"), role: "editor" }),
      share({ path: n("docs"), role: "commenter" }),
    ];
    expect(pickFreeShareRole(rows, "d1", n("docs/a.md"), NOW)).toBe("editor");
  });

  it("returns none for an empty row set", () => {
    expect(pickFreeShareRole([], "d1", n("x"), NOW)).toBe("none");
  });

  it("a drive-root free share grants the whole drive", () => {
    const rows = [share({ path: n(""), role: "viewer" })];
    expect(pickFreeShareRole(rows, "d1", n("deep/nested/file.md"), NOW)).toBe("viewer");
  });
});
