import { NextResponse } from "next/server";
import { queryRing, isTraceEnabled } from "@/lib/trace";

export async function GET(req: Request) {
  if (!isTraceEnabled()) return NextResponse.json({ events: [], disabled: true });
  const url = new URL(req.url);
  const docId = url.searchParams.get("docId") || undefined;
  const since = url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined;
  const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 500;
  const events = queryRing({ docId, since, limit });
  return NextResponse.json({ count: events.length, events });
}
