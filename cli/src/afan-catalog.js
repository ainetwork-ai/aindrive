/**
 * The Ainize agent registry, as the afan bridge (afan-bridge.js) needs it: one listing that both resolves a
 * request's `agent.key` and becomes the bundle's `_catalog.md` (`afan Agent Catalog`), so the afan app —
 * which has no network code — has something to pick from.
 *
 * Source: `GET {AINIZE_URL}/api/shared-agents?scope=public` (contract `AgentListResponse`:
 * `items[] = { ref: AgentRef, canInvoke }`). On 404 it falls back to `GET /api/info` (`node.agents[]`) +
 * `GET /api/hosted-agents` (`agents[]`), with the mapping of ain-integration `docs/adapter-spec.md`
 * (hosted wins over info for the same id). The optional bearer (`AINIZE_TOKEN`) goes in a header only and is
 * never logged or written.
 *
 * Field names of the catalog rows mirror afan-soverign `packages/core/src/schema.ts`
 * (`AgentCatalogRowFrontmatter`) — hand-mirrored, per the repo's no-shared-code rule.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const DEFAULT_AINIZE_URL = "https://ainize.ai";
export const CATALOG_PATH = "_catalog.md";
export const CATALOG_TYPE = "afan Agent Catalog";
/** The catalog is rewritten at most this often (the registry is asked no more often for it). */
export const CATALOG_MIN_INTERVAL_MS = 10 * 60_000;

const trimSlash = (s) => String(s || "").replace(/\/+$/, "");

/** An ISO instant without milliseconds — the form the afan bundle writes. */
export function isoSeconds(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Only the public half of a JWK ever reaches the bundle. */
function publicJwk(jwk) {
  if (!jwk || typeof jwk !== "object") return undefined;
  const out = {};
  for (const k of ["kty", "crv", "x", "y", "n", "e", "kid", "alg"]) if (typeof jwk[k] === "string") out[k] = jwk[k];
  return out.kty ? out : undefined;
}

function skillsOf(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s === "object" && typeof (s.id ?? s.name) === "string")
    .slice(0, 32)
    .map((s) => ({ id: String(s.id ?? s.name), name: String(s.name ?? s.id), ...(typeof s.description === "string" ? { description: s.description } : {}) }));
}

/** One registry entry in the shape the bridge uses (never carries a credential). */
function entryFromRef(ref, canInvoke) {
  if (!ref || typeof ref !== "object" || typeof ref.registryIssuer !== "string" || typeof ref.agentId !== "string") return null;
  return {
    agentKey: `${trimSlash(ref.registryIssuer)}#${ref.agentId}`,
    name: typeof ref.displayName === "string" ? ref.displayName : ref.agentId,
    releaseId: typeof ref.releaseId === "string" ? ref.releaseId : undefined,
    endpoint: typeof ref.endpoint === "string" ? ref.endpoint : undefined,
    status: typeof ref.status === "string" ? ref.status : "active",
    pop: publicJwk(ref.popJwk),
    skills: skillsOf(ref.skills),
    canInvoke: canInvoke !== false,
  };
}

/** `/api/info` + `/api/hosted-agents` → entries (adapter-spec.md fallback). */
function entriesFromFallback(issuer, info, hosted) {
  const byId = new Map();
  for (const a of info?.node?.agents ?? []) {
    if (!a || typeof a.id !== "string") continue;
    byId.set(a.id, {
      agentKey: `${issuer}#${a.id}`, name: typeof a.name === "string" ? a.name : a.id, releaseId: "upstream",
      endpoint: typeof a.url === "string" ? a.url : undefined, status: a.reachable === false ? "stopped" : "active",
      pop: undefined, skills: [], canInvoke: a.reachable !== false,
    });
  }
  for (const a of hosted?.agents ?? []) {
    if (!a || typeof a.id !== "string") continue;
    const status = a.status === "ready" || a.status === "active" ? "active" : (["disabled", "stopped", "deleted"].includes(a.status) ? a.status : "stopped");
    byId.set(a.id, {
      agentKey: `${issuer}#${a.id}`, name: typeof a.name === "string" ? a.name : a.id,
      releaseId: a.version != null ? `v${a.version}` : "upstream",
      endpoint: typeof a.a2a_url === "string" ? a.a2a_url : undefined, status,
      pop: undefined, skills: [], canInvoke: status === "active",
    });
  }
  return [...byId.values()];
}

async function getJson(fetchImpl, url, token) {
  const res = await fetchImpl(url, { headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

/**
 * The public registry listing. Throws (with the HTTP status only, never a header) when the registry cannot be
 * read; the caller turns that into `source_offline`.
 */
export async function fetchRegistry({ ainizeUrl = DEFAULT_AINIZE_URL, token, fetchImpl = fetch } = {}) {
  const issuer = trimSlash(ainizeUrl);
  const primary = await getJson(fetchImpl, `${issuer}/api/shared-agents?scope=public`, token);
  if (primary.status === 200 && Array.isArray(primary.json?.items)) {
    return primary.json.items.map((it) => entryFromRef(it?.ref, it?.canInvoke)).filter(Boolean);
  }
  if (primary.status !== 404) throw new Error(`registry answered ${primary.status}`);
  const [info, hosted] = await Promise.all([
    getJson(fetchImpl, `${issuer}/api/info`, token),
    getJson(fetchImpl, `${issuer}/api/hosted-agents`, token),
  ]);
  if (info.status !== 200 && hosted.status !== 200) throw new Error(`registry answered ${hosted.status}`);
  return entriesFromFallback(issuer, info.status === 200 ? info.json : null, hosted.status === 200 ? hosted.json : null);
}

/** The `_catalog.md` text for a listing. */
export function catalogMarkdown(entries, asOf = isoSeconds()) {
  const agents = entries.map((e) => ({
    agent_key: e.agentKey,
    name: e.name,
    status: e.status,
    ...(e.pop ? { pop: e.pop } : {}),
    skills: e.skills,
    can_invoke: e.canInvoke && e.status === "active",
    ...(e.endpoint ? { endpoint: e.endpoint } : {}),
    ...(e.releaseId ? { release_id: e.releaseId } : {}),
  }));
  const fm = {
    type: CATALOG_TYPE,
    title: "Shared agents",
    description: "The agents this drive's aindrive host can call for you, copied from the Ainize registry.",
    as_of: asOf,
    agents,
    generated: { by: "agent:aindrive-cli", at: asOf },
  };
  const body = ["# Agents", "", ...agents.map((a) => `* ${a.name} — \`${a.agent_key}\`${a.can_invoke ? "" : " (unavailable)"}`), ""].join("\n");
  return `---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n${body}`;
}

/** `as_of` of the catalog on disk, in ms, or 0. Lets a restarted host keep the 10-minute cadence. */
export async function catalogAsOf(root) {
  try {
    const raw = await fsp.readFile(join(root, CATALOG_PATH), "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const fm = m ? parseYaml(m[1]) : null;
    const t = Date.parse(fm?.as_of ?? "");
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}
