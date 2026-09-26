import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { newStore } from "../willow-shared/schemes.js";
import { generateDeviceKey } from "../willow-shared/keys.js";
import { appendUpdate } from "../willow-shared/doc.js";
import { startMaterializer } from "../willow-materializer.js";

const until = async (ok, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error("timeout"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stops = [];
afterEach(() => { stops.forEach((s) => s()); stops = []; });

async function world() {
  const root = mkdtempSync(join(tmpdir(), "willow-mat-"));
  const store = newStore("d");
  const key = await generateDeviceKey();
  const m = startMaterializer({ root, store, debounceMs: 50 });
  stops.push(() => m.stop());
  return { root, store, key, m };
}

describe("materializer", () => {
  it("writes the merged document into the file", async () => {
    const { root, store, key } = await world();
    writeFileSync(join(root, "a.txt"), "old");
    const d = new Y.Doc(); d.getText("content").insert(0, "new text");
    await appendUpdate(store, key, ["a.txt"], Y.encodeStateAsUpdate(d), 1);
    await until(() => readFileSync(join(root, "a.txt"), "utf8") === "new text");
  });

  it("does not rewrite a file whose content is already the same", async () => {
    const { root, store, key } = await world();
    writeFileSync(join(root, "same.txt"), "same");
    const before = statSync(join(root, "same.txt")).mtimeMs;
    await sleep(20);
    const d = new Y.Doc(); d.getText("content").insert(0, "same");
    await appendUpdate(store, key, ["same.txt"], Y.encodeStateAsUpdate(d), 1);
    await sleep(200);
    expect(statSync(join(root, "same.txt")).mtimeMs).toBe(before);
  });

  it("never writes a non-canonical path, one that climbs out, or into .aindrive", async () => {
    const { root, store, key } = await world();
    mkdirSync(join(root, ".aindrive"), { recursive: true });
    const d = new Y.Doc(); d.getText("content").insert(0, "x");
    for (const p of [["..", "evil.txt"], [".", "a.txt"], [".aindrive", "config.json"], ["a", "", "b.txt"]]) {
      await appendUpdate(store, key, p, Y.encodeStateAsUpdate(d), 1);
    }
    await sleep(200);
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
    expect(existsSync(join(root, ".aindrive", "config.json"))).toBe(false);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  it("does not write while an update waits for one it depends on", async () => {
    const { root, store, key } = await world();
    writeFileSync(join(root, "p.txt"), "complete original");
    const d = new Y.Doc(); d.getText("content").insert(0, "one ");
    const first = Y.encodeStateAsUpdate(d);
    const sv = Y.encodeStateVector(d);
    d.getText("content").insert(4, "two");
    const second = Y.encodeStateAsUpdate(d, sv); // depends on `first`
    await appendUpdate(store, key, ["p.txt"], second, 2);
    await sleep(200);
    expect(readFileSync(join(root, "p.txt"), "utf8")).toBe("complete original");
    await appendUpdate(store, key, ["p.txt"], first, 1);
    await until(() => readFileSync(join(root, "p.txt"), "utf8") === "one two");
  });
});
