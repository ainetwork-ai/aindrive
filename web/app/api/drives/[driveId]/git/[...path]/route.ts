import { gitHttpGET, gitHttpPOST } from "@/lib/git-http";

/**
 * Git smart-HTTP for a repo stored inside a drive, addressed by drive id:
 *   https://<host>/api/drives/<driveId>/git/<repo-path>[.git]
 * The logic lives in lib/git-http.ts (shared with the friendly
 * /<org-slug>/git/<repo-path> route); this file only unwraps the params.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string; path: string[] }> }) {
  const { driveId, path } = await params;
  return gitHttpGET(driveId, path, req);
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string; path: string[] }> }) {
  const { driveId, path } = await params;
  return gitHttpPOST(driveId, path, req);
}
