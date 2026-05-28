import { describe, it, expect } from "vitest";
import { ROLE_RANK, atLeast, bestMatchingRole, type Role } from "../access-core.js";
import { type NormalizedPath } from "../path";

type Row = { path: NormalizedPath; role: Role };
const n = (s: string) => s as NormalizedPath;

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
