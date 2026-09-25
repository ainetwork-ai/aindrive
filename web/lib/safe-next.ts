/**
 * Post-login redirect target from `?next=`: only same-origin paths. Rejects
 * protocol-relative (`//evil`) and backslash forms (`/\evil`, which browsers
 * resolve to `https://evil/`), so login/signup can't become an open redirect —
 * OAuth clients routinely send users through `/login?next=/oauth/authorize…`.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  try {
    const base = "https://aindrive.invalid";
    const u = new URL(next, base);
    return u.origin === base ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
}
