/**
 * GET /api/auth/sso → { enabled: true, legacyLogin } when "Continue with AIN"
 * is on; 404 otherwise, so the login page renders exactly as before.
 */
import { NextResponse } from "next/server";
import { legacyLoginMode, ssoLoginEnabled } from "@/lib/sso/config";

export function GET() {
  if (!ssoLoginEnabled()) return NextResponse.json({ error: "sso_not_configured" }, { status: 404 });
  return NextResponse.json({ enabled: true, legacyLogin: legacyLoginMode() }, { headers: { "Cache-Control": "no-store" } });
}
