// web/shared/willow/materialize.ts
// A collaborative document ⇄ the file on disk (spec D8). Plain text lives in
// Y.Text("content") (Monaco); markdown in XmlFragment("prosemirror") (Tiptap),
// rendered with the editor's own schema and serializer, headless.
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { yXmlFragmentToProseMirrorRootNode, prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";

export type Kind = "markdown" | "text";
export const kindFor = (path: string): Kind => (/\.(md|markdown)$/i.test(path) ? "markdown" : "text");

// the same extensions as components/editors/rich-text-editor.tsx (minus the collaboration ones)
const extensions = [StarterKit.configure({ undoRedo: false }), Markdown];
let cached: { schema: ReturnType<typeof getSchema>; mm: MarkdownManager } | null = null;
const md = () => (cached ??= { schema: getSchema(extensions), mm: new MarkdownManager({ extensions } as never) });

export function docToFile(doc: Y.Doc, kind: Kind): string {
  if (kind === "text") return doc.getText("content").toString();
  const { schema, mm } = md();
  return mm.serialize(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("prosemirror"), schema).toJSON());
}

/** Same content: plain text byte for byte; markdown when both render the same through
 *  the editor's schema ("*" and "-" bullets are one list). */
export function sameContent(kind: Kind, a: string, b: string): boolean {
  if (kind === "text") return a === b;
  const { mm } = md();
  const norm = (x: string) => mm.serialize(mm.parse(x)).trimEnd();
  return a === b || norm(a) === norm(b);
}

export function fileToUpdate(doc: Y.Doc, kind: Kind, text: string): Uint8Array | null {
  const before = Y.encodeStateVector(doc);
  if (kind === "text") {
    const t = doc.getText("content");
    const cur = t.toString();
    if (cur === text) return null;
    let p = 0;
    while (p < cur.length && p < text.length && cur[p] === text[p]) p++;
    let s = 0;
    while (s < cur.length - p && s < text.length - p && cur[cur.length - 1 - s] === text[text.length - 1 - s]) s++;
    doc.transact(() => {
      t.delete(p, cur.length - p - s);
      t.insert(p, text.slice(p, text.length - s));
    });
  } else {
    const { schema, mm } = md();
    if (docToFile(doc, "markdown").trimEnd() === mm.serialize(mm.parse(text)).trimEnd()) return null;
    const frag = doc.getXmlFragment("prosemirror");
    doc.transact(() => {
      frag.delete(0, frag.length);
      prosemirrorJSONToYXmlFragment(schema, mm.parse(text), frag);
    });
  }
  return Y.encodeStateAsUpdate(doc, before);
}

// ── three-way disk merge (plan 3 review C1/I1) ───────────────────────────────
// The agent remembers the base: the document as it was when the file was last
// written or read (a Yjs snapshot, plus per-block markdown for .md). A disk edit is
// the difference base → file, applied to the CURRENT document through the
// snapshot, so edits made since the base (other people's typing) survive.
// Documents must be loaded with gc: false so the snapshot's items still exist.

export type Base = { snapshot: Uint8Array; text: string; blocks?: { id: string; md: string }[] };

const idKey = (id: { client: number; clock: number }) => `${id.client}:${id.clock}`;

type ItemLike = { id: { client: number; clock: number }; right: ItemLike | null; countable: boolean; deleted: boolean; length: number; content: { type?: unknown } };

// Visible at the snapshot: created before it and not deleted in it (yjs's own
// isVisible is not exported).
function visibleAt(it: ItemLike, snap: Y.Snapshot): boolean {
  const sv = (snap as unknown as { sv: Map<number, number> }).sv;
  return (sv.get(it.id.client) ?? 0) > it.id.clock && !Y.isDeleted((snap as unknown as { ds: Parameters<typeof Y.isDeleted>[0] }).ds, it.id as never);
}

function blockMd(json: unknown): string {
  return md().mm.serialize({ type: "doc", content: [json] } as never).trim();
}

export function baseOf(doc: Y.Doc, kind: Kind): Base {
  const snapshot = Y.encodeSnapshot(Y.snapshot(doc));
  const text = docToFile(doc, kind);
  if (kind === "text") return { snapshot, text };
  const { schema } = md();
  const frag = doc.getXmlFragment("prosemirror");
  const root = yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON() as { content?: unknown[] };
  const items = frag.toArray();
  const blocks = items.map((el, i) => ({ id: idKey((el as unknown as { _item: ItemLike })._item.id), md: blockMd((root.content ?? [])[i]) }));
  return { snapshot, text, blocks };
}

/** One hunk: the common prefix and suffix of two sequences. */
function hunk<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean) {
  let p = 0;
  while (p < a.length && p < b.length && eq(a[p], b[p])) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && eq(a[a.length - 1 - q], b[b.length - 1 - q])) q++;
  return { p, removed: a.length - p - q, added: b.slice(p, b.length - q) };
}

function textThreeWay(doc: Y.Doc, base: Base, file: string) {
  const t = doc.getText("content");
  const snap = Y.decodeSnapshot(base.snapshot);
  // one id per character visible at the base
  const baseIds: string[] = [];
  for (let it = (t as unknown as { _start: ItemLike | null })._start; it; it = it.right) {
    if (!it.countable || !visibleAt(it, snap)) continue;
    for (let k = 0; k < it.length; k++) baseIds.push(`${it.id.client}:${it.id.clock + k}`);
  }
  const h = hunk([...base.text], [...file], (x, y) => x === y);
  if (h.removed === 0 && h.added.length === 0) return false;
  const currentIndex = () => {
    const m = new Map<string, number>(); let i = 0;
    for (let it = (t as unknown as { _start: ItemLike | null })._start; it; it = it.right) {
      if (!it.countable || it.deleted) continue;
      for (let k = 0; k < it.length; k++) m.set(`${it.id.client}:${it.id.clock + k}`, i++);
    }
    return m;
  };
  doc.transact(() => {
    // delete the base characters the file removed, where they still exist
    const cur = currentIndex();
    const gone = baseIds.slice(h.p, h.p + h.removed).map((id) => cur.get(id)).filter((i): i is number => i !== undefined).sort((a, b) => b - a);
    for (const i of gone) t.delete(i, 1);
    if (!h.added.length) return;
    // insert where the hunk was: before the next surviving base character, else after the previous one
    const after = currentIndex();
    let at: number | undefined;
    for (let k = h.p + h.removed; k < baseIds.length && at === undefined; k++) at = after.get(baseIds[k]);
    for (let k = h.p - 1; k >= 0 && at === undefined; k--) { const i = after.get(baseIds[k]); if (i !== undefined) at = i + 1; }
    t.insert(at ?? t.length, h.added.join(""));
  });
  return true;
}

function markdownThreeWay(doc: Y.Doc, base: Base, file: string) {
  const { schema, mm } = md();
  const frag = doc.getXmlFragment("prosemirror");
  const fileBlocks = ((mm.parse(file) as { content?: unknown[] }).content ?? []);
  const fileMd = fileBlocks.map(blockMd);
  const baseBlocks = base.blocks ?? [];
  const h = hunk(baseBlocks.map((b) => b.md), fileMd, (x, y) => x === y);
  if (h.removed === 0 && h.added.length === 0) return false;
  const newJson = fileBlocks.slice(h.p, h.p + h.added.length);
  const indexOf = () => new Map(frag.toArray().map((el, i) => [idKey((el as unknown as { _item: ItemLike })._item.id), i]));
  doc.transact(() => {
    const cur = indexOf();
    const gone = baseBlocks.slice(h.p, h.p + h.removed).map((b) => cur.get(b.id)).filter((i): i is number => i !== undefined).sort((a, b) => b - a);
    for (const i of gone) frag.delete(i, 1);
    if (!newJson.length) return;
    const after = indexOf();
    let at: number | undefined;
    for (let k = h.p + h.removed; k < baseBlocks.length && at === undefined; k++) at = after.get(baseBlocks[k].id);
    for (let k = h.p - 1; k >= 0 && at === undefined; k--) { const i = after.get(baseBlocks[k].id); if (i !== undefined) at = i + 1; }
    const tmp = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, { type: "doc", content: newJson }, tmp.getXmlFragment("prosemirror"));
    frag.insert(at ?? frag.length, tmp.getXmlFragment("prosemirror").toArray().map((el) => (el as Y.XmlElement).clone()));
  });
  return true;
}

/** The disk edit base → file as an update to the current doc, or null when the file equals the base. */
export function threeWayUpdate(doc: Y.Doc, kind: Kind, base: Base, file: string): Uint8Array | null {
  if (sameContent(kind, base.text, file)) return null;
  const before = Y.encodeStateVector(doc);
  const changed = kind === "text" ? textThreeWay(doc, base, file) : markdownThreeWay(doc, base, file);
  return changed ? Y.encodeStateAsUpdate(doc, before) : null;
}

/**
 * Markdown the editor's schema cannot hold (tables, frontmatter, raw HTML blocks,
 * images, task lists, footnotes): such a file is not merged or rewritten; the file
 * stays the truth (plan 3 review I2).
 */
export function isLossy(kind: Kind, text: string): boolean {
  if (kind !== "markdown") return false;
  return [
    /^---\r?\n[\s\S]*?\r?\n---\r?\n/, // frontmatter
    /^\s*\|.*\|\s*$\r?\n^\s*\|?\s*:?-{3,}/m, // table header + separator
    /^\s*<[a-zA-Z][^>]*>/m, // raw HTML block
    /!\[[^\]]*\]\([^)]*\)/, // image
    /^\s*[-*+]\s+\[[ xX]\]\s/m, // task list
    /\[\^[^\]]+\]/, // footnote
  ].some((re) => re.test(text));
}
