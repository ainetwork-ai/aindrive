import { parseManifestInputs } from "./run-inputs";
import { projectSourceOnAinize, runActorFor } from "./run-ainize";

/** A bound repository never falls back to mutable files when its version is unavailable. */
export async function pinnedSnippetSource(projectId: string, userId: string | null, sha: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) return null;
  const actor = await runActorFor(userId);
  if (!actor) return null;
  try {
    const response = await projectSourceOnAinize({ projectId, target: "commit", sha, actor, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const source = await response.json() as { sha?: string; manifest?: { kind?: string; entry?: string; inputs?: unknown } };
    if (source.sha !== sha || source.manifest?.kind !== "script" || typeof source.manifest.entry !== "string") return null;
    return { sha, entry: source.manifest.entry, inputs: parseManifestInputs(source.manifest.inputs) };
  } catch {
    return null;
  }
}
