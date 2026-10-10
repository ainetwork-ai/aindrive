import { SignJWT, jwtVerify } from "jose";
import { env } from "./env";

/**
 * Short-lived, path-scoped capability to download ONE file, used when the
 * session cookie can't ride along with the byte fetch.
 *
 * Why this exists: every file endpoint (fs/read|stream|thumbnail|download) is
 * gated by the httpOnly `aindrive_session` cookie. In-app mobile webviews
 * (e.g. the Base App) hand a `Content-Disposition: attachment` navigation to a
 * SEPARATE OS downloader that does NOT carry that cookie — so the drive gate
 * sees an anonymous request and 403s ("forbidden"), even for a logged-in user
 * who streams/views the same file fine via in-page subresource requests. The
 * viewer mints one of these tokens with a cookie-authenticated fetch (which
 * DOES pass the gate) and appends it to the download URL, so the cookieless
 * downloader is authorized.
 *
 * Signed with the same secret as the session JWT but with a distinct `typ`, so
 * a session token can never be used as a download token or vice versa. Scoped
 * to exactly {driveId, path} and expiring in TTL_SECONDS, it grants only what
 * the minter already had, briefly — the presigned-URL model.
 */
const enc = new TextEncoder();
function key() { return enc.encode(env.sessionSecret); }
const TTL_SECONDS = 120;

/**
 * A folder download (fs/download-folder) mints the same token for the FOLDER
 * path plus `job`: the id of the zip the agent already produced for this caller
 * (with this caller's paid locks left out). Such a token never opens
 * fs/download, and a file token never opens a prepared zip: `verifyDownloadToken`
 * checks the kind, and a file token (no `k`) is the default.
 */
export type DownloadTokenKind = "file" | "folder";

export async function signDownloadToken(driveId: string, normPath: string, opts: { kind?: DownloadTokenKind; job?: string } = {}): Promise<string> {
  const kind = opts.kind ?? "file";
  return new SignJWT({ typ: "dl", d: driveId, p: normPath, ...(kind === "folder" ? { k: kind, j: opts.job } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key());
}

export async function verifyDownloadToken(token: string, driveId: string, normPath: string, kind: DownloadTokenKind = "file"): Promise<boolean> {
  return (await readDownloadToken(token, driveId, normPath, kind)) !== null;
}

/** The verified claims, or null: `{ job }` for a folder token (the prepared zip's id), `{}` for a file token. */
export async function readDownloadToken(token: string, driveId: string, normPath: string, kind: DownloadTokenKind = "file"): Promise<{ job?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.typ !== "dl" || payload.d !== driveId || payload.p !== normPath) return null;
    const k = (payload.k as string | undefined) ?? "file";
    if (k !== kind) return null;
    if (kind === "folder") return typeof payload.j === "string" && /^[0-9a-f-]{36}$/.test(payload.j) ? { job: payload.j } : null;
    return {};
  } catch { return null; }
}
