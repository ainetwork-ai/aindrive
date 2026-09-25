/**
 * Docs site plumbing (/docs). Pages are markdown in ./content, read at BUILD
 * time (the pages are force-static, so the runtime image needs no app/ files).
 * `{{BASE}}` in content becomes the public origin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DOCS_PAGES = [
  { slug: "", title: "Overview" },
  { slug: "auth", title: "Authentication" },
  { slug: "mcp", title: "MCP" },
  { slug: "a2a", title: "A2A" },
  { slug: "ag-ui", title: "AG-UI" },
  { slug: "a2ui", title: "A2UI & playground" },
  { slug: "skills", title: "Skills reference" },
] as const;

export const DOCS_BASE = (process.env.AINDRIVE_PUBLIC_URL || "https://aindrive.ainetwork.ai").replace(/\/$/, "");

export function readDoc(slug: string): string | null {
  const file = join(process.cwd(), "app/docs/content", `${slug || "index"}.md`);
  try {
    return readFileSync(file, "utf8").replaceAll("{{BASE}}", DOCS_BASE);
  } catch {
    return null;
  }
}
