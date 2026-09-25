import type { Metadata } from "next";
import Link from "next/link";
import { DOCS_PAGES } from "./_lib";
import { DocsNav } from "./_components/DocsNav";
import "./docs.css";

export const metadata: Metadata = {
  title: "aindrive docs — MCP, A2A, AG-UI, A2UI integration guide",
  description: "Connect aindrive drives to AI hosts and agents over MCP, A2A and AG-UI, with ready-to-render A2UI surfaces.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-shell">
      <header className="docs-header">
        <Link href="/" className="docs-brand">aindrive</Link>
        <span className="docs-sep">/</span>
        <Link href="/docs" className="docs-brand-sub">docs</Link>
      </header>
      <div className="docs-body">
        <DocsNav pages={DOCS_PAGES.map((p) => ({ href: p.slug ? `/docs/${p.slug}` : "/docs", title: p.title }))} />
        <main className="docs-main">{children}</main>
      </div>
    </div>
  );
}
