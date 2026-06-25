// Characterization tests for config.js — agent-first migration safety net.
//
// These SNAPSHOT the *current* behaviour of the secret/token store (not an
// assumed spec) so a later structural refactor can be proven behaviour-
// preserving. config.js is security-critical (it is the on-disk home of drive
// secrets + global credentials/wallet tokens) and previously had ZERO tests.
//
// The high-value asserts are the file/dir permission invariants: a regression
// that drops the 0600 chmod (world-readable creds) or the 0700 mkdir mode MUST
// fail CI. Those tests are flagged "PERMISSION INVARIANT (secret protection)".
//
// All modes below were observed by probing the real module, not assumed:
//   created file -> 0600, created dir -> 0700, pretty-printed JSON (2-space),
//   read of missing file or corrupt JSON -> null (swallowed).
//
// Seam note: readGlobalCreds/writeGlobalCreds resolve their path from
// homedir() at MODULE LOAD TIME (const GLOBAL_DIR = join(homedir(), ...)).
// They are reachable by setting process.env.HOME to a tmp dir BEFORE a fresh
// dynamic import() — done in the "global creds" block via an isolated module
// instance. readDriveConfig/writeDriveConfig take an explicit `dir` param and
// are imported normally at the top.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDriveConfig, writeDriveConfig } from "../config.js";

const mode = (p) => statSync(p).mode & 0o777;

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "config-char-"));
});

describe("writeDriveConfig / readDriveConfig", () => {
  it("round-trips a config object through .aindrive/config.json", async () => {
    await writeDriveConfig(root, { driveId: "d1", secret: "s" });
    expect(await readDriveConfig(root)).toEqual({ driveId: "d1", secret: "s" });
  });

  it("preserves nested objects, arrays, booleans and null", async () => {
    const cfg = { driveId: "x", nested: { arr: [1, 2, 3], flag: true }, n: null };
    await writeDriveConfig(root, cfg);
    expect(await readDriveConfig(root)).toEqual(cfg);
  });

  it("writes pretty-printed (2-space) JSON to disk", async () => {
    await writeDriveConfig(root, { a: 1 });
    const raw = readFileSync(join(root, ".aindrive", "config.json"), "utf8");
    expect(raw).toBe('{\n  "a": 1\n}');
  });

  it("resolves a relative dir against cwd (writeDriveConfig uses resolve(dir))", async () => {
    const prev = process.cwd();
    process.chdir(root);
    try {
      await writeDriveConfig(".", { a: 1 });
    } finally {
      process.chdir(prev);
    }
    // Written via "." but readable via the absolute root → same resolved path.
    expect(await readDriveConfig(root)).toEqual({ a: 1 });
  });

  it("overwrites an existing config (no merge) and keeps file at 0600", async () => {
    await writeDriveConfig(root, { driveId: "d1", secret: "s" });
    await writeDriveConfig(root, { driveId: "d2" });
    expect(await readDriveConfig(root)).toEqual({ driveId: "d2" });
    expect(mode(join(root, ".aindrive", "config.json"))).toBe(0o600);
  });
});

describe("writeDriveConfig — PERMISSION INVARIANT (secret protection)", () => {
  it("creates .aindrive/config.json with file mode 0600", async () => {
    await writeDriveConfig(root, { secret: "top" });
    expect(mode(join(root, ".aindrive", "config.json"))).toBe(0o600);
  });

  it("creates the .aindrive dir with mode 0700", async () => {
    await writeDriveConfig(root, { secret: "top" });
    expect(mode(join(root, ".aindrive"))).toBe(0o700);
  });

  it("CURRENT BEHAVIOUR: a pre-existing .aindrive dir is NOT re-chmodded (only the file is)", async () => {
    // Snapshot a known gotcha: the mkdir(mode 0700) only runs when the dir is
    // absent. If .aindrive already exists world-readable, writeDriveConfig
    // leaves the DIR mode alone; only the config FILE is forced to 0600.
    mkdirSync(join(root, ".aindrive"), { mode: 0o755 });
    await writeDriveConfig(root, { secret: "top" });
    expect(mode(join(root, ".aindrive"))).toBe(0o755); // dir untouched
    expect(mode(join(root, ".aindrive", "config.json"))).toBe(0o600); // file still locked
  });
});

describe("readDriveConfig — missing / corrupt → null (swallowed)", () => {
  it("returns null when the .aindrive/config.json does not exist", async () => {
    expect(await readDriveConfig(root)).toBeNull();
  });

  it("returns null (swallows the parse error) for a corrupt JSON file", async () => {
    mkdirSync(join(root, ".aindrive"), { recursive: true });
    writeFileSync(join(root, ".aindrive", "config.json"), "{not valid json");
    expect(await readDriveConfig(root)).toBeNull();
  });
});

// readGlobalCreds/writeGlobalCreds bind their path from homedir() at module
// load (const GLOBAL_DIR = join(homedir(), ...)). To reach them we point $HOME
// at a fresh tmp dir, then vi.resetModules() + re-import config.js so its
// top-level code re-evaluates homedir() against the tmp HOME. Each test thus
// gets an isolated module instance whose GLOBAL_DIR lives under that tmp HOME.
describe("readGlobalCreds / writeGlobalCreds (homedir seam via fresh import)", () => {
  let fakeHome;
  let cfg;
  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), "config-home-char-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // win fallback
    vi.resetModules();
    cfg = await import("../config.js");
  });

  it("returns null before anything is written", async () => {
    expect(await cfg.readGlobalCreds()).toBeNull();
  });

  it("round-trips global credentials through ~/.aindrive/credentials.json", async () => {
    await cfg.writeGlobalCreds({ token: "abc", wallet: "0x1" });
    expect(await cfg.readGlobalCreds()).toEqual({ token: "abc", wallet: "0x1" });
  });

  it("writes credentials.json with file mode 0600 — PERMISSION INVARIANT (secret protection)", async () => {
    await cfg.writeGlobalCreds({ token: "abc" });
    expect(mode(join(fakeHome, ".aindrive", "credentials.json"))).toBe(0o600);
  });

  it("creates ~/.aindrive with mode 0700 — PERMISSION INVARIANT (secret protection)", async () => {
    await cfg.writeGlobalCreds({ token: "abc" });
    expect(mode(join(fakeHome, ".aindrive"))).toBe(0o700);
  });

  it("returns null (swallows the parse error) for a corrupt credentials file", async () => {
    mkdirSync(join(fakeHome, ".aindrive"), { recursive: true });
    writeFileSync(join(fakeHome, ".aindrive", "credentials.json"), "}{ broken");
    expect(await cfg.readGlobalCreds()).toBeNull();
  });
});
