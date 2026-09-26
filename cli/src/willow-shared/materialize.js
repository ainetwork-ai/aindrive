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
export {
  docToFile,
  fileToUpdate,
  kindFor
};
