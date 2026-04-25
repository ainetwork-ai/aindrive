/**
 * Reserved drive paths — accessible only to the drive's CLI and to
 * trusted server-internal code, never to cap-bearers via fs/* RPC.
 *
 * The drive's `.aindrive/` subtree holds aindrive's own metadata
 * (agent JSON files including `llm.apiKey`, future per-agent state,
 * y.js binaries, the agent token & drive secret). If a cap-bearer
 * could read this they could exfiltrate API keys and forge requests.
 *
 * Enforcement points (every cap-bearer-initiated drive read MUST
 * go through one of these):
 *   - web/src/adapters/http/middleware/cap.ts (planned)
 *   - web/app/api/drives/[driveId]/fs/{read,list}/route.ts
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
  if (path === SYSTEM_PREFIX) return true;
  if (path.startsWith(SYSTEM_PREFIX + "/")) return true;
  return false;
}
