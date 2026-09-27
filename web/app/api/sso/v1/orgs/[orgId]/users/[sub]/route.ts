/** PUT/GET /api/sso/v1/orgs/:orgId/users/:sub — AIN SSO provisioning adapter (lib/sso/adapter.ts). */
import { handleAdapterUser } from "@/lib/sso/adapter";

type Ctx = { params: Promise<{ orgId: string; sub: string }> };

async function handle(req: Request, { params }: Ctx) {
  const { orgId, sub } = await params;
  return handleAdapterUser(req, orgId, sub);
}

export const GET = handle;
export const PUT = handle;
