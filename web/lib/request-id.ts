/**
 * Request ids and the route log line for the cross-product surfaces
 * (ain-integration plan task 12.5): the shared-file lists (/api/me/shared,
 * /api/oauth/shared) and the delegated reads (fs/read, fs/list with an
 * `ain-rdlg+jwt`). With AIN_INTEGRATION_ENABLED:
 *
 *   - every response carries `X-Request-Id`: the caller's own id when it sent
 *     a well-formed one (so a consumer can follow one call across products),
 *     else a fresh `req_…`;
 *   - one structured log line per call: request id, route, outcome (status,
 *     contract code, detail), the account (aindrive user id), the resource as
 *     its contract id (fileId — never the path or name), the drive, and the
 *     delegation's jti as the task/grant id.
 *
 * A log line never holds a credential: fields are an allow-list (no headers,
 * no query string, no bodies), and every string passes `scrubSecrets`, which
 * blanks bearer values, JWT/JWS-shaped strings, aindrive tokens (`aind_…`),
 * cookies and `token=`-style parameters, in case an error message echoes one.
 */
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";
import { ainIntegrationEnabled } from "./ain-integration.js";

export const REQUEST_ID_HEADER = "X-Request-Id";
const INBOUND_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** The caller's X-Request-Id when well-formed (and not token-shaped), else a new one. */
export function requestIdOf(req: Request): string {
  const inbound = req.headers.get(REQUEST_ID_HEADER)?.trim();
  if (inbound && INBOUND_RE.test(inbound) && scrubSecrets(inbound) === inbound) return inbound;
  return `req_${randomBytes(12).toString("hex")}`;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]"],
  // JWT / JWS / JWE compact forms: base64url segments joined by dots (header starts eyJ).
  [/\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){1,4}/g, "[redacted-jwt]"],
  [/\baind_[A-Za-z0-9_]+/g, "[redacted-token]"],
  [/\b((?:access_|refresh_|id_)?token|dt|code|secret|password|api[_-]?key|signature|sig|cookie|authorization|x-ain-pop)=([^\s&;,"']+)/gi, "$1=[redacted]"],
  [/\baindrive_session=[^\s;,"']+/gi, "aindrive_session=[redacted]"],
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export type RouteLogFields = {
  requestId: string;
  route: string;
  status: number;
  code?: string;
  detail?: string;
  userId?: string | null;
  driveId?: string;
  /** Contract resource id (fileId / resource key) — never a path or a name. */
  resourceId?: string;
  /** The delegation's jti, or another task/grant id. */
  taskId?: string;
  auth?: "session" | "account_token" | "delegation" | "anonymous";
  error?: unknown;
};

type Sink = (line: Record<string, unknown>) => void;
const defaultSink: Sink = (line) => {
  const status = Number(line.status);
  if (status >= 500) log.error(line, "[ain] route");
  else log.info(line, "[ain] route");
};
let sink: Sink = defaultSink;

/** Tests: capture log lines (null restores the pino sink). */
export function setRouteLogSink(fn: Sink | null): void {
  sink = fn ?? defaultSink;
}

const ALLOWED: (keyof RouteLogFields)[] = ["requestId", "route", "status", "code", "detail", "userId", "driveId", "resourceId", "taskId", "auth"];

/** One log line for a call on a cross-product route. No-op with the flag off. */
export function logRoute(fields: RouteLogFields): void {
  if (!ainIntegrationEnabled()) return;
  const line: Record<string, unknown> = {};
  for (const k of ALLOWED) {
    const v = fields[k];
    if (v === undefined || v === null) continue;
    line[k] = typeof v === "string" ? scrubSecrets(v).slice(0, 256) : v;
  }
  if (fields.error !== undefined) {
    const e = fields.error as { message?: unknown; name?: unknown };
    const msg = typeof e?.message === "string" ? e.message : String(fields.error);
    line.err = scrubSecrets(msg).slice(0, 512);
  }
  try { sink(line); } catch { /* logging never breaks a response */ }
}

/** Stamp the id on a response (flag on). Returns the same response. */
export function withRequestId<R extends Response>(res: R, requestId: string): R {
  if (ainIntegrationEnabled()) {
    try { res.headers.set(REQUEST_ID_HEADER, requestId); } catch { /* immutable headers: leave as is */ }
  }
  return res;
}

/** The contract code/detail of an error response, for the log line (best-effort, never throws). */
export async function contractErrorOf(res: Response): Promise<{ code?: string; detail?: string }> {
  if (res.status < 400) return {};
  try {
    const body = await res.clone().json() as { error?: { code?: unknown; detail?: unknown } | string };
    if (body && typeof body.error === "object" && body.error) {
      return {
        ...(typeof body.error.code === "string" ? { code: body.error.code } : {}),
        ...(typeof body.error.detail === "string" ? { detail: body.error.detail } : {}),
      };
    }
  } catch { /* not JSON */ }
  return {};
}
