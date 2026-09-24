import { notFound } from "next/navigation";
import { Markdown } from "./_components/Markdown";
import { readDoc } from "./_lib";

export const dynamic = "force-static";

export default function DocsHome() {
  const src = readDoc("");
  if (!src) notFound();
  return <article className="docs-prose"><Markdown source={src} /></article>;
}
