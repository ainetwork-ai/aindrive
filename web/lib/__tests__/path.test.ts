import { describe, it, expect } from "vitest";
import { normalizePath, isAncestorOrSelf, PathError, type NormalizedPath } from "../path";

// Construct a string containing a real U+0000 without putting a raw NUL
// byte in this source file (keeps git from treating it as binary).
const NUL = String.fromCharCode(0);

// Test helper: assert that a literal is already in canonical form. Used
// in isAncestorOrSelf tests where we want to drive the comparator with
// hand-crafted strings without re-running normalizePath each time.
const n = (s: string) => s as NormalizedPath;

describe("normalizePath", () => {
  it("returns empty string for empty/root variants", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("/")).toBe("");
    expect(normalizePath("./")).toBe("");
    expect(normalizePath(".")).toBe("");
  });

  it("strips leading and trailing slashes", () => {
    expect(normalizePath("/docs")).toBe("docs");
    expect(normalizePath("docs/")).toBe("docs");
    expect(normalizePath("/docs/q1/")).toBe("docs/q1");
  });

  it("collapses consecutive slashes", () => {
    expect(normalizePath("docs//q1")).toBe("docs/q1");
    expect(normalizePath("docs///q1////note")).toBe("docs/q1/note");
  });

  it("strips ./ segments anywhere", () => {
    expect(normalizePath("./docs/./q1")).toBe("docs/q1");
    expect(normalizePath("docs/./q1/./note")).toBe("docs/q1/note");
  });

  it("rejects '..' segments", () => {
    expect(() => normalizePath("docs/../etc")).toThrow(PathError);
    expect(() => normalizePath("..")).toThrow(PathError);
    expect(() => normalizePath("../docs")).toThrow(PathError);
  });

  it("rejects null bytes", () => {
    expect(() => normalizePath("docs" + NUL + "q1")).toThrow(PathError);
  });

  it("rejects non-string inputs", () => {
    expect(() => normalizePath(undefined as unknown as string)).toThrow(PathError);
    expect(() => normalizePath(null as unknown as string)).toThrow(PathError);
    expect(() => normalizePath(42 as unknown as string)).toThrow(PathError);
  });

  it("preserves single-segment paths", () => {
    expect(normalizePath("docs")).toBe("docs");
    expect(normalizePath("a")).toBe("a");
  });

  it("preserves multi-segment paths", () => {
    expect(normalizePath("a/b/c")).toBe("a/b/c");
  });

  it("handles dotfiles correctly (not as ./)", () => {
    expect(normalizePath(".env")).toBe(".env");
    expect(normalizePath("docs/.config")).toBe("docs/.config");
  });
});

describe("isAncestorOrSelf", () => {
  it("empty ancestor matches anything", () => {
    expect(isAncestorOrSelf(n(""), n(""))).toBe(true);
    expect(isAncestorOrSelf(n(""), n("docs"))).toBe(true);
    expect(isAncestorOrSelf(n(""), n("docs/q1/note.md"))).toBe(true);
  });

  it("exact match returns true", () => {
    expect(isAncestorOrSelf(n("docs"), n("docs"))).toBe(true);
    expect(isAncestorOrSelf(n("docs/q1"), n("docs/q1"))).toBe(true);
  });

  it("true ancestor returns true", () => {
    expect(isAncestorOrSelf(n("docs"), n("docs/q1"))).toBe(true);
    expect(isAncestorOrSelf(n("docs/q1"), n("docs/q1/note.md"))).toBe(true);
  });

  it("similar but not ancestor returns false", () => {
    expect(isAncestorOrSelf(n("docs"), n("document"))).toBe(false);
    expect(isAncestorOrSelf(n("docs/q"), n("docs/q1"))).toBe(false);
    expect(isAncestorOrSelf(n("docs/q1"), n("docs/q12"))).toBe(false);
  });

  it("siblings return false", () => {
    expect(isAncestorOrSelf(n("docs/q1"), n("docs/q2"))).toBe(false);
  });

  it("contract: assumes inputs are pre-normalized (does NOT trim slashes)", () => {
    // If callers don't normalize first, mismatches slip through.
    // The NormalizedPath brand prevents this at compile time in production
    // code; here we deliberately cast un-normalized strings via n() to
    // verify the runtime contract.
    expect(isAncestorOrSelf(n("docs/"), n("docs/q1"))).toBe(false);
    expect(isAncestorOrSelf(n("/docs"), n("docs/q1"))).toBe(false);
  });
});
