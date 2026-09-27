/**
 * POST /api/auth/sso/backchannel-logout — OIDC Back-Channel Logout 1.0, the
 * `backchannel_logout_uri` registered at AIN SSO. Form field `logout_token`.
 * See lib/sso/backchannel.ts. 404 unless AINDRIVE_SSO_ISSUER + CLIENT_ID are set.
 */
import { handleBackchannelLogout } from "@/lib/sso/backchannel";

export const POST = (req: Request) => handleBackchannelLogout(req);
