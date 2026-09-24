import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "../_components/Markdown";
import { SkillsReference } from "../_components/SkillsReference";
import { Playground } from "../_components/Playground";
import { DOCS_PAGES, readDoc } from "../_lib";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS_PAGES.filter((p) => p.slug).map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = DOCS_PAGES.find((p) => p.slug === slug);
  return { title: page ? `${page.title} — aindrive docs` : "aindrive docs" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (slug === "skills") return <article className="docs-prose"><SkillsReference /></article>;
  const src = readDoc(slug);
  if (!src) notFound();
  return (
    <article className="docs-prose">
      <Markdown source={src} />
      {slug === "a2ui" && <Playground />}
    </article>
  );
}
