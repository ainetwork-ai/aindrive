import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceAgent } from "../agent/device-agent.js";
import { inside, mimeOf, writeHandoffs } from "../mac-agent.js";

const PARIS = fileURLToPath(new URL("../../../mobile/android/app/src/test/resources/paris_eiffel.jpg", import.meta.url));

function setup() {
  const folder = mkdtempSync(join(tmpdir(), "aindrive-dev-"));
  mkdirSync(join(folder, "Trips"));
  copyFileSync(PARIS, join(folder, "Trips", "eiffel.jpg"));
  writeFileSync(join(folder, "Screenshot 2026-09-01.png"), "x");
  writeFileSync(join(folder, "budget report.pdf"), "%PDF");
  const agent = createDeviceAgent({
    indexDir: mkdtempSync(join(tmpdir(), "aindrive-idx-")), inside, mimeOf,
    folders: () => [{ driveId: "d1", folder, label: "Home" }],
  });
  return { folder, agent };
}

test("aindrive-on-device on the Mac: small talk is answered, not searched", async () => {
  const { agent } = setup();
  const r = await agent.ask("How are you?", null);
  assert.equal(r.query, "chat");
  assert.doesNotMatch(r.answer, /No file names/);
  assert.equal(r.sources.length, 0);
});

test("out of scope turns come back as 'out' (the shell hands them to aindrive-cloud)", async () => {
  const { agent } = setup();
  const r = await agent.ask("book a table for 4 tonight", null);
  assert.equal(r.query, "out");
});

test("photos by place (EXIF GPS → city), by kind and by name", async () => {
  const { agent } = setup();
  const paris = await agent.ask("photos taken in Paris", null);
  assert.deepEqual(paris.sources.map((s) => s.path), ["Trips/eiffel.jpg"]);
  assert.match(paris.answer, /Found 1 photo taken in Paris/);
  assert.equal(paris.sources[0].driveId, "d1");
  const tokyo = await agent.ask("photos from Tokyo", null);
  assert.equal(tokyo.sources.length, 0);
  assert.match(tokyo.answer, /Photos here are from Paris \(1\)/);
  assert.deepEqual((await agent.ask("screenshots", null)).sources.map((s) => s.path), ["Screenshot 2026-09-01.png"]);
  assert.deepEqual((await agent.ask("the budget pdf", null)).sources.map((s) => s.path), ["budget report.pdf"]);
});

test("a follow-up keeps the filters, and collect copies the matches into a new folder", async () => {
  const { agent, folder } = setup();
  const first = await agent.ask("photos taken in Paris", null);
  const r = await agent.ask("collect them into a folder", first.context);
  assert.equal(r.action?.type, "collect");
  assert.equal(r.action.copied, 1);
  assert.ok(existsSync(join(folder, r.action.folder, "eiffel.jpg")), r.action.folder);
});

test("handoff registry: new keys added, expired ones dropped, owner-only file", () => {
  const dir = mkdtempSync(join(tmpdir(), "aindrive-ho-"));
  const file = join(dir, "handoffs.json");
  writeFileSync(file, JSON.stringify({ old: { path: "/x", expiresAt: 1 } }));
  writeHandoffs({ k1: { path: "/a", expiresAt: Date.now() + 60_000 } }, file);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["k1"]);
});

test("a bare file name is a search by name, and replies speak of the Mac", async () => {
  const { agent } = setup();
  const r = await agent.ask("budget report", null);
  assert.deepEqual(r.sources.map((s) => s.path), ["budget report.pdf"]);
  const hi = await agent.ask("How are you?", null);
  assert.doesNotMatch(hi.answer, /phone/);
  assert.match(hi.answer, /Mac/);
});
