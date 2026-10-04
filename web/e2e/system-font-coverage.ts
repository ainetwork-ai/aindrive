import { execFileSync } from "node:child_process";

// Fontconfig reports hexadecimal codepoint ranges. Check the selected face's
// coverage rather than guessing from a list of CJK family names (which misses
// e.g. WenQuanYi Zen Hei in Linux browser images).
export function coveredCodepoints(family: string, metadata: string, text: string): number[] {
  const [matchedFamilies, charset = ""] = metadata.trim().split("\n");
  // fc-match silently substitutes another family when the requested one is
  // absent. Such a substitute is not evidence about Chromium's painted font.
  if (!matchedFamilies.split(",").map((name) => name.trim().toLowerCase()).includes(family.toLowerCase())) return [];
  const ranges = charset.split(/\s+/).map((range) => {
    const [first, last = first] = range.split("-");
    return [parseInt(first, 16), parseInt(last, 16)];
  });
  return [...new Set(Array.from(text, (char) => char.codePointAt(0)!))]
    .filter((codepoint) => ranges.some(([first, last]) => codepoint >= first && codepoint <= last));
}

export function systemFontCoverage(family: string, text: string): number[] {
  const metadata = execFileSync("fc-match", ["--format=%{family}\n%{charset}", "--", family], {
    encoding: "utf8",
    timeout: 5000,
  });
  return coveredCodepoints(family, metadata, text);
}
