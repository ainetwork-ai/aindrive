import { describe, it, expect } from "vitest";
import { clientNameOf } from "../pairing-client";

describe("clientNameOf", () => {
  it("keeps a plain app name", () => {
    expect(clientNameOf("ainmem")).toBe("ainmem");
    expect(clientNameOf("  ainmem   (ainmem.ainetwork.ai) ")).toBe("ainmem (ainmem.ainetwork.ai)");
  });
  it("is null for nothing usable", () => {
    for (const v of [undefined, null, 42, {}, "", "   ", "\u0000​"]) expect(clientNameOf(v)).toBeNull();
  });
  it("strips control, zero-width and bidi characters, and caps the length", () => {
    expect(clientNameOf("ain\u0000mem​‮")).toBe("ainmem");
    expect(clientNameOf("a\nb\tc")).toBe("a b c");
    expect(clientNameOf("x".repeat(100))).toHaveLength(40);
  });
});
