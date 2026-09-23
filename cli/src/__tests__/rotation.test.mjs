import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyRotation, revertRotation, commitRotation } from "../rotation.js";
import { writeDriveConfig } from "../config.js";

const OLD = { agentToken: "old-token-".padEnd(48, "x"), driveSecret: "old-secret-".padEnd(48, "y") };
const NEW = { agentToken: "new-token-".padEnd(48, "a"), driveSecret: "new-secret-".padEnd(48, "b") };

let root;
let drive;
const onDisk = () => JSON.parse(readFileSync(path.join(root, ".aindrive", "config.json"), "utf8"));

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "rotation-"));
  drive = { driveId: "d1", serverUrl: "https://x", ...OLD };
  await writeDriveConfig(root, drive);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("live rotation (agent side)", () => {
  it("persists new + previous pair before adopting, keeping the old secret for the grace window", async () => {
    const r = await applyRotation({ root, drive, params: NEW });
    expect(onDisk()).toMatchObject({ ...NEW, previousCredentials: OLD, driveId: "d1" });
    expect(drive.agentToken).toBe(OLD.agentToken); // not adopted until the ok is sent
    expect(r.previousSecret).toBe(OLD.driveSecret);
    r.adopt();
    expect(drive).toMatchObject({ ...NEW, previousCredentials: OLD });
  });

  it("rejects malformed credentials without touching the config", async () => {
    await expect(applyRotation({ root, drive, params: { agentToken: "short", driveSecret: NEW.driveSecret } })).rejects.toThrow(/invalid/);
    await expect(applyRotation({ root, drive, params: {} })).rejects.toThrow(/invalid/);
    expect(onDisk()).toMatchObject(OLD);
    expect(onDisk().previousCredentials).toBeUndefined();
  });

  it("reverts to the previous pair when the server refuses the new token", async () => {
    (await applyRotation({ root, drive, params: NEW })).adopt();
    expect(await revertRotation({ root, drive })).toBe(true);
    expect(drive).toMatchObject(OLD);
    expect(drive.previousCredentials).toBeUndefined();
    expect(onDisk()).toMatchObject(OLD);
    expect(await revertRotation({ root, drive })).toBe(false); // nothing left to revert
  });

  it("commit drops the fallback once the server accepts the new token", async () => {
    (await applyRotation({ root, drive, params: NEW })).adopt();
    expect(await commitRotation({ root, drive })).toBe(true);
    expect(onDisk()).toMatchObject(NEW);
    expect(onDisk().previousCredentials).toBeUndefined();
    expect(await commitRotation({ root, drive })).toBe(false);
  });

  it("writes config atomically (no temp files left behind)", async () => {
    await applyRotation({ root, drive, params: NEW });
    expect(readdirSync(path.join(root, ".aindrive"))).toEqual(["config.json"]);
  });
});
