/** GET /api/sso/v1/health — AIN SSO provisioning adapter liveness (lib/sso/adapter.ts). */
import { handleAdapterHealth } from "@/lib/sso/adapter";

export const GET = (req: Request) => handleAdapterHealth(req);
export const HEAD = (req: Request) => handleAdapterHealth(req);
