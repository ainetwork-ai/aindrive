/**
 * HMAC sign/verify unit tests for cli/src/sig.js.
 *
 * Cross-package check: imports the canonical web implementation directly from
 * web/lib/sig.js (plain JS, importable without a build step). If the web and
 * cli implementations ever diverge in encoding or key-sort order, the
 * "web-sign / cli-verify" and "cli-sign / web-verify" cases below will fail —
 * that is the CI signal this test exists to catch.
 *
 * This is the only net for cli↔web wire compat since cli has no typecheck.
 * The two sig copies will be consolidated in a later sub-project.
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { signPayload, verifyPayload, stripSig } from "../sig.js";

// Import the web canonical implementation directly (plain JS, no build step).
// Mirrors web/shared/crypto/sig.ts — same sorted-keys JSON + HMAC-SHA256 + base64url.
const _here = dirname(fileURLToPath(import.meta.url));
// __tests__/ → src/ → cli/ → repo-root
const repoRoot = resolve(_here, "../../..");
const { signPayload: webSign, verifyPayload: webVerify } = await import(
  resolve(repoRoot, "web/lib/sig.js")
);

const SECRET = "test-secret-32bytes-xxxxxxxsecret";

describe("cli signPayload", () => {
  it("produces a non-empty base64url string", () => {
    const sig = signPayload(SECRET, { a: 1, b: 2 });
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
    // base64url has no +/= characters
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is deterministic for the same inputs", () => {
    const p = { reqId: "abc", ok: true };
    expect(signPayload(SECRET, p)).toBe(signPayload(SECRET, p));
  });

  it("sorts keys before signing (key-order independence)", () => {
    const p1 = { b: 2, a: 1 };
    const p2 = { a: 1, b: 2 };
    expect(signPayload(SECRET, p1)).toBe(signPayload(SECRET, p2));
  });

  it("produces different sigs for different payloads", () => {
    expect(signPayload(SECRET, { a: 1 })).not.toBe(signPayload(SECRET, { a: 2 }));
  });
});

describe("cli verifyPayload", () => {
  it("verifies a signature produced by signPayload", () => {
    const payload = { reqId: "r1", ok: true, result: { method: "list" } };
    const sig = signPayload(SECRET, payload);
    expect(verifyPayload(SECRET, payload, sig)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const payload = { reqId: "r2", ok: false };
    const sig = signPayload(SECRET, payload);
    const tampered = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyPayload(SECRET, payload, tampered)).toBe(false);
  });

  it("rejects a sig for a different payload", () => {
    const sig = signPayload(SECRET, { a: 1 });
    expect(verifyPayload(SECRET, { a: 2 }, sig)).toBe(false);
  });

  it("rejects a sig computed with a different secret", () => {
    const sig = signPayload("other-secret", { a: 1 });
    expect(verifyPayload(SECRET, { a: 1 }, sig)).toBe(false);
  });

  it("returns false for length mismatch (not timing-unsafe)", () => {
    expect(verifyPayload(SECRET, { x: 1 }, "short")).toBe(false);
  });
});

describe("cross-package: web-sign / cli-verify and cli-sign / web-verify", () => {
  const payload = { reqId: "cross-1", ok: true, result: { method: "write", bytes: 42 } };

  it("cli verifies a sig produced by the web algorithm", () => {
    const sig = webSign(SECRET, payload);
    expect(verifyPayload(SECRET, payload, sig)).toBe(true);
  });

  it("web verifies a sig produced by cli signPayload", () => {
    const sig = signPayload(SECRET, payload);
    expect(webVerify(SECRET, payload, sig)).toBe(true);
  });

  it("both algorithms produce the same bytes for the same input", () => {
    expect(signPayload(SECRET, payload)).toBe(webSign(SECRET, payload));
  });
});

describe("stripSig", () => {
  it("removes the sig field and returns the rest", () => {
    const obj = { type: "response", reqId: "r3", ok: true, sig: "abc" };
    expect(stripSig(obj)).toEqual({ type: "response", reqId: "r3", ok: true });
  });

  it("does not mutate the original object", () => {
    const obj = { a: 1, sig: "x" };
    stripSig(obj);
    expect(obj).toHaveProperty("sig");
  });
});
