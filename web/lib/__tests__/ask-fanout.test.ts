import { describe, expect, it } from "vitest";
import { FANOUT_MAX, FANOUT_WINDOW_MS, ridesAlong } from "../ask-fanout";

describe("one question over many drives is one ask", () => {
  it("charges the first call of a question, not the rest", () => {
    const id = "q_" + "a".repeat(20);
    expect(ridesAlong("ip1", id, 1000)).toBe(false);
    for (let i = 0; i < 6; i++) expect(ridesAlong("ip1", id, 1000 + i)).toBe(true);
  });
  it("an id is per client, bounded in uses and time, and must look random", () => {
    const id = "q_" + "b".repeat(20);
    expect(ridesAlong("ip1", id, 0)).toBe(false);
    expect(ridesAlong("ip2", id, 1)).toBe(false);   // another client pays for its own
    for (let i = 0; i < FANOUT_MAX; i++) expect(ridesAlong("ip1", id, 2)).toBe(true);
    expect(ridesAlong("ip1", id, 3)).toBe(false);   // past the fan-out size: charged again
    expect(ridesAlong("ip1", "q_" + "c".repeat(20), 0)).toBe(false);
    expect(ridesAlong("ip1", "q_" + "c".repeat(20), FANOUT_WINDOW_MS + 1)).toBe(false);   // stale: charged again
    expect(ridesAlong("ip1", "short", 0)).toBe(false);
    expect(ridesAlong("ip1", null, 0)).toBe(false);
  });
});
