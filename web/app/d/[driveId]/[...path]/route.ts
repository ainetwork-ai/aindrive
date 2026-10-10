// `/d/<driveId>/<path>` — the FileRef.sourceUrl form ("open original") that
// shared-items and the products mint. The drive page lives at /d/<driveId> and
// takes the path as ?path=, so this only redirects there; the page runs the
// permission checks (session, role, reserved subtree, paywall). Not behind
// AIN_INTEGRATION_ENABLED: links already stored in messages, pages and
// bundles must keep opening whatever the flag says. See lib/source-url.ts.
import { sourcePathRedirect } from "@/lib/source-url";

export const dynamic = "force-dynamic";

function handle(req: Request): Response {
  // The raw, still percent-encoded segments, decoded exactly once by
  // sourcePathRedirect (route params may already be decoded, or not).
  const segs = new URL(req.url).pathname.split("/");
  // ["", "d", <driveId>, ...path]
  let driveId: string;
  try { driveId = decodeURIComponent(segs[2] ?? ""); }
  catch { return new Response("invalid drive id\n", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
  const r = sourcePathRedirect(driveId, segs.slice(3).filter((s) => s !== ""));
  if (!r.ok) return new Response(`${r.reason}\n`, { status: r.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  // Relative Location: behind the TLS proxy req.url carries the bind address.
  return new Response(null, { status: 307, headers: { Location: r.location, "Cache-Control": "no-store" } });
}

export const GET = handle;
export const HEAD = handle;
