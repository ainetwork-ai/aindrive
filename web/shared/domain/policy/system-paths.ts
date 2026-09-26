/**
 * Reserved drive paths — accessible only to the drive's CLI and to
 * trusted server-internal code, never to cap-bearers via fs/* RPC.
 *
 * The drive's `.aindrive/` subtree holds aindrive's own metadata
 * (agent JSON files including `llm.apiKey`, future per-agent state,
 * y.js binaries, the agent token & drive secret). If a cap-bearer
 * could read this they could exfiltrate API keys and forge requests.
 *
 * Enforcement points (every user-initiated drive path MUST go through one):
 *   - lib/require-access.ts requireDriveRole — every fs/* and yjs route
 *   - lib/zod-helpers.ts zPath — every JSON-body path (fs ops, shares,
 *     members, payout)
 *   - shared/agent-skills.ts runSkill — MCP + A2A skills
 *   - cli/src/rpc.js safeResolve — agent-side second layer (allows only
 *     .aindrive/agents + .aindrive/uploads, which the server drives itself)
 *
 * Server-internal callers (e.g. FsAgentRepo loading an agent JSON) do
 * NOT route through cap-bearer middleware, so they bypass this check.
 *
 * SINGLE FAILURE POINT: misroute a cap-bearer request around this and
 * keys leak. Unit tests cover positive and negative cases below.
 */

const SYSTEM_PREFIX = ".aindrive";

/**
 * Returns true iff `path` is at or under the reserved aindrive subtree.
 *
 *   isSystemPath(".aindrive")              → true
 *   isSystemPath(".aindrive/")             → true
 *   isSystemPath(".aindrive/agents/x.json")→ true
 *   isSystemPath(".AINDRIVE/config.json")  → true   (any letter case: a macOS
 *                                                    agent's filesystem ignores it)
 *   isSystemPath("docs/.aindrive-notes")   → false  (only reserved at root)
 *   isSystemPath("aindrive")               → false  (no leading dot)
 *   isSystemPath("")                       → false  (root, allowed)
 *   isSystemPath(".")                      → false  (current, allowed)
 *
 * `path` is expected to be the drive-relative path used in fs RPCs
 * (forward-slash separated, no leading slash).
 */
export function isSystemPath(path: string): boolean {
  if (typeof path !== "string") return false;
  return path.split("/")[0].toLowerCase() === SYSTEM_PREFIX;
}
