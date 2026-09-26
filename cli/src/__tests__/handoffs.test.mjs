import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupHandoff, readHandoff } from "../handoffs.js";

describe("handoff-read (Mac app handoffs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoffs-"));
  const file = join(dir, "doc.txt");
  writeFileSync(file, "hello handoff");
  const reg = join(dir, "handoffs.json");
  writeFileSync(reg, JSON.stringify({
    live: { path: file, expiresAt: Date.now() + 60_000 },
    old: { path: file, expiresAt: Date.now() - 1 },
  }));

  it("serves a registered key's bytes in chunks, with the size", async () => {
    const a = await readHandoff("live", 0, 5, reg);
    expect(Buffer.from(a.data, "base64").toString()).toBe("hello");
    expect(a).toMatchObject({ eof: false, size: 13 });
    const b = await readHandoff("live", 5, 100, reg);
    expect(Buffer.from(b.data, "base64").toString()).toBe(" handoff");
    expect(b.eof).toBe(true);
  });

  it("refuses expired, unknown and prototype keys", async () => {
    expect(lookupHandoff("old", reg)).toBeNull();
    expect(lookupHandoff("nope", reg)).toBeNull();
    expect(lookupHandoff("__proto__", reg)).toBeNull();
    await expect(readHandoff("old", 0, 5, reg)).rejects.toThrow(/no such handoff/);
  });
});
