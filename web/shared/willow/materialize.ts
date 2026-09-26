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
