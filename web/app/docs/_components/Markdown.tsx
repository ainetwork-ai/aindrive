import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";

/** Server-rendered markdown with in-site links and heading anchors. */
export function Markdown({ source }: { source: string }) {
  const slug = (children: React.ReactNode) =>
    String(Array.isArray(children) ? children.join("") : children).toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href = "", children }) =>
          href.startsWith("/") ? <Link href={href}>{children}</Link> : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        h2: ({ children }) => <h2 id={slug(children)}>{children}</h2>,
        h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
