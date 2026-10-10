/**
 * What a repo says it runs (server only; through the drive's agent). Shared by
 * the git-meta route (the web git panel) and the AIN-UI link snippet
 * (lib/ainui-snippet-server.ts): `ainize.json` at the repo root — `entry`,
 * `kind`, `name`, `inputs` (lib/run-inputs.ts) — and the root's runnable files.
 */
import { callAgent } from "./rpc";
import { languageFor } from "./run-ainize";
import type { DriveEntry } from "./protocol";
import { parseManifestInputs, type ManifestInput } from "./run-inputs";

/** `ainize.json` at the repo root: what the project is and what to run. Absent / malformed → null. */
export type AinizeManifest = { entry: string | null; kind: string | null; name: string | null; inputs: ManifestInput[] };
export const MANIFEST = "ainize.json";

export async function readManifest(driveId: string, secret: string, repo: string): Promise<AinizeManifest | null> {
  const p = repo ? `${repo}/${MANIFEST}` : MANIFEST;
  try {
    const r = await callAgent(driveId, secret, { method: "read", path: p, encoding: "utf8", maxBytes: 64 * 1024 }, { timeoutMs: 5_000 });
    const j = JSON.parse(r.content) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { entry: str(j.entry), kind: str(j.kind), name: str(j.name), inputs: parseManifestInputs(j.inputs) };
  } catch { return null; }
}

/** The root's `.py`/`.js`/`.mjs` files by name, `main.*`/`index.*` first — the Run row's choices; the first is the default entry. */
export async function runnableFiles(driveId: string, secret: string, repo: string): Promise<string[]> {
  try {
    const { entries } = await callAgent(driveId, secret, { method: "list", path: repo }, { timeoutMs: 5_000 }) as { entries: DriveEntry[] };
    const files = entries.filter((e) => !e.isDir && languageFor(e.name)).map((e) => e.name);
    const rank = (n: string) => (/^main\./i.test(n) ? 0 : /^index\./i.test(n) ? 1 : 2);
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return files;
  } catch { return []; }
}
