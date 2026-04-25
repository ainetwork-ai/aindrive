/**
 * POST /api/drives/[driveId]/agents/[agentId]/ask
 *
 * Identity → policy → forward to CLI for execution. The web side never
 * sees the agent's API key or the file contents passed to the LLM —
 * runAgentAsk on the CLI does all that.
 *
 * Output kinds map 1:1 to HTTP status:
 *   ok               → 200 + { answer, sources, policyName }
 *   denied           → 401 + { error }
 *   payment-required → 402 + { paymentRequirements }
 *   rate-limited     → 429 + { error, retryAfterMs }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { compose } from "@/src/composition";
import { askAgent } from "@/src/use-cases/agent/ask-agent";

const Body = z.object({
  q: z.string().min(1).max(2000),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ driveId: string; agentId: string }> },
) {
  const { driveId, agentId } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }

  // Convert NextRequest to the IdentityResolveInput shape (ReadonlyMap).
  const headers = new Map<string, string>();
  req.headers.forEach((v, k) => headers.set(k.toLowerCase(), v));
  const cookies = new Map<string, string>();
  for (const c of req.cookies.getAll()) cookies.set(c.name, c.value);

  const out = await askAgent(compose.askAgent, {
    driveId,
    agentId,
    askRequest: { q: parsed.data.q },
    http: { headers, cookies },
  });

  switch (out.kind) {
    case "ok":
      return NextResponse.json({
        answer: out.result.answer,
        sources: out.result.sources,
        policyName: out.policyName,
      });
    case "denied":
      return NextResponse.json({ error: out.reason }, { status: 401 });
    case "payment-required":
      return NextResponse.json(
        { paymentRequirements: out.requirement },
        { status: 402 },
      );
    case "rate-limited":
      return NextResponse.json(
        { error: "rate_limited", retryAfterMs: out.retryAfterMs },
        { status: 429, headers: { "Retry-After": String(Math.ceil(out.retryAfterMs / 1000)) } },
      );
  }
}
