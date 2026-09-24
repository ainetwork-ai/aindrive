/**
 * /agui — AG-UI endpoint (account-wide). POST RunAgentInput → AG-UI event
 * stream; GET → contract description. Any drive the token can reach; pass
 * `state.driveId` (or a skill's `drive_id`) to pick one. See lib/agui.ts, /docs/ag-ui.
 */
import { AGUI_CORS, aguiInfo, serveAgui } from "@/lib/agui";

// Never prerender: the module pulls in the DB-backed skill layer.
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: AGUI_CORS });
}

export function GET() {
  return aguiInfo();
}

export function POST(req: Request) {
  return serveAgui(req);
}
