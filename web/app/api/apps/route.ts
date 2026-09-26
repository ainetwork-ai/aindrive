import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { checkSpacesUrl, listApps, upsertApp } from "@/lib/connected-apps";

/**
 * Connected apps on the signed-in account (lib/connected-apps.ts).
 *
 *   GET  → { apps: [{ id, name, origin }] }
 *   POST { name, url, key } → the app registers (or refreshes) itself; its
 *        spaces then show in the share sheet for every folder of the
 *        account's own drives.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ apps: listApps(user.id) });
}

export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { name?: unknown; url?: unknown; key?: unknown } | null;
  const url = await checkSpacesUrl(body?.url);
  if (typeof url === "string") return NextResponse.json({ error: url }, { status: 400 });
  if (typeof body?.key !== "string" || body.key.length < 16 || body.key.length > 512)
    return NextResponse.json({ error: "key required" }, { status: 400 });
  const app = upsertApp(user.id, { name: typeof body.name === "string" ? body.name : "", url, key: body.key });
  return NextResponse.json({ app });
}
