// A small Markdown → HTML renderer for agent replies (aindrive-cloud answers in Markdown: headings,
// **bold**, lists, code). Text is escaped FIRST, then marked up, so a reply can never inject HTML;
// links are kept only for http(s). No library: the shell's bundle stays small and offline.
import { esc } from "./kit";

const inline = (s: string): string => s
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

/** Markdown → HTML. Plain text (no markup) comes out as paragraphs with line breaks kept. */
export function md(text: string): string {
  const lines = esc(text.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null, para: string[] = [], code: string[] | null = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    if (code) { if (/^```/.test(raw)) { out.push(`<pre><code>${code.join("\n")}</code></pre>`); code = null; } else code.push(raw); continue; }
    const line = raw.trimEnd();
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const n = Math.min(h[1].length + 1, 4); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const li = /^\s*(?:[-*•·]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) { flushPara(); const kind = li[1] ? "ol" : "ul"; if (list !== kind) { flushList(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(li[2])}</li>`); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    flushList();
    para.push(line.replace(/^>\s?/, ""));
  }
  if (code) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushPara(); flushList();
  return out.join("");
}
