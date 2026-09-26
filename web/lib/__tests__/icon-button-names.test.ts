import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// A button or link whose only content is an icon has no text for a screen
// reader to announce, so it must be named (aria-label / aria-labelledby /
// title). IconButton needs no check here: its props type requires aria-label. Parsed
// with the TypeScript compiler, not a regex: attributes like onClick={() => …}
// contain ">" and span lines.
const ROOTS = ["components", "app"].map((d) => join(__dirname, "../..", d));
const NAMED = new Set(["aria-label", "aria-labelledby", "title"]);
const CLICKABLE = new Set(["button", "a", "Link"]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" ? [] : tsxFiles(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

function unnamedIconButtons(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && CLICKABLE.has(node.openingElement.tagName.getText())) {
      const kids = node.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      const iconOnly = kids.length > 0 && kids.every((c) =>
        ts.isJsxSelfClosingElement(c) && /^[A-Z]/.test(c.tagName.getText()));
      const named = node.openingElement.attributes.properties.some((a) =>
        ts.isJsxAttribute(a) && NAMED.has(a.name.getText()));
      if (iconOnly && !named) {
        const { line } = src.getLineAndCharacterOfPosition(node.getStart());
        hits.push(`${relative(join(__dirname, "../.."), file)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

describe("icon-only buttons and links are named for assistive tech", () => {
  it("every icon-only <button>, <a> and <Link> has aria-label, aria-labelledby or title", () => {
    expect(ROOTS.flatMap(tsxFiles).flatMap(unnamedIconButtons)).toEqual([]);
  });
});
