/**
 * /agui/d/[driveId] — AG-UI endpoint pinned to one drive (drive tokens and
 * account tokens with access to it). See lib/agui.ts, /docs/ag-ui.
 */
import { AGUI_CORS, aguiInfo, serveAgui } from "@/lib/agui";

// Never prerender: the module pulls in the DB-backed skill layer.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ driveId: string }> };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: AGUI_CORS });
}

export async function GET(_req: Request, { params }: Ctx) {
  return aguiInfo((await params).driveId);
}

export async function POST(req: Request, { params }: Ctx) {
  return serveAgui(req, (await params).driveId);
}
