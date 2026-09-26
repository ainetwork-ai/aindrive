import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { newStore } from "../willow-shared/schemes.js";
import { generateDeviceKey } from "../willow-shared/keys.js";
import { appendUpdate, loadDoc, readUpdates } from "../willow-shared/doc.js";
import { reconcileFile, startMaterializer } from "../willow-materializer.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stops = [];
afterEach(() => { stops.forEach((s) => s()); stops = []; });

async function seeded(name, text) {
  const root = mkdtempSync(join(tmpdir(), "willow-disk-"));
  const store = newStore("d");
  const browser = await generateDeviceKey(), agent = await generateDeviceKey();
  const d = new Y.Doc(); d.clientID = 11; d.getText("content").insert(0, text);
  await appendUpdate(store, browser, [name], Y.encodeStateAsUpdate(d), 1);
  writeFileSync(join(root, name), text);
  return { root, store, browser, agent, d };
}

describe("disk edits become signed updates", () => {
  it("an edit to the file adds one update, signed by the agent, with the file's text", async () => {
    const { root, store, agent } = await seeded("a.txt", "hello world");
    writeFileSync(join(root, "a.txt"), "hello brave world");
    expect(await reconcileFile(root, store, agent, "a.txt")).toBe("updated");
    expect((await loadDoc(store, ["a.txt"])).getText("content").toString()).toBe("hello brave world");
    expect((await readUpdates(store, ["a.txt"])).length).toBe(2);
    expect(await reconcileFile(root, store, agent, "a.txt")).toBe("none");
  });

  it("a disk edit and a concurrent browser edit both survive", async () => {
    const { root, store, browser, agent, d } = await seeded("b.txt", "hello world");
    const sv = Y.encodeStateVector(d);
    d.getText("content").insert(11, "!"); // typed in a browser, not yet in the agent's store
    writeFileSync(join(root, "b.txt"), "hello brave world");
    await reconcileFile(root, store, agent, "b.txt");
    await appendUpdate(store, browser, ["b.txt"], Y.encodeStateAsUpdate(d, sv), 2);
    expect((await loadDoc(store, ["b.txt"])).getText("content").toString()).toBe("hello brave world!");
  });

  it("a file Willow never saw is left alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "willow-disk-"));
    writeFileSync(join(root, "plain.txt"), "x");
    expect(await reconcileFile(root, newStore("d"), await generateDeviceKey(), "plain.txt")).toBe("none");
  });

  it("markdown written differently but meaning the same is neither updated nor rewritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "willow-disk-"));
    const store = newStore("d");
    const agent = await generateDeviceKey();
    const { fileToUpdate } = await import("../willow-shared/materialize.js");
    const d = new Y.Doc();
    Y.applyUpdate(d, fileToUpdate(d, "markdown", "# T\n\n- a\n- b\n"));
    await appendUpdate(store, agent, ["n.md"], Y.encodeStateAsUpdate(d), 1);
    writeFileSync(join(root, "n.md"), "# T\n\n* a\n* b\n"); // "*" bullets: same list
    const m = startMaterializer({ root, store, debounceMs: 30 });
    stops.push(() => m.stop());
    const before = statSync(join(root, "n.md")).mtimeMs;
    expect(await reconcileFile(root, store, agent, "n.md")).toBe("none");
    await appendUpdate(store, agent, ["n.md"], new Uint8Array([0, 0]), 2); // an empty update: triggers the materializer
    await sleep(150);
    expect(readFileSync(join(root, "n.md"), "utf8")).toBe("# T\n\n* a\n* b\n");
    expect(statSync(join(root, "n.md")).mtimeMs).toBe(before);
  });
});

describe("knownDocs", () => {
  it("lists each document once", async () => {
    const { knownDocs } = await import("../willow-materializer.js");
    const { store, browser } = await seeded("k.txt", "x");
    const d = new Y.Doc(); d.getText("content").insert(0, "y");
    await appendUpdate(store, browser, ["dir", "m.md"], Y.encodeStateAsUpdate(d), 1);
    await appendUpdate(store, browser, ["k.txt"], Y.encodeStateAsUpdate(d), 2);
    expect((await knownDocs(store)).map((p) => p.join("/")).sort()).toEqual(["dir/m.md", "k.txt"]);
  });
});
