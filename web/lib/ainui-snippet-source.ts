import { parseManifestInputs } from "./run-inputs";
import { projectSourceOnAinize, runActorFor } from "./run-ainize";

/** A bound repository never falls back to mutable files when its version is unavailable. */
export async function selectedSnippetSource(projectId: string, userId: string | null, target: 'head' | 'commit' | 'deployed', sha?: string, signal?: AbortSignal) {
  if (target === 'commit' && (!sha || !/^[a-f0-9]{40,64}$/.test(sha))) return null;
  const actor = await runActorFor(userId);
  if (!actor) return null;
  try {
    const response = await projectSourceOnAinize({ projectId, target, sha, actor, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const source = await response.json() as { sha?: string; manifest?: { kind?: string; entry?: string; inputs?: unknown } };
    if (!source.sha || !/^[a-f0-9]{40,64}$/.test(source.sha) || (sha && source.sha !== sha) || !source.manifest?.kind) return null;
    return { sha: source.sha, kind: source.manifest.kind, entry: typeof source.manifest.entry === 'string' ? source.manifest.entry : null, inputs: parseManifestInputs(source.manifest.inputs) };
  } catch {
    return null;
  }
}

export async function pinnedSnippetSource(projectId: string, userId: string | null, sha: string, signal?: AbortSignal) {
  const source = await selectedSnippetSource(projectId, userId, 'commit', sha, signal);
  return source?.kind === 'script' && source.entry ? { sha: source.sha, entry: source.entry, inputs: source.inputs } : null;
}
