import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (process.uptime() < 2) {
      return NextResponse.json({ ok: false, error: "not ready" }, { status: 503, headers });
    }
    db.prepare("SELECT 1").get();
    return NextResponse.json({ ok: true }, { headers });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 503, headers });
  }
}
