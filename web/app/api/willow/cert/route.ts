// web/app/api/willow/cert/route.ts
import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/session";
import { agentUser } from "@/lib/willow/agent-auth";
import { isRevoked } from "@/lib/willow/revocations";
import { attestationKey, certify } from "@/lib/willow/attestation";
import { toHex } from "@/shared/willow/bytes";

/** POST { deviceKey, label } → an attested certificate binding this browser's device key to the signed-in user
 *  (cookie, or `Authorization: Bearer <session JWT>`; with `drive`, the bearer is that drive's agent token). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { deviceKey?: unknown; label?: unknown; drive?: unknown };
  // a signed-in browser, or a drive's own agent (its agent token) acting for the owner
  // or a server-side host (ainmem) with the person's session JWT as a bearer
  const viaDrive = typeof body.drive === "string";
  const session = viaDrive ? null : await getRequestUser(req);
  const userId = session && session !== "invalid" ? session.id : viaDrive ? await agentUser(body.drive as string, req.headers.get("authorization") ?? undefined) : null;
  if (!userId) return NextResponse.json({ error: "sign in" }, { status: 401 });
  if (typeof body.deviceKey !== "string" || !/^[0-9a-f]{64}$/.test(body.deviceKey)) return NextResponse.json({ error: "deviceKey" }, { status: 400 });
  if (isRevoked(userId, body.deviceKey)) return NextResponse.json({ error: "this device was removed" }, { status: 403 });
  const cert = await certify(userId, body.deviceKey, typeof body.label === "string" ? body.label : "browser");
  return NextResponse.json({ cert, attestationKey: toHex(attestationKey().publicKey) });
}

/** GET → aindrive's attestation public key, which clients trust for "vouched by aindrive". */
export async function GET() {
  return NextResponse.json({ attestationKey: toHex(attestationKey().publicKey) });
}
