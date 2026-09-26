// web/app/api/willow/cert/route.ts
import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { attestationKey, certify } from "@/lib/willow/attestation";
import { toHex } from "@/shared/willow/bytes";

/** POST { deviceKey, label } → an attested certificate binding this browser's device key to the signed-in user. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { deviceKey?: unknown; label?: unknown };
  if (typeof body.deviceKey !== "string" || !/^[0-9a-f]{64}$/.test(body.deviceKey)) return NextResponse.json({ error: "deviceKey" }, { status: 400 });
  const cert = await certify(user.id, body.deviceKey, typeof body.label === "string" ? body.label : "browser");
  return NextResponse.json({ cert, attestationKey: toHex(attestationKey().publicKey) });
}
