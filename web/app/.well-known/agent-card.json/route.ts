/**
 * GET /.well-known/agent-card.json
 *
 * Root-level A2A v0.3 AgentCard for aindrive. Card identifies aindrive
 * as a single agent; skills take drive_id to address individual drives.
 *
 * Public — no auth required to fetch the card itself. The /a2a endpoint
 * enforces auth on every call.
 */

import { NextResponse } from "next/server";
import { aindriveAgentCard } from "@/lib/aindrive-agent";

export async function GET() {
  return NextResponse.json(aindriveAgentCard(), {
    headers: {
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
