// web/components/editors/authorship.ts
// "Who wrote this" (spec §6): the Yjs item under a character carries the clientID
// of the device session that typed it; authorsByClient maps that to the signed
// device key; the device's certificate names the person.
import * as Y from "yjs";
import { resolvePerson, type Cert, type Trust } from "@/shared/willow/cert";

export function authorAt(doc: Y.Doc, index: number, authors: Map<number, string>): string | null {
  let pos = 0;
  let item = doc.getText("content")._start;
  while (item) {
    if (!item.deleted && item.countable) {
      if (index < pos + item.length) return authors.get(item.id.client) ?? null;
      pos += item.length;
    }
    item = item.right;
  }
  return null;
}

export async function labelFor(deviceHex: string, certs: Cert[], trust: Trust, names: Map<string, string>): Promise<string> {
  const p = await resolvePerson(deviceHex, certs, [], trust);
  if (!p) return "unknown device";
  return `${names.get(p.userId) ?? p.userId} · ${p.strength === "wallet" ? "wallet" : "vouched by aindrive"}`;
}
