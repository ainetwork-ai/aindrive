// lib/run-inputs.ts: ainize.json `inputs` (the GitHub Actions workflow_dispatch shape) → the fields the
// Run panel renders and the INPUT_<NAME> env a run carries.
import { describe, it, expect } from "vitest";
import { inputDefaults, inputEnvName, inputsToEnv, missingRequired, parseManifestInputs, validateRunEnv } from "../run-inputs";

const RAW = {
  DESC: { description: "작품 묘사 (description)", type: "string", required: true, default: "해질녘 바다 위 작은 배 한 척" },
  MODEL: { description: "모델", type: "choice", options: ["clef-flash", "clef"], default: "clef-flash" },
  top_k: { type: "number", default: 5 },
  dry_run: { type: "boolean", default: false },
  FREE: {},
};

describe("parseManifestInputs", () => {
  it("keeps declaration order, defaults type to string, renders defaults as text", () => {
    const list = parseManifestInputs(RAW);
    expect(list.map((i) => i.name)).toEqual(["DESC", "MODEL", "top_k", "dry_run", "FREE"]);
    expect(list[0]).toMatchObject({ type: "string", required: true, default: "해질녘 바다 위 작은 배 한 척" });
    expect(list[2]).toMatchObject({ type: "number", default: "5" });
    expect(list[3]).toMatchObject({ type: "boolean", default: "false" });
    expect(list[4]).toEqual({ name: "FREE", description: null, type: "string", required: false, options: null, default: null });
  });
  it("drops malformed entries and caps the list; the array shape is not accepted", () => {
    expect(parseManifestInputs([{ name: "A" }])).toEqual([]);
    expect(parseManifestInputs("x")).toEqual([]);
    expect(parseManifestInputs({ "1X": {}, "a-b": {}, ok: null, FILE: { type: "file", default: 1 }, CH: { type: "choice" }, Ch: {}, LONG: { default: "x".repeat(2049) } }).map((i) => [i.name, i.type, i.default]))
      .toEqual([["ok", "string", null], ["FILE", "string", "1"], ["Ch", "string", null], ["LONG", "string", null]]);
    expect(parseManifestInputs(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`I${i}`, {}])))).toHaveLength(16);
    // two names that collide once upper-cased: the first wins
    expect(parseManifestInputs({ desc: {}, DESC: {} }).map((i) => i.name)).toEqual(["desc"]);
  });
});

describe("env", () => {
  const inputs = parseManifestInputs(RAW);
  it("INPUT_<NAME> upper-cased; defaults, answers over defaults, required check", () => {
    expect(inputEnvName("top_k")).toBe("INPUT_TOP_K");
    expect(inputDefaults(inputs)).toEqual({ INPUT_DESC: "해질녘 바다 위 작은 배 한 척", INPUT_MODEL: "clef-flash", INPUT_TOP_K: "5", INPUT_DRY_RUN: "false" });
    expect(inputsToEnv(inputs, { DESC: "a boat", FREE: "x" })).toEqual({ INPUT_DESC: "a boat", INPUT_MODEL: "clef-flash", INPUT_TOP_K: "5", INPUT_DRY_RUN: "false", INPUT_FREE: "x" });
    expect(missingRequired(inputs, {})).toEqual([]); // the default satisfies it
    expect(missingRequired(inputs, { DESC: "  " })).toEqual(["DESC"]);
  });
  it("validateRunEnv: env names, ≤ 16, ≤ 2 KiB, scalars as text; anything else refused", () => {
    expect(validateRunEnv(undefined)).toEqual({});
    expect(validateRunEnv({ INPUT_A: "x", INPUT_N: 3, INPUT_B: true })).toEqual({ INPUT_A: "x", INPUT_N: "3", INPUT_B: "true" });
    expect(validateRunEnv({ "bad-name": "x" })).toBeNull();
    expect(validateRunEnv({ A: "x".repeat(2049) })).toBeNull();
    expect(validateRunEnv({ A: { nested: 1 } })).toBeNull();
    expect(validateRunEnv([1])).toBeNull();
    expect(validateRunEnv(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`I${i}`, "v"])))).toBeNull();
  });
});
