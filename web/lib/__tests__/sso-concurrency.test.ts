// Concurrent first logins (and concurrent adapter pushes) for the same AIN
// account must create exactly one aindrive account. Real concurrency: several
// OS processes, each with its own SQLite connection to the same file, start
// at the same instant (the production server is one process, but the
// guarantee comes from the database — an immediate transaction plus the
// (issuer, subject) primary key — not from Node's single thread).
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), "aindrive-sso-race-"));
process.env.AINDRIVE_DATA_DIR = dataDir;

// Create the schema once, here, before the racers open the same file.
const { db } = await import("../db.js");

const storeUrl = pathToFileURL(resolve(__dirname, "../sso/store.js")).href;
const racer = join(dataDir, "racer.mjs");
writeFileSync(racer, `
const [storeUrl, startAt, mode, arg] = process.argv.slice(2);
const store = await import(storeUrl);
while (Date.now() < Number(startAt)) {} // line up on the same instant
let out;
if (mode === "login") {
  out = store.resolveOrCreateUserForSubject({ issuer: "https://sso.example.test", subject: "acc_race", name: "Racer", email: "race@corp.example", emailVerified: true });
} else {
  const version = Number(arg);
  out = store.applyDesiredState("https://sso.example.test", {
    schema: "ain-sso.adapter.v1", sub: "acc_push", org: { id: "org_r", slug: "r", name: "R" }, version,
    status: "active", profile: { name: "P" + version, email: null, workEmail: null }, appRole: "member", groups: [],
    legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(),
  }).result;
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
`);

async function race(mode: "login" | "push", n: number) {
  const startAt = Date.now() + 2500;
  const outs = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      run(process.execPath, [racer, storeUrl, String(startAt), mode, String(i + 1)], { env: { ...process.env, AINDRIVE_DATA_DIR: dataDir }, cwd: resolve(__dirname, "../..") }),
    ),
  );
  return outs.map((o) => JSON.parse(o.stdout));
}

describe("concurrent first sign-in", () => {
  it("six processes resolving the same new AIN account create ONE aindrive account", async () => {
    const results = (await race("login", 6)) as { userId: string; created: boolean }[];
    const ids = new Set(results.map((r) => r.userId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(db.prepare("SELECT count(*) c FROM sso_identities WHERE subject = 'acc_race'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) c FROM users WHERE email = 'race@corp.example'").get()).toEqual({ c: 1 });
  }, 60_000);

  it("concurrent adapter pushes with different versions: one account, the highest version wins", async () => {
    const results = (await race("push", 5)) as { appliedVersion: number; localUserId: string }[];
    expect(new Set(results.map((r) => r.localUserId)).size).toBe(1);
    const row = db.prepare("SELECT applied_version, user_id FROM sso_memberships WHERE subject = 'acc_push'").get() as { applied_version: number; user_id: string };
    expect(row.applied_version).toBe(5);
    expect(db.prepare("SELECT name FROM users WHERE id = ?").get(row.user_id)).toEqual({ name: "P5" });
    // Every answer is at least the version it was sent (never a regression).
    results.forEach((r, i) => expect(r.appliedVersion).toBeGreaterThanOrEqual(i + 1));
    expect(db.prepare("SELECT count(*) c FROM sso_identities WHERE subject = 'acc_push'").get()).toEqual({ c: 1 });
  }, 60_000);
});
