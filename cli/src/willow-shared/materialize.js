// GENERATED from web/shared/willow/materialize.ts by web/scripts/mirror-willow-to-cli.mjs — do not edit.
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { yXmlFragmentToProseMirrorRootNode, prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
const kindFor = (path) => /\.(md|markdown)$/i.test(path) ? "markdown" : "text";
const extensions = [StarterKit.configure({ undoRedo: false }), Markdown];
let cached = null;
const md = () => cached ??= { schema: getSchema(extensions), mm: new MarkdownManager({ extensions }) };
function docToFile(doc, kind) {
  if (kind === "text") return doc.getText("content").toString();
  const { schema, mm } = md();
  return mm.serialize(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("prosemirror"), schema).toJSON());
}
function sameContent(kind, a, b) {
  if (kind === "text") return a === b;
  const { mm } = md();
  const norm = (x) => mm.serialize(mm.parse(x)).trimEnd();
  return a === b || norm(a) === norm(b);
}
function fileToUpdate(doc, kind, text) {
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
const idKey = (id) => `${id.client}:${id.clock}`;
function visibleAt(it, snap) {
  const sv = snap.sv;
  return (sv.get(it.id.client) ?? 0) > it.id.clock && !Y.isDeleted(snap.ds, it.id);
}
function blockMd(json) {
  return md().mm.serialize({ type: "doc", content: [json] }).trim();
}
function baseOf(doc, kind) {
  const snapshot = Y.encodeSnapshot(Y.snapshot(doc));
  const text = docToFile(doc, kind);
  if (kind === "text") return { snapshot, text };
  const { schema } = md();
  const frag = doc.getXmlFragment("prosemirror");
  const root = yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON();
  const items = frag.toArray();
  const blocks = items.map((el, i) => ({ id: idKey(el._item.id), md: blockMd((root.content ?? [])[i]) }));
  return { snapshot, text, blocks };
}
function hunk(a, b, eq) {
  let p = 0;
  while (p < a.length && p < b.length && eq(a[p], b[p])) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && eq(a[a.length - 1 - q], b[b.length - 1 - q])) q++;
  return { p, removed: a.length - p - q, added: b.slice(p, b.length - q) };
}
function textThreeWay(doc, base, file) {
  const t = doc.getText("content");
  const snap = Y.decodeSnapshot(base.snapshot);
  const baseIds = [];
  for (let it = t._start; it; it = it.right) {
    if (!it.countable || !visibleAt(it, snap)) continue;
    for (let k = 0; k < it.length; k++) baseIds.push(`${it.id.client}:${it.id.clock + k}`);
  }
  const h = hunk([...base.text], [...file], (x, y) => x === y);
  if (h.removed === 0 && h.added.length === 0) return false;
  const currentIndex = () => {
    const m = /* @__PURE__ */ new Map();
    let i = 0;
    for (let it = t._start; it; it = it.right) {
      if (!it.countable || it.deleted) continue;
      for (let k = 0; k < it.length; k++) m.set(`${it.id.client}:${it.id.clock + k}`, i++);
    }
    return m;
  };
  doc.transact(() => {
    const cur = currentIndex();
    const gone = baseIds.slice(h.p, h.p + h.removed).map((id) => cur.get(id)).filter((i) => i !== void 0).sort((a, b) => b - a);
    for (const i of gone) t.delete(i, 1);
    if (!h.added.length) return;
    const after = currentIndex();
    let at;
    for (let k = h.p + h.removed; k < baseIds.length && at === void 0; k++) at = after.get(baseIds[k]);
    for (let k = h.p - 1; k >= 0 && at === void 0; k--) {
      const i = after.get(baseIds[k]);
      if (i !== void 0) at = i + 1;
    }
    t.insert(at ?? t.length, h.added.join(""));
  });
  return true;
}
function markdownThreeWay(doc, base, file) {
  const { schema, mm } = md();
  const frag = doc.getXmlFragment("prosemirror");
  const fileBlocks = mm.parse(file).content ?? [];
  const fileMd = fileBlocks.map(blockMd);
  const baseBlocks = base.blocks ?? [];
  const h = hunk(baseBlocks.map((b) => b.md), fileMd, (x, y) => x === y);
  if (h.removed === 0 && h.added.length === 0) return false;
  const newJson = fileBlocks.slice(h.p, h.p + h.added.length);
  const indexOf = () => new Map(frag.toArray().map((el, i) => [idKey(el._item.id), i]));
  doc.transact(() => {
    const cur = indexOf();
    const gone = baseBlocks.slice(h.p, h.p + h.removed).map((b) => cur.get(b.id)).filter((i) => i !== void 0).sort((a, b) => b - a);
    for (const i of gone) frag.delete(i, 1);
    if (!newJson.length) return;
    const after = indexOf();
    let at;
    for (let k = h.p + h.removed; k < baseBlocks.length && at === void 0; k++) at = after.get(baseBlocks[k].id);
    for (let k = h.p - 1; k >= 0 && at === void 0; k--) {
      const i = after.get(baseBlocks[k].id);
      if (i !== void 0) at = i + 1;
    }
    const tmp = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, { type: "doc", content: newJson }, tmp.getXmlFragment("prosemirror"));
    frag.insert(at ?? frag.length, tmp.getXmlFragment("prosemirror").toArray().map((el) => el.clone()));
  });
  return true;
}
function threeWayUpdate(doc, kind, base, file) {
  if (sameContent(kind, base.text, file)) return null;
  const before = Y.encodeStateVector(doc);
  const changed = kind === "text" ? textThreeWay(doc, base, file) : markdownThreeWay(doc, base, file);
  return changed ? Y.encodeStateAsUpdate(doc, before) : null;
}
function isLossy(kind, text) {
  if (kind !== "markdown") return false;
  return [
    /^---\r?\n[\s\S]*?\r?\n---\r?\n/,
    // frontmatter
    /^\s*\|.*\|\s*$\r?\n^\s*\|?\s*:?-{3,}/m,
    // table header + separator
    /^\s*<[a-zA-Z][^>]*>/m,
    // raw HTML block
    /!\[[^\]]*\]\([^)]*\)/,
    // image
    /^\s*[-*+]\s+\[[ xX]\]\s/m,
    // task list
    /\[\^[^\]]+\]/
    // footnote
  ].some((re) => re.test(text));
}
export {
  baseOf,
  docToFile,
  fileToUpdate,
  isLossy,
  kindFor,
  sameContent,
  threeWayUpdate
};
