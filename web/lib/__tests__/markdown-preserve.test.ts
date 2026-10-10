import { describe, it, expect } from "vitest";
import { mergePreservingSource, splitBlocks, textOf } from "../markdown-preserve";

// A stand-in for TipTap's normalizing + lossy serializer: autolinks become
// [url](url), tables (no extension) vanish, paragraphs are otherwise kept.
function fakeBlock(block: string): string {
  if (/^\s*\|.*\|\s*$/m.test(block)) return "";
  return block.replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)").trim();
}
// canon(md) is the editor's parse→serialize of ANY markdown, one block or a whole document.
function fakeCanon(md: string): string {
  return splitBlocks(md).map(fakeBlock).filter((b) => b !== "").join("\n\n");
}
function fakeSerialize(md: string): string { return fakeCanon(md) + "\n"; }

const README = [
  "# Clef artwork search",
  "",
  "See <https://example.com/docs> for details.",
  "",
  "| col | val |",
  "| --- | --- |",
  "| a   | 1   |",
  "",
  "```py",
  "x = 1",
  "",
  "y = 2",
  "```",
  "",
  "Last paragraph.",
  "",
].join("\n");

// A serializer that MANGLES a table into a paragraph instead of dropping it,
// and spells a standalone heading differently from an in-document one.
function manglingCanon(block: string): string {
  return block
    .split("\n")
    .filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))             // the |---|---| rule vanishes
    .map((l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\s*\|\s*/g, " "))
    .join("\n")
    .replace(/<(https?:\/\/[^>]+)>/g, "[$1]($1)")
    .trim();
}
function manglingSerialize(md: string): string {
  return splitBlocks(md).map(manglingCanon).join("\n\n") + "\n";
}

describe("markdown-preserve", () => {
  it("textOf folds punctuation and layout away", () => {
    expect(textOf("| col | val |\n| --- | --- |\n| a | 1 |")).toBe("col val a 1");
    expect(textOf("**Bold**, _it_.")).toBe("bold it");
  });

  it("a table the serializer flattens into a paragraph keeps its original lines", () => {
    const serialized = manglingSerialize(README);
    expect(textOf(serialized)).toContain("col val a 1");
    expect(serialized).not.toContain("| col |");
    expect(mergePreservingSource(README, serialized, manglingCanon)).toBe(README);
    // ...and an edit elsewhere still does not flatten it
    const edited = serialized.replace("Last paragraph.", "Last paragraph, edited.");
    const out = mergePreservingSource(README, edited, manglingCanon);
    expect(out).toContain("| col | val |\n| --- | --- |\n| a   | 1   |");
    expect(out).toContain("Last paragraph, edited.");
  });

  it("splits on blank lines but keeps a fenced block with blank lines whole", () => {
    const b = splitBlocks(README);
    expect(b).toHaveLength(5);
    expect(b[3]).toBe("```py\nx = 1\n\ny = 2\n```");
  });

  it("open → no edit → serialized output drops the table and rewrites links; the merge restores the source byte-for-byte", () => {
    const serialized = fakeSerialize(README);
    expect(serialized).not.toContain("| col |");
    expect(serialized).toContain("[https://example.com/docs](https://example.com/docs)");
    expect(mergePreservingSource(README, serialized, fakeCanon)).toBe(README);
  });

  it("edit → the edited block takes the editor's text, untouched blocks and the table are preserved", () => {
    const serialized = fakeSerialize(README).replace("Last paragraph.", "Last paragraph, edited.");
    const out = mergePreservingSource(README, serialized, fakeCanon);
    expect(out).toContain("See <https://example.com/docs> for details.");
    expect(out).toContain("| col | val |\n| --- | --- |\n| a   | 1   |");
    expect(out).toContain("Last paragraph, edited.");
    expect(out).not.toContain("Last paragraph.\n");
    expect(out.indexOf("| col |")).toBeLessThan(out.indexOf("```py"));
    expect(out.endsWith("\n")).toBe(true);
  });

  it("a new block inserted by the user lands where the editor put it", () => {
    const serialized = fakeSerialize(README).replace("# Clef artwork search\n\n", "# Clef artwork search\n\nIntro added.\n\n");
    const out = mergePreservingSource(README, serialized, fakeCanon);
    expect(out.indexOf("Intro added.")).toBeGreaterThan(out.indexOf("# Clef"));
    expect(out.indexOf("Intro added.")).toBeLessThan(out.indexOf("<https://example.com/docs>"));
    expect(out).toContain("| col | val |");
  });

  it("a deleted block disappears; an unrepresentable block never does", () => {
    const serialized = fakeSerialize(README).replace("Last paragraph.\n", "");
    const out = mergePreservingSource(README, serialized, fakeCanon);
    expect(out).not.toContain("Last paragraph.");
    expect(out).toContain("| a   | 1   |");
  });
});
