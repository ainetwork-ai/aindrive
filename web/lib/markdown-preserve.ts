// Source-preserving markdown write-back for the rich-text editor.
//
// TipTap's markdown serializer is normalizing (`<url>` → `[url](url)`, blank
// lines re-flowed) and lossy (no table extension → a table is dropped). Writing
// `editor.getMarkdown()` straight to disk therefore rewrites every block the
// user never touched and can delete content. `mergePreservingSource` takes the
// text as it was on disk and the editor's serialization and returns a version
// where every block the user did not edit keeps its ORIGINAL lines, and every
// original block the serializer cannot represent (its canonical form is empty)
// is kept at its position instead of vanishing.
//
// Blocks are blank-line separated paragraphs; fenced code blocks are one block
// even when they contain blank lines. `canon(block)` is the editor's own
// parse→serialize round trip, so an untouched block matches by canonical form
// regardless of how the serializer re-spells it.

export function splitBlocks(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  const flush = () => { if (cur.length) { blocks.push(cur.join("\n")); cur = []; } };
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      cur.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { flush(); fence = f[1]; cur.push(line); continue; }
    if (line.trim() === "") { flush(); continue; }
    cur.push(line);
  }
  flush();
  return blocks;
}

export type Canon = (block: string) => string;

/** Plain words of a markdown chunk: punctuation and whitespace folded away, so a
 *  re-spelled block (`<url>` vs `[url](url)`, a table flattened into a paragraph)
 *  still reads as the same text. */
export function textOf(md: string): string {
  return md.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}

/**
 * `original`: the file as it is on disk. `serialized`: the editor's current
 * getMarkdown(). `canon(md)`: the editor's parse→serialize of `md`.
 *
 * Each serialized block is matched to the next unconsumed original block, first
 * by canonical equality, then by plain text (the serializer re-spelled it); a
 * match emits the ORIGINAL lines. An unmatched serialized block is the user's
 * (edited or new) and is emitted as is. An original block that is never
 * matched was either deleted by the user or dropped by the serializer: it is
 * kept when its plain text is absent from canon(original) — the serializer
 * cannot carry it, so its absence from the output says nothing about the user.
 */
export function mergePreservingSource(original: string, serialized: string, canon: Canon): string {
  const origBlocks = splitBlocks(original);
  const origCanon = origBlocks.map((b) => safeCanon(canon, b));
  const origText = origBlocks.map(textOf);
  const docCanonText = textOf(safeCanon(canon, original));
  const unrepresentable = origBlocks.map((_, i) => origText[i] !== "" && !docCanonText.includes(origText[i]));
  const serBlocks = splitBlocks(serialized);
  const out: string[] = [];
  let p = 0; // next unconsumed original block
  const emitUnrepresentableUpTo = (end: number) => {
    for (let i = p; i < end; i++) if (unrepresentable[i]) out.push(origBlocks[i]);
  };
  for (const sb of serBlocks) {
    const want = sb.trim();
    const wantText = textOf(sb);
    let hit = -1;
    for (let i = p; i < origBlocks.length && hit === -1; i++) {
      if (origCanon[i] !== "" && origCanon[i] === want) hit = i;
    }
    for (let i = p; i < origBlocks.length && hit === -1; i++) {
      if (wantText !== "" && origText[i] === wantText) hit = i;
    }
    if (hit === -1) { out.push(sb); continue; } // edited or new block: take the editor's text
    emitUnrepresentableUpTo(hit);
    out.push(origBlocks[hit]);
    p = hit + 1;
  }
  emitUnrepresentableUpTo(origBlocks.length);
  const joined = out.join("\n\n");
  // Keep the original file's trailing-newline convention.
  return original.endsWith("\n") ? joined + "\n" : joined;
}

function safeCanon(canon: Canon, block: string): string {
  try { return canon(block).trim(); } catch { return block.trim(); }
}
