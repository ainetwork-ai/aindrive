import { NextResponse } from "next/server";
import { writeTrace, isTraceEnabled, ringStats } from "@/lib/trace";

export async function POST(req: Request) {
  if (!isTraceEnabled()) return NextResponse.json({ ok: true, disabled: true });
  let body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  writeTrace(body);
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ enabled: isTraceEnabled(), ring: ringStats() });
}
