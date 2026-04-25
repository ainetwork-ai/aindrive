import { clearCookie } from "@/lib/session";

export async function POST() {
  await clearCookie();
  // Use a relative Location so the browser resolves against the public URL
  // it requested (e.g. https://aindrive.ainetwork.ai/) instead of the
  // container's bind address (which leaks via NextResponse.redirect's
  // absolute URL construction when behind a reverse proxy).
  return new Response(null, {
    status: 303,
    headers: { Location: "/" },
  });
}
