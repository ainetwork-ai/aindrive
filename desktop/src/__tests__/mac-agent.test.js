import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inside, listEntries, mimeOf, searchFolders, writeDriveConfig } from "../mac-agent.js";

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
