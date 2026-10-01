import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Share panel: every successful change it makes (invite, role change, remove,
// new link, sale) must show up in the panel at once — either by reloading
// (load()) or by updating the list it changed. Before this check, invite() only
// toasted "Collaborator added" while the People list still said "No one else
// can access … yet", so an operator could not see that the invite worked
// (gallery pilot rehearsal 19.2, 2026-10-01).
const FILE = join(__dirname, "../..", "components/share-dialog.tsx");
const LIST_SETTERS = /\b(load|setMembers|setShares|setPayoutRows)\(/;

function mutatingFunctions(text: string): { name: string; body: string }[] {
  const src = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { name: string; body: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const body = node.body.getText();
      if (/^[a-z]/.test(node.name.text) && /apiFetch(<[^>]*>)?\(/.test(body) && /method:\s*"(POST|PATCH|PUT|DELETE)"/.test(body) && /toast\.success\(/.test(body)) out.push({ name: node.name.text, body });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe("share dialog reflects its own changes", () => {
  const fns = mutatingFunctions(readFileSync(FILE, "utf8"));
  it("finds the panel's mutations (invite, role change, remove, links)", () => {
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining(["invite", "changeMemberRole", "removeMember", "createFreeLink", "saveSell"]));
  });
  it.each(fns.map((f) => [f.name, f.body]))("%s refreshes the list it changed", (_name, body) => {
    expect(body).toMatch(LIST_SETTERS);
  });
  it("invite reloads after a success", () => {
    const invite = fns.find((f) => f.name === "invite")!;
    expect(invite.body).toMatch(/toast\.success\("Collaborator added"\);[\s\S]*load\(\)/);
  });
});
