/**
 * GET /api/oauth/drives — the drives an account-grant token's user can reach
 * (`aind_aat_…` with the `drives:read` scope): { drives: [{ id, name, online,
 * role }] }, role = the user's highest role anywhere in the drive. Read the
 * files through `/mcp/d/<id>` with the same token. See app/mcp/README.md.
 */
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { ACCOUNT_API_HEADERS, authenticateAccountRequest } from "@/lib/account-tokens";
import { listUserDrives } from "@/lib/drives";
import { maxRoleInDrive } from "@/lib/mcp-tokens";
import { isOnline } from "@/lib/rpc";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: ACCOUNT_API_HEADERS });
}

export function GET(req: Request) {
  const rl = tryConsume({ name: "oauth-drives", key: clientKey(req, "oauth-drives"), limit: 120, windowMs: 60 * 1000 });
  if (!rl.ok) {
    return Response.json({ error: "slow_down", error_description: "too many requests" }, { status: 429, headers: ACCOUNT_API_HEADERS });
  }
  const auth = authenticateAccountRequest(req, "drives:read");
  if (!auth.ok) return auth.response;
  const { userId } = auth.token;
  const drives = listUserDrives(userId).map((d) => ({
    id: d.id,
    name: d.name,
    online: isOnline(d.id),
    role: maxRoleInDrive(d.id, userId),
  }));
  return Response.json({ drives }, { headers: ACCOUNT_API_HEADERS });
}
