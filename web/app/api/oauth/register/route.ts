/**
 * POST /api/oauth/register — RFC 7591 dynamic client registration for MCP
 * clients. Public clients only (token_endpoint_auth_method "none" + PKCE).
 * Rate-limited per IP. See app/mcp/README.md.
 */
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { isAllowedRedirectUri, registerClient } from "@/lib/oauth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function fail(error: string, description: string, status = 400) {
  return Response.json({ error, error_description: description }, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const rl = tryConsume({ name: "oauth-register", key: clientKey(req, "oauth-register"), limit: 20, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return fail("slow_down", "too many registrations", 429);
  // Global ceiling too: the per-IP key trusts X-Forwarded-For, which a client
  // can vary, so this bounds table growth regardless.
  const global = tryConsume({ name: "oauth-register-global", key: "all", limit: 500, windowMs: 60 * 60 * 1000 });
  if (!global.ok) return fail("slow_down", "registration temporarily unavailable", 429);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return fail("invalid_client_metadata", "JSON body required");

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2048)) {
    return fail("invalid_redirect_uri", "redirect_uris must be 1–10 URIs");
  }
  const bad = (uris as string[]).find((u) => !isAllowedRedirectUri(u));
  if (bad) return fail("invalid_redirect_uri", `redirect_uri not allowed: ${bad}`);

  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none") return fail("invalid_client_metadata", "only public clients (token_endpoint_auth_method=none) are supported");
  const grants = (body.grant_types as unknown[] | undefined) ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return fail("invalid_client_metadata", "unsupported grant_types");
  }

  const rawName = typeof body.client_name === "string" ? body.client_name.trim() : "";
  const name = (rawName || "MCP client").slice(0, 80);
  const client = registerClient(name, uris as string[]);
  return Response.json(
    {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: grants,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: CORS },
  );
}
