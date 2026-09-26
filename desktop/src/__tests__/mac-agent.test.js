import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacAgent, inside, listEntries, mimeOf, searchFolders, writeDriveConfig } from "../mac-agent.js";
import { createStore } from "../store.js";

const tree = () => {
  const d = mkdtempSync(join(tmpdir(), "aindrive-mac-"));
  mkdirSync(join(d, "Trips", "Jeju"), { recursive: true });
  mkdirSync(join(d, ".aindrive"));
  writeFileSync(join(d, "Trips", "Jeju", "tangerine orchard.jpg"), "x");
  writeFileSync(join(d, "Trips", "plan.md"), "# plan");
  writeFileSync(join(d, "notes.txt"), "n");
  writeFileSync(join(d, ".aindrive", "config.json"), "{}");
  return d;
};

test("inside() keeps every path in the folder and out of .aindrive/", () => {
  const d = tree();
  assert.equal(inside(d, "Trips/plan.md"), join(d, "Trips", "plan.md"));
  assert.equal(inside(d, "/Trips"), join(d, "Trips"));
  assert.equal(inside(d, ""), d);
  for (const bad of ["../x", "Trips/../../x", "/../../etc/passwd"]) assert.throws(() => inside(d, bad), /outside/);
  for (const bad of [".aindrive/config.json", ".AINDRIVE", "./.aindrive"]) assert.throws(() => inside(d, bad), /reserved/);
});

test("listEntries has the phone agent's shape: folders first, no .aindrive", async () => {
  const d = tree();
  const root = await listEntries(d);
  assert.deepEqual(root.map((e) => e.name), ["Trips", "notes.txt"]);
  assert.deepEqual(Object.keys(root[1]).sort(), ["isDir", "mime", "mtimeMs", "name", "path", "size"]);
  assert.equal(root[1].mime, "text/plain");
  const sub = await listEntries(d, "Trips");
  assert.deepEqual(sub.map((e) => e.path), ["Trips/Jeju", "Trips/plan.md"]);
});

test("searchFolders finds files by every word of the question", async () => {
  const d = tree();
  const f = [{ path: d, label: "Family", driveId: "D1" }];
  const r = await searchFolders(f, "find the tangerine orchard photos");
  assert.deepEqual(r.words, ["tangerine", "orchard"]);
  assert.deepEqual(r.sources.map((s) => s.path), ["Trips/Jeju/tangerine orchard.jpg"]);
  assert.equal(r.sources[0].driveId, "D1");
  assert.equal((await searchFolders(f, "jeju")).sources.length, 1); // folder names count
  assert.equal((await searchFolders(f, "config")).sources.length, 0); // .aindrive is never searched
  assert.deepEqual((await searchFolders(f, "the")).sources, []);
});

test("writeDriveConfig writes what the CLI serves from, and keeps pairedAt", () => {
  const d = mkdtempSync(join(tmpdir(), "aindrive-mac-"));
  const cfg = { driveId: "D1", agentToken: "t", driveSecret: "s", serverUrl: "https://x.test/" };
  writeDriveConfig(d, cfg);
  const a = JSON.parse(readFileSync(join(d, ".aindrive", "config.json"), "utf8"));
  assert.equal(a.url, "https://x.test/d/D1");
  writeDriveConfig(d, { ...cfg, agentToken: "t2" });
  const b = JSON.parse(readFileSync(join(d, ".aindrive", "config.json"), "utf8"));
  assert.equal(b.agentToken, "t2");
  assert.equal(b.pairedAt, a.pairedAt);
});

test("mimeOf", () => {
  assert.equal(mimeOf("A.JPG"), "image/jpeg");
  assert.equal(mimeOf("x.unknown"), "application/octet-stream");
});

test("inside(): symlinks out of the folder are refused; odd-but-legal names are fine", () => {
  const d = tree();
  const outside = mkdtempSync(join(tmpdir(), "aindrive-out-"));
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(outside, join(d, "escape"));
  assert.throws(() => inside(d, "escape/secret.txt"), /outside/);
  assert.throws(() => inside(d, "escape/new-file"), /outside/);
  assert.throws(() => inside(d, "Trips/B/.aindrive/config.json"), /reserved/); // any depth
  assert.equal(inside(d, "..notes"), join(d, "..notes"));
  assert.equal(inside(d, "v1../x"), join(d, "v1..", "x"));
});

function fakeElectron(picks) {
  return {
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: picks.shift() ?? [] }) },
    nativeImage: {}, shell: {}, getWindow: () => null,
  };
}
const fakeAgents = () => Object.assign(new EventEmitter(), { list: () => [], start() {}, stop() {}, remove() {} });

test("rename never replaces another file; added files get a free name", async () => {
  const d = tree();
  const src = mkdtempSync(join(tmpdir(), "aindrive-src-"));
  writeFileSync(join(src, "plan.md"), "new");
  const store = createStore(join(mkdtempSync(join(tmpdir(), "aindrive-store-")), "s.json"));
  const mac = createMacAgent({ agents: fakeAgents(), store, electron: fakeElectron([[d], [join(src, "plan.md")]]), thumbsDir: tmpdir(), emit() {} });
  await mac.pickFolder();
  await assert.rejects(mac.rename({ folderUri: d, from: "notes.txt", to: "Trips/plan.md" }), /already exists/);
  const r = await mac.addFiles({ folderUri: d, path: "Trips" });
  assert.deepEqual(r.added, ["plan (2).md"]);
  assert.equal(readFileSync(join(d, "Trips", "plan.md"), "utf8"), "# plan");
});

test("a v0.1 store migrates once, survives a reopen, and hands its folders to the shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aindrive-store-"));
  const file = join(dir, "folders.json");
  const folder = tree();
  writeFileSync(join(folder, ".aindrive", "config.json"), JSON.stringify({ driveId: "D7", agentToken: "t", driveSecret: "s", serverUrl: "https://x.test", url: "https://x.test/d/D7" }));
  writeFileSync(file, JSON.stringify({ folders: [{ path: folder, paused: false }], loginItemAsked: true }));
  const mac = createMacAgent({ agents: fakeAgents(), store: createStore(file), electron: fakeElectron([]), thumbsDir: tmpdir(), emit() {} });
  mac.migrate();
  const again = createStore(file).get(); // the next launch
  assert.deepEqual(again.picked, [folder]);
  assert.deepEqual(again.adopt, [{ path: folder, paused: false }]);
  const a = await mac.adoptable();
  assert.equal(a.folders[0].drive.driveId, "D7");
  assert.equal(a.folders[0].serverUrl, "https://x.test");
  assert.deepEqual((await mac.adoptable()).folders, []); // once
});

test("stopping a drive takes its credentials out of the folder", async () => {
  const d = tree();
  const store = createStore(join(mkdtempSync(join(tmpdir(), "aindrive-store-")), "s.json"));
  const mac = createMacAgent({ agents: fakeAgents(), store, electron: fakeElectron([[d]]), thumbsDir: tmpdir(), emit() {} });
  await mac.pickFolder();
  await mac.start({ folderUri: d, driveId: "D9", agentToken: "t", driveSecret: "s", serverUrl: "https://x.test" });
  assert.ok(existsSync(join(d, ".aindrive", "config.json")));
  await mac.stop({ driveId: "D9" });
  assert.ok(!existsSync(join(d, ".aindrive", "config.json")));
});

test("a dangling symlink is refused, not followed", () => {
  const d = tree();
  const outside = mkdtempSync(join(tmpdir(), "aindrive-out-"));
  symlinkSync(join(outside, "planted.txt"), join(d, "dangling"));
  assert.throws(() => inside(d, "dangling"), /outside/);
  assert.ok(!existsSync(join(outside, "planted.txt")));
});

test("a missing folder reads as deleted only when it was not a disk's root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aindrive-par-"));
  const folder = join(parent, "Shared");
  mkdirSync(folder);
  const store = createStore(join(mkdtempSync(join(tmpdir(), "aindrive-store-")), "s.json"));
  const mac = createMacAgent({ agents: fakeAgents(), store, electron: fakeElectron([[folder]]), thumbsDir: tmpdir(), emit() {} });
  await mac.pickFolder();
  rmSync(folder, { recursive: true });
  await assert.rejects(mac.listFolder({ folderUri: folder }), /No such file/);
  // a folder picked without a device record (a disk root, or unknown) is never "deleted"
  store.update((s) => ({ ...s, pickedDev: {} }));
  await assert.rejects(mac.listFolder({ folderUri: folder }), /disk connected/);
});

test("a folder paused in v0.1 is carried over switched off", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "aindrive-store-")), "folders.json");
  const on = tree(), off = tree();
  for (const [f, id] of [[on, "A"], [off, "B"]]) writeFileSync(join(f, ".aindrive", "config.json"), JSON.stringify({ driveId: id, agentToken: "t", driveSecret: "s", serverUrl: "https://x.test" }));
  writeFileSync(file, JSON.stringify({ folders: [{ path: on, paused: false }, { path: off, paused: true }] }));
  const mac = createMacAgent({ agents: fakeAgents(), store: createStore(file), electron: fakeElectron([]), thumbsDir: tmpdir(), emit() {} });
  mac.migrate();
  const a = await mac.adoptable();
  assert.deepEqual(a.folders.map((x) => [x.drive.driveId, x.on]), [["A", true], ["B", false]]);
});
