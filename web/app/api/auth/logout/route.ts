import { NextResponse } from "next/server";
import { clearCookie } from "@/lib/session";

export async function POST(req: Request) {
  await clearCookie();
  return NextResponse.redirect(new URL("/", req.url), 303);
}
