// Markdown → HTML for agent replies (aindrive-cloud answers in GitHub-flavoured Markdown: headings,
// tables, lists, code). `marked` parses; DOMPurify then strips anything but plain formatting, so a
// reply can never inject markup or scripts. Links open outside the app and only for http(s).
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

const ALLOWED_TAGS = ["p", "br", "strong", "em", "b", "i", "s", "del", "code", "pre", "blockquote", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "sup", "sub"];
const ALLOWED_ATTR = ["href", "align"];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) node.removeAttribute("href");
    else { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener"); }
  }
});

export function md(text: string): string {
  const html = marked.parse(text ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ADD_ATTR: ["target", "rel"] });
}
