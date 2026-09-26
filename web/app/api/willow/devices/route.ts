import { NextResponse } from "next/server";
import { getUser } from "@/lib/session";
import { listDevices } from "@/lib/willow/devices";

/** GET → the devices that write in my name (certificates in my drives' stores). */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "sign in" }, { status: 401 });
  return NextResponse.json({ devices: await listDevices(user.id) });
}
