import { describe, it, expect, beforeEach } from "vitest";
import { openSession, sessionLoaded, sessionUpdate, writeVerdict, crossFileMatch, _resetRecentLoads } from "../editor-session";

const AINIZE = '{ "kind": "service", "name": "clef" }\n';
const ART = "import torch\nprint('search')\n";

describe("editor-session (incident: ainize.json written into art_search.py on a fast file switch)", () => {
  beforeEach(() => _resetRecentLoads());

  it("switch-files-fast: the first file's flush can no longer write under the second file's path", () => {
    // open ainize.json, it loads, the user types
    const a = openSession("drv", "repo/ainize.json");
    sessionLoaded(a, AINIZE);
    sessionUpdate(a, "local");
    const edited = AINIZE + "// note\n";
    // user clicks art_search.py: the component now shows session b
    const b = openSession("drv", "repo/art_search.py");
    expect(b.generation).toBeGreaterThan(a.generation);
    // a's cleanup flushes its debounce; before the fix the flush used the latest
    // render's path (b) with a's doc. Now a's text may only go to a's path, and
    // only while a is the active session — it is not.
    expect(writeVerdict(a, b, edited)).toMatchObject({ ok: false, reason: "stale-session" });
    expect(writeVerdict(a, null, edited)).toMatchObject({ ok: false, reason: "stale-session" });
    // b's own disk read lands; b is clean → nothing to write either
    sessionLoaded(b, ART);
    expect(writeVerdict(b, b, ART)).toMatchObject({ ok: false, reason: "not-dirty" });
  });

  it("hard safety: content equal to another recently-loaded file is refused even for the active session", () => {
    const a = openSession("drv", "repo/ainize.json");
    sessionLoaded(a, AINIZE);
    const b = openSession("drv", "repo/art_search.py");
    sessionLoaded(b, ART);
    sessionUpdate(b, "local");
    // somehow b's doc now holds ainize.json's bytes
    expect(crossFileMatch("drv", "repo/art_search.py", AINIZE)).toBe("repo/ainize.json");
    expect(writeVerdict(b, b, AINIZE)).toMatchObject({ ok: false, reason: "cross-file" });
    expect(writeVerdict(b, b, AINIZE, { requireDirty: false })).toMatchObject({ ok: false, reason: "cross-file" });
    // a genuine edit of b is fine
    expect(writeVerdict(b, b, ART + "x = 1\n")).toEqual({ ok: true });
    // other drives and empty content do not collide
    expect(crossFileMatch("other", "repo/art_search.py", AINIZE)).toBe(null);
    expect(crossFileMatch("drv", "repo/empty.txt", "\n")).toBe(null);
  });

  it("a reopened path gets a fresh session; the old one is stale", () => {
    const a1 = openSession("drv", "x.txt");
    sessionLoaded(a1, "one");
    sessionUpdate(a1, "local");
    const a2 = openSession("drv", "x.txt");
    expect(writeVerdict(a1, a2, "one two")).toMatchObject({ ok: false, reason: "stale-session" });
    sessionLoaded(a2, "one");
    sessionUpdate(a2, "local");
    expect(writeVerdict(a2, a2, "one two")).toEqual({ ok: true });
    expect(writeVerdict(a2, a2, "one")).toMatchObject({ ok: false, reason: "unchanged" });
  });
});
