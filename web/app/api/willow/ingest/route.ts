// web/app/api/willow/ingest/route.ts
import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/session";
import { ingestEntries, INGEST_MAX } from "@/lib/willow/ainmem";

/** POST { drive, entries } → { results } — ainmem's signed transactions (and the
 *  signing devices' certificates) handed in by an editor of the drive, one verdict each. */
export async function POST(req: Request) {
  const user = await getRequestUser(req);
  if (!user || user === "invalid") return NextResponse.json({ error: "sign in" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { drive?: unknown; entries?: unknown } | null;
  if (!body || typeof body.drive !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.drive) || !Array.isArray(body.entries))
    return NextResponse.json({ error: "drive and entries[] required" }, { status: 400 });
  if (body.entries.length > INGEST_MAX) return NextResponse.json({ error: "too many entries" }, { status: 413 });
  return NextResponse.json({ results: await ingestEntries(body.drive, user.id, body.entries) });
}
