import { NextResponse } from "next/server";
import { DESKTOP_ARCHS, desktopDmgUrl, type DesktopArch } from "@/shared/desktop";

/**
 * GET /download/mac[?arch=arm64|x64] → the Mac app's .dmg (Apple silicon by
 * default). One stable link for the web UI and docs; the release it points at
 * is shared/desktop.ts.
 */
export function GET(req: Request) {
  const want = new URL(req.url).searchParams.get("arch");
  const arch: DesktopArch = (DESKTOP_ARCHS as readonly string[]).includes(want ?? "") ? (want as DesktopArch) : "arm64";
  return NextResponse.redirect(desktopDmgUrl(arch), 302);
}
