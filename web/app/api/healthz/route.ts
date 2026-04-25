import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const agentMap: Map<string, unknown> = (globalThis as any).__aindrive_agent_map ?? new Map();
    const agentsConnected = agentMap.size;
    db.prepare("SELECT 1").get();
    return NextResponse.json(
      { ok: true, uptime: process.uptime(), agentsConnected, dbOk: true },
      { headers }
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 503, headers });
  }
}
