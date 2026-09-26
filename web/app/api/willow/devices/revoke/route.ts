import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { revokeDevice } from "@/lib/willow/devices";

/** POST { deviceKey } → revoke one of my devices in every drive it is known in. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const { deviceKey } = (await req.json().catch(() => ({}))) as { deviceKey?: unknown };
  if (typeof deviceKey !== "string" || !/^[0-9a-f]{64}$/.test(deviceKey)) return NextResponse.json({ error: "deviceKey" }, { status: 400 });
  try { return NextResponse.json(await revokeDevice(user.id, deviceKey)); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: /not your device/.test((e as Error).message) ? 403 : 500 }); }
}
