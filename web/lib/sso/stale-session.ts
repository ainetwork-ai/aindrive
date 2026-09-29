/**
 * A dead session cookie must not switch the silent check off. The middleware
 * (Edge, no database) skips the check whenever the browser sends
 * `aindrive_session`, but that cookie outlives its session: a back-channel
 * logout, a suspension or an epoch bump ends it server-side and the browser
 * keeps it for up to 30 days. A page that finds no signed-in user although the
 * cookie is there asks here and repeats the middleware's decision as if there
 * were no cookie (same rules: navigations only, no bots, prefetches, RSC, the
 * loop guard). The start route then drops the dead cookie and sets the guard.
 */
import { cookies, headers } from "next/headers";
import { SESSION_COOKIE, silentSsoStartPath } from "./silent";

/** Where to send a page view whose session cookie is dead, or null (render as anonymous). */
export async function staleSessionCheck(pathname: string, search = ""): Promise<string | null> {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) return null; // no cookie: the middleware already decided
  return silentSsoStartPath({
    method: "GET",
    pathname,
    search,
    headers: await headers(),
    cookies: { has: (name) => name !== SESSION_COOKIE && !!jar.get(name) },
  });
}
