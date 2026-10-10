/**
 * `ainize.json` `inputs`: parameters a person fills in before a run — the same
 * shape as GitHub Actions `workflow_dispatch.inputs` (ainize-node docs/PROJECTS.md):
 *
 *   "inputs": {
 *     "DESC":  { "description": "작품 묘사", "type": "string", "required": true, "default": "…" },
 *     "MODEL": { "description": "모델", "type": "choice", "options": ["clef-flash", "clef"], "default": "clef-flash" }
 *   }
 *
 * Delivered to the program as `INPUT_<NAME>` environment variables (name
 * upper-cased; booleans `true|false`, numbers as decimal text). The git panel
 * renders one field per input (text / select / checkbox / number), prefilled
 * with `default` and remembered per repo; the run route sends the answers as
 * `env`. Pure functions, shared by the route (validation, caps) and the UI.
 */
export const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const INPUTS_MAX = 16;
export const INPUT_VALUE_MAX = 2048;

export type ManifestInputType = "string" | "choice" | "boolean" | "number";
export type ManifestInput = {
  name: string;
  description: string | null;
  type: ManifestInputType;
  required: boolean;
  options: string[] | null;
  /** As text (`true`/`false` for booleans), or null. */
  default: string | null;
};

/** The environment variable an input is delivered as: `INPUT_<NAME>`, upper-cased. */
export const inputEnvName = (name: string) => `INPUT_${name.toUpperCase()}`;

/** The manifest's `inputs` as the UI needs them (declaration order); malformed entries are dropped, the list capped. */
export function parseManifestInputs(raw: unknown): ManifestInput[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: ManifestInput[] = [];
  const seenEnv = new Set<string>();
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= INPUTS_MAX) break;
    if (!INPUT_NAME.test(name) || seenEnv.has(inputEnvName(name))) continue;
    const o = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {};
    const type: ManifestInputType = o.type === "choice" || o.type === "boolean" || o.type === "number" ? o.type : "string";
    const options = type === "choice" && Array.isArray(o.options) ? o.options.filter((v): v is string => typeof v === "string" && v.length <= INPUT_VALUE_MAX).slice(0, 64) : null;
    if (type === "choice" && (!options || options.length === 0)) continue;
    let def: string | null = null;
    if (typeof o.default === "string") def = o.default;
    else if (typeof o.default === "number" && Number.isFinite(o.default)) def = String(o.default);
    else if (typeof o.default === "boolean") def = String(o.default);
    if (def !== null && def.length > INPUT_VALUE_MAX) def = null;
    seenEnv.add(inputEnvName(name));
    out.push({ name, description: typeof o.description === "string" && o.description.trim() ? o.description.trim() : null, type, required: o.required === true, options, default: def });
  }
  return out;
}

/** Each input's default as `INPUT_<NAME>` env (what a run with no answers gets). */
export function inputDefaults(inputs: ManifestInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs) if (i.default !== null) out[inputEnvName(i.name)] = i.default;
  return out;
}

/** The person's answers (by input name) as the env a run request carries; missing answers fall back to defaults. */
export function inputsToEnv(inputs: ManifestInput[], values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const i of inputs) {
    const v = values[i.name] ?? i.default;
    if (v !== undefined && v !== null) env[inputEnvName(i.name)] = v;
  }
  return env;
}

/** Inputs marked `required` whose answer (or default) is empty. */
export function missingRequired(inputs: ManifestInput[], values: Record<string, string>): string[] {
  return inputs.filter((i) => i.required && !((values[i.name] ?? i.default ?? "").trim())).map((i) => i.name);
}

/** `env` a run request may carry: ≤ 16 env names, values ≤ 2 KiB. Null = refused. */
export function validateRunEnv(raw: unknown): Record<string, string> | null {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > INPUTS_MAX) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!INPUT_NAME.test(k)) return null;
    const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? String(v) : v;
    if (typeof s !== "string" || s.length > INPUT_VALUE_MAX) return null;
    out[k] = s;
  }
  return out;
}

/** localStorage key for the remembered answers of one repo. */
export const inputsStorageKey = (driveId: string, repo: string) => `aindrive:run-inputs:${driveId}:${repo}`;
