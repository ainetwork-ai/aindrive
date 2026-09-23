/**
 * GET /.well-known/oauth-authorization-server — RFC 8414 metadata for the
 * remote-MCP OAuth server (lib/oauth.ts). See app/mcp/README.md.
 */
import { authServerMetadata } from "@/lib/oauth";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export function GET() {
  return Response.json(authServerMetadata(), { headers: CORS });
}
