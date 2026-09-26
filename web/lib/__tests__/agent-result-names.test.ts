import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-agent-names-"));

const { canonicalAgentResult } = await import("../agents.js");

// An agent reports names as its filesystem spells them — NFD for files made by
// macOS tools. Everything the server compares them with (shares, grants, payout
// paths, doc keys) is NFC, so names enter the server in that one spelling.
const NFC = "제주 앨범".normalize("NFC");
const NFD = NFC.normalize("NFD");
const entry = (name: string, path: string) => ({ name, path, isDir: true, size: 0, mtimeMs: 0, ext: "", mime: "" });

describe("canonicalAgentResult", () => {
  it("list: NFD names and paths come out NFC", () => {
    const out = canonicalAgentResult({ method: "list", entries: [entry(NFD, `가족/${NFD}`.normalize("NFD"))] });
    expect(out.entries[0].name).toBe(NFC);
    expect(out.entries[0].path).toBe(`가족/${NFC}`);
  });

  it("stat: the entry comes out NFC; a missing entry stays null", () => {
    expect(canonicalAgentResult({ method: "stat", entry: entry(NFD, NFD) }).entry).toMatchObject({ name: NFC, path: NFC });
    expect(canonicalAgentResult({ method: "stat", entry: null })).toEqual({ method: "stat", entry: null });
  });

  it("results that carry no names pass through untouched", () => {
    const read = { method: "read", content: NFD, encoding: "utf8" };
    expect(canonicalAgentResult(read)).toBe(read); // file CONTENT is not a name
  });
});

describe("agents.js — every agent response passes through canonicalAgentResult", () => {
  const src = readFileSync(join(__dirname, "../agents.js"), "utf8");
  it("resolves pending RPCs only with the canonicalized result", () => {
    expect(src.match(/pending\.resolve\(/g)).toHaveLength(1);
    expect(src).toMatch(/pending\.resolve\(canonicalAgentResult\(msg\.result\)\)/);
  });
});
