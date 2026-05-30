/**
 * Client-side fetch helper for aindrive's JSON APIs.
 *
 * Collapses the pattern repeated ~15× across share-dialog / drive-shell /
 * folder-chat / create-agent-modal:
 *
 *   const res = await fetch(url, init);
 *   if (!res.ok) { toast.error((await res.json()).error || "fallback"); return; }
 *   const data = await res.json();
 *
 * into a discriminated result so each caller decides how to surface errors
 * (most toast; folder-chat formats a rate-limit retry message from `body`).
 * It deliberately does NOT own busy/loading state or call toast itself —
 * components keep their own state shells (per the audit's guard against
 * collapsing ShareDialog's cross-section state).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; body: unknown };

export async function apiFetch<T = unknown>(
  input: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    // Network/transport failure — no HTTP status.
    return { ok: false, status: 0, error: (e as Error).message || "network error", body: null };
  }
  // aindrive's JSON endpoints always return a JSON body; tolerate the rare
  // empty/non-JSON response without throwing.
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const errField =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
  return { ok: false, status: res.status, error: errField || `request failed (${res.status})`, body };
}
