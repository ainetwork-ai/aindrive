"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function DocsNav({ pages }: { pages: { href: string; title: string }[] }) {
  const path = usePathname();
  return (
    <nav className="docs-nav" aria-label="Docs">
      {pages.map((p) => (
        <Link key={p.href} href={p.href} className={path === p.href ? "active" : undefined}>
          {p.title}
        </Link>
      ))}
    </nav>
  );
}
