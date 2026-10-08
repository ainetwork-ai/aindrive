import { describe, expect, it } from "vitest";
import { coveredCodepoints } from "../../e2e/system-font-coverage";

describe("painted system font coverage", () => {
  it("accepts Hangul coverage independently of the font family name", () => {
    expect(coveredCodepoints("WenQuanYi Zen Hei", "WenQuanYi Zen Hei,文泉驛正黑\n20-7e ac00-d7a3", "한글한"))
      .toEqual([0xd55c, 0xae00]);
  });

  it("rejects Latin-only faces even when their name resembles a CJK font", () => {
    expect(coveredCodepoints("Noto Sans KR", "Noto Sans KR\n20-7e", "한글")).toEqual([]);
  });

  it("rejects a silent fontconfig substitution for the painted family", () => {
    expect(coveredCodepoints("Missing Font", "Noto Sans CJK KR\n20-7e ac00-d7a3", "한글")).toEqual([]);
  });

  it("does not count spaces or unsupported Hangul in a partial font", () => {
    expect(coveredCodepoints("Partial", "Partial\n20 ae00", "한글")).toEqual([0xae00]);
    expect(coveredCodepoints("Tofu", "Tofu\n", "한글")).toEqual([]);
  });
});
