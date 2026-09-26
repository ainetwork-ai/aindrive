/**
 * GET /api/h/:id?k=<secret> — a file handoff link (lib/handoff.ts): what an outside agent fetches.
 * No session: the secret is the capability. Checked (secret, expiry, revocation), every attempt
 * logged, bytes streamed from the owner's device via `handoff-read` RPCs on the carrier drive.
 */
import { NextResponse } from "next/server";
import { getDrive } from "@/lib/drives";
import { callAgent, AgentError } from "@/lib/rpc";
import { DOWNLOAD_CHUNK_BYTES } from "@/lib/agent-stream";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { openHandoff, logFetch } from "@/lib/handoff";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rl = tryConsume({ name: "handoff-fetch", key: clientKey(req, "handoff-fetch"), limit: 120, windowMs: 60_000 });
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip");
  const ua = req.headers.get("user-agent");
  const opened = openHandoff(id, new URL(req.url).searchParams.get("k") ?? "");
  if ("error" in opened) {
    const status = opened.error === "not_found" ? 404 : 410;
    if (opened.error !== "not_found") logFetch(id, ip, ua, status);
    return NextResponse.json({ error: opened.error }, { status });
  }
  const h = opened.row;
  const drive = getDrive(h.drive_id);
  if (!drive) { logFetch(id, ip, ua, 404); return NextResponse.json({ error: "not_found" }, { status: 404 }); }

  // First chunk before answering: if the device is offline or the file is gone, say so with a status.
  let first: { data: string; eof: boolean; size: number };
  try {
    first = await callAgent(h.drive_id, drive.drive_secret, { method: "handoff-read", key: h.device_key, offset: 0, length: DOWNLOAD_CHUNK_BYTES });
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 503;
    logFetch(id, ip, ua, status);
    return NextResponse.json({ error: status === 503 || status === 504 ? "device_offline" : (e as Error).message }, { status });
  }
  logFetch(id, ip, ua, 200);
  const size = first.size;
  let offset = 0, sentFirst = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let r = first;
        if (sentFirst) {
          if (offset >= size) { controller.close(); return; }
          r = await callAgent(h.drive_id, drive.drive_secret, { method: "handoff-read", key: h.device_key, offset, length: Math.min(DOWNLOAD_CHUNK_BYTES, size - offset) });
        }
        sentFirst = true;
        const buf = Buffer.from(r.data, "base64");
        if (!buf.length) { controller.close(); return; }
        offset += buf.length;
        controller.enqueue(new Uint8Array(buf));
        if (r.eof || offset >= size) controller.close();
      } catch (e) { controller.error(e); }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": h.mime,
      "content-length": String(size),
      "content-disposition": `inline; filename="${encodeURIComponent(h.name)}"; filename*=UTF-8''${encodeURIComponent(h.name)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
