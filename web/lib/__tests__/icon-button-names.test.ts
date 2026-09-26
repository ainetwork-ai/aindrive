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

// An icon: <Icon />, or an expression choosing between icons ({open ? <X/> : <Y/>}, {busy && <Spinner/>}).
function isIcon(node: ts.Node): boolean {
  if (ts.isJsxSelfClosingElement(node)) return /^[A-Z]/.test(node.tagName.getText());
  if (ts.isJsxExpression(node)) return !!node.expression && isIcon(node.expression);
  if (ts.isParenthesizedExpression(node)) return isIcon(node.expression);
  if (ts.isConditionalExpression(node)) return isIcon(node.whenTrue) && isIcon(node.whenFalse);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isIcon(node.right);
  return false;
}

function unnamedIconButtons(file: string, text = readFileSync(file, "utf8")): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && CLICKABLE.has(node.openingElement.tagName.getText())) {
      const kids = node.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      const iconOnly = kids.length > 0 && kids.every(isIcon);
      // a name that is present and not the empty string literal
      const named = node.openingElement.attributes.properties.some((a) =>
        ts.isJsxAttribute(a) && NAMED.has(a.name.getText()) &&
        !(a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text.trim() === ""));
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
    expect(ROOTS.flatMap(tsxFiles).flatMap((f) => unnamedIconButtons(f))).toEqual([]);
  });
});

describe("the check itself", () => {
  const hits = (jsx: string) => unnamedIconButtons(join(__dirname, "../../components/x.tsx"), `const A = () => (${jsx});`).length;
  it("flags icon-only controls, including chosen icons and an empty name", () => {
    expect(hits(`<button onClick={() => go()}><X /></button>`)).toBe(1);
    expect(hits(`<button>{open ? <Up /> : <Down />}</button>`)).toBe(1);
    expect(hits(`<a href="/x">{busy && <Spinner />}</a>`)).toBe(1);
    expect(hits(`<button aria-label=""><X /></button>`)).toBe(1);
  });
  it("passes named controls and controls with text", () => {
    expect(hits(`<button aria-label="Close"><X /></button>`)).toBe(0);
    expect(hits(`<button title={t("close")}><X /></button>`)).toBe(0);
    expect(hits(`<button><X /> Close</button>`)).toBe(0);
  });
});
