// Plan 3 review findings for the agent's disk side, each pinned.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { newStore } from "../willow-shared/schemes.js";
import { generateDeviceKey } from "../willow-shared/keys.js";
import { appendUpdate, loadDoc, readUpdates } from "../willow-shared/doc.js";
import { createDisk } from "../willow-materializer.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stops = [];
afterEach(() => { stops.forEach((s) => s()); stops = []; });

async function world(name = "a.txt", text = "hello world", debounceMs = 10_000) {
  const root = mkdtempSync(join(tmpdir(), "willow-review-"));
  const store = newStore("d");
  const agent = await generateDeviceKey(), browser = await generateDeviceKey();
  const disk = createDisk({ root, store, key: agent, debounceMs });
  stops.push(() => disk.stop());
  const d = new Y.Doc(); d.clientID = 7; d.getText("content").insert(0, text);
  await appendUpdate(store, browser, [name], Y.encodeStateAsUpdate(d), 1);
  await disk.materialize([name]); // the file and the base now agree
  return { root, store, agent, browser, disk, d, name };
}
const typeIn = async (w, at, s, seq) => { const sv = Y.encodeStateVector(w.d); w.d.getText("content").insert(at, s); await appendUpdate(w.store, w.browser, [w.name], Y.encodeStateAsUpdate(w.d, sv), seq); };
const docText = async (w) => (await loadDoc(w.store, [w.name])).getText("content").toString();

describe("the agent's disk side (review)", () => {
  it("C1-A: a browser edit the agent already has survives a disk edit made on the old file", async () => {
    const w = await world();
    await typeIn(w, 11, "X", 2); // in the agent's store, not yet on disk (debounce is long)
    writeFileSync(join(w.root, w.name), "hi world"); // the user saves the old file with an edit
    await w.disk.reconcile(w.name);
    expect(await docText(w)).toBe("hi worldX");
    expect(readFileSync(join(w.root, w.name), "utf8")).toBe("hi worldX");
  });

  it("C1-B: a restart before the write does not revert the edit; it gets written", async () => {
    const w = await world();
    await typeIn(w, 11, "!", 2);
    w.disk.stop(); // killed before the debounce fired
    const again = createDisk({ root: w.root, store: w.store, key: w.agent, debounceMs: 10_000 });
    stops.push(() => again.stop());
    await again.reconcileAll(); // startup
    expect(await docText(w)).toBe("hello world!");
    await again.materialize([w.name]);
    expect(readFileSync(join(w.root, w.name), "utf8")).toBe("hello world!");
  });

  it("C2: a write after the file changed on disk merges the disk edit first", async () => {
    const w = await world();
    await typeIn(w, 0, ">", 2);
    writeFileSync(join(w.root, w.name), "hello brave world"); // not yet seen by the watcher
    await w.disk.materialize([w.name]);
    expect(readFileSync(join(w.root, w.name), "utf8")).toBe(">hello brave world");
  });

  it("I3: a write through the RPC (suppressed from the watcher) is still taken", async () => {
    const w = await world();
    const { suppressFsChange } = await import("../rpc.js");
    suppressFsChange(w.name);
    writeFileSync(join(w.root, w.name), "rpc wrote this");
    await w.disk.reconcile(w.name);
    expect(await docText(w)).toBe("rpc wrote this");
  });

  it("I6: two reconciles at once do not insert the disk edit twice", async () => {
    const w = await world();
    writeFileSync(join(w.root, w.name), "hello world, again");
    await Promise.all([w.disk.reconcile(w.name), w.disk.reconcile(w.name)]);
    expect(await docText(w)).toBe("hello world, again");
  });

  it("I7: a file deleted on disk is not recreated by the next remote edit", async () => {
    const w = await world();
    unlinkSync(join(w.root, w.name));
    await w.disk.reconcile(w.name);
    await typeIn(w, 0, "late ", 2);
    await w.disk.materialize([w.name]);
    expect(existsSync(join(w.root, w.name))).toBe(false);
  });

  it("I8: a document under a symlink that leads out of the folder is never written", async () => {
    const outside = mkdtempSync(join(tmpdir(), "willow-outside-"));
    const root = mkdtempSync(join(tmpdir(), "willow-review-"));
    symlinkSync(outside, join(root, "notes"));
    const store = newStore("d");
    const k = await generateDeviceKey();
    const disk = createDisk({ root, store, key: k, debounceMs: 10_000 });
    stops.push(() => disk.stop());
    const d = new Y.Doc(); d.getText("content").insert(0, "pwned");
    await appendUpdate(store, k, ["notes", "x.txt"], Y.encodeStateAsUpdate(d), 1);
    await disk.materialize(["notes", "x.txt"]);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  it("I2: a markdown file the editor cannot model is neither merged nor rewritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "willow-review-"));
    const store = newStore("d");
    const k = await generateDeviceKey();
    const disk = createDisk({ root, store, key: k, debounceMs: 10_000 });
    stops.push(() => disk.stop());
    const { fileToUpdate } = await import("../willow-shared/materialize.js");
    const d = new Y.Doc();
    Y.applyUpdate(d, fileToUpdate(d, "markdown", "# T\n\ntext\n"));
    await appendUpdate(store, k, ["t.md"], Y.encodeStateAsUpdate(d), 1);
    const table = "# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    writeFileSync(join(root, "t.md"), table);
    expect(await disk.reconcile("t.md")).toBe("lossy");
    await disk.materialize(["t.md"]);
    expect(readFileSync(join(root, "t.md"), "utf8")).toBe(table);
    expect((await readUpdates(store, ["t.md"])).length).toBe(1);
  });
});
