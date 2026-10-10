import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireDriveRole } from "@/lib/require-access";
import { AgentError, callAgent } from "@/lib/rpc";

/**
 * Git smart-HTTP for a repo stored inside a drive: `git clone` / `git push`.
 * Two URL shapes reach this code, both thin route delegates:
 *   https://<host>/api/drives/<driveId>/git/<repo-path>[.git]   (app/api/drives/[driveId]/git/[...path])
 *   https://<host>/<org-slug>/git/<repo-path>[.git]              (app/[slug]/git/[...path], lib/git-slug.ts)
 *
 * The real git runs on the drive's agent (it owns the filesystem); this module is
 * only the authenticated, scoped HTTP front for it — the same shape and reasoning
 * as ainize-node/src/agent-git-http.ts, adapted to aindrive's web↔agent RPC:
 *   - GET  …/info/refs?service=git-(upload|receive)-pack  -> agent `git-advertise`
 *   - POST …/git-upload-pack   (clone/fetch)              -> agent `git-service`
 *   - POST …/git-receive-pack  (push)                     -> agent `git-service`
 *
 * Auth is aindrive's own gate, NOT a second weaker door: upload-pack needs
 * `viewer`, receive-pack needs `editor` — the same requireDriveRole() the fs/*
 * routes use, resolved against the repo path. A push to a not-yet-existing repo
 * `git-init`s a repo there (write-gated), so a fresh path is pushable. The agent
 * creates it non-bare with receive.denyCurrentBranch=updateInstead, so the pushed
 * files land in the drive as ordinary files (`.git/` stays hidden from listings).
 * Credentials reach the gate as the `aindrive_session` cookie, `Authorization:
 * Bearer <session JWT>`, or — for a plain git client — HTTP Basic with the
 * session JWT as the password (`git clone https://x-access-token:<JWT>@host/…`),
 * which gitAuthRequest() translates to Bearer below.
 *
 * Large packs never cross as one JSON: the POST body is streamed to an agent temp
 * file via upload-chunk, git runs with that as stdin and a temp file as stdout,
 * and the result is streamed back via download-chunk, then both temps deleted.
 */
const UPLOAD_CHUNK = 4 * 1024 * 1024; // == agent LIMITS.maxUploadChunkBytes
const STREAM_CHUNK = 1024 * 1024;

type Service = "upload-pack" | "receive-pack";

function parse(path: string[]): { repo: string; kind: "info" | Service } | null {
  if (path.length >= 2 && path[path.length - 2] === "info" && path[path.length - 1] === "refs") {
    const repo = path.slice(0, -2).join("/");
    return repo ? { repo, kind: "info" } : null;
  }
  const last = path[path.length - 1];
  if (last === "git-upload-pack" || last === "git-receive-pack") {
    const repo = path.slice(0, -1).join("/");
    return repo ? { repo, kind: last.slice("git-".length) as Service } : null;
  }
  return null;
}

const minFor = (svc: Service): "editor" | "viewer" => (svc === "receive-pack" ? "editor" : "viewer");

function pktPrefix(svc: Service): Buffer {
  const line = `# service=git-${svc}\n`;
  const len = (line.length + 4).toString(16).padStart(4, "0");
  return Buffer.from(len + line + "0000");
}

// 401 so a git client re-tries with credentials (cap/bearer), 403/404 otherwise.
function deny(status: number, msg: string) {
  const h: Record<string, string> = {};
  if (status === 401) h["WWW-Authenticate"] = 'Basic realm="aindrive git"';
  return NextResponse.json({ error: msg }, { status, headers: h });
}

export async function gitHttpGET(driveId: string, path: string[], req: Request): Promise<Response> {
  const parsed = parse(path);
  if (!parsed || parsed.kind !== "info") return deny(404, "not found");
  const url = new URL(req.url);
  const svcParam = url.searchParams.get("service");
  if (svcParam !== "git-upload-pack" && svcParam !== "git-receive-pack") {
    return deny(400, "dumb http is not supported; use a smart git client");
  }
  const svc = svcParam.slice("git-".length) as Service;

  const gate = await requireDriveRole(driveId, parsed.repo, { min: minFor(svc), req: gitAuthRequest(req) });
  if (gate instanceof NextResponse) return gate.status === 403 && !gateUser(req) ? deny(401, "auth required") : gate;
  const { drive } = gate;

  try {
    let adv = await callAgent(driveId, drive.drive_secret, { method: "git-advertise", repo: parsed.repo, service: svc });
    if (!adv.exists) {
      if (svc !== "receive-pack") return deny(404, "repository not found");
      await callAgent(driveId, drive.drive_secret, { method: "git-init", repo: parsed.repo });
      adv = await callAgent(driveId, drive.drive_secret, { method: "git-advertise", repo: parsed.repo, service: svc });
    }
    const body = Buffer.concat([pktPrefix(svc), Buffer.from(adv.data, "base64")]);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": `application/x-git-${svc}-advertisement`,
        "cache-control": "no-cache, max-age=0, must-revalidate",
      },
    });
  } catch (e) {
    const err = e as AgentError;
    return deny(err.status ?? 500, err.message);
  }
}

export async function gitHttpPOST(driveId: string, path: string[], req: Request): Promise<Response> {
  const parsed = parse(path);
  if (!parsed || parsed.kind === "info") return deny(404, "not found");
  const svc = parsed.kind;

  const gate = await requireDriveRole(driveId, parsed.repo, { min: minFor(svc), req: gitAuthRequest(req) });
  if (gate instanceof NextResponse) return gate.status === 403 && !gateUser(req) ? deny(401, "auth required") : gate;
  const { drive } = gate;
  const secret = drive.drive_secret;

  const base = `.aindrive/uploads/git/${randomUUID()}`;
  const inPath = `${base}.in`;
  const outPath = `${base}.out`;

  try {
    // Ensure the repo exists on a push (first push targets a fresh path).
    if (svc === "receive-pack") {
      const adv = await callAgent(driveId, secret, { method: "git-advertise", repo: parsed.repo, service: svc });
      if (!adv.exists) await callAgent(driveId, secret, { method: "git-init", repo: parsed.repo });
    }

    // Stream the request body to an agent temp file, 4 MiB per upload-chunk.
    await uploadBody(req, driveId, secret, inPath);

    // Run git; stdout lands in the agent temp out file.
    const res = await callAgent(driveId, secret,
      { method: "git-service", repo: parsed.repo, service: svc, in: inPath, out: outPath },
      { timeoutMs: 300_000 });

    // Drop the request temp now; stream the result, delete it on completion.
    callAgent(driveId, secret, { method: "delete", path: inPath }).catch(() => {});
    const stream = resultStream(driveId, secret, outPath, res.size);
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": `application/x-git-${svc}-result`,
        "cache-control": "no-cache, max-age=0, must-revalidate",
      },
    });
  } catch (e) {
    callAgent(driveId, secret, { method: "delete", path: inPath }).catch(() => {});
    callAgent(driveId, secret, { method: "delete", path: outPath }).catch(() => {});
    const err = e as AgentError;
    return deny(err.status ?? 500, err.message);
  }
}

// Whether the request carried a user identity (cookie/bearer/basic). On a 403
// with no identity we upgrade to 401 so git prompts for credentials instead of
// failing outright.
function gateUser(req: Request): boolean {
  const c = req.headers.get("cookie") || "";
  return /(^|;\s*)(aindrive_session|session)=/.test(c) || !!req.headers.get("authorization");
}

// Git clients send credentials as HTTP Basic (`git clone https://x:<token>@host/…`,
// or a credential helper). The drive gate reads identity from the `aindrive_session`
// cookie or `Authorization: Bearer <session JWT>`, so translate Basic → Bearer using
// the password half (the session JWT; the username is ignored, use anything, e.g.
// `x-access-token`). A request already carrying a Bearer or the cookie is passed
// through untouched. The returned request has NO body — it is only ever handed to the
// gate, which reads headers; the original `req` keeps its body for the pack stream.
function gitAuthRequest(req: Request): Request {
  const auth = req.headers.get("authorization") || "";
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (!m) return req;
  let token = "";
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    token = colon >= 0 ? decoded.slice(colon + 1) : decoded;
  } catch {
    return req;
  }
  if (!token) return req;
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(req.url, { method: "GET", headers });
}

async function uploadBody(req: Request, driveId: string, secret: string, destPath: string): Promise<void> {
  const reader = req.body?.getReader();
  let chunkId = 0;
  let acc: Uint8Array[] = [];
  let accLen = 0;
  const flush = async () => {
    const buf = Buffer.concat(acc, accLen);
    await callAgent(driveId, secret, { method: "upload-chunk", path: destPath, chunkId, total: -1, data: buf.toString("base64") });
    chunkId += 1; acc = []; accLen = 0;
  };
  if (!reader) { await flush(); return; } // empty body: create the file (chunkId 0 = truncate)
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc.push(value); accLen += value.length;
    while (accLen >= UPLOAD_CHUNK) {
      // carve exactly UPLOAD_CHUNK out of the accumulator
      const joined = Buffer.concat(acc, accLen);
      const head = joined.subarray(0, UPLOAD_CHUNK);
      await callAgent(driveId, secret, { method: "upload-chunk", path: destPath, chunkId, total: -1, data: head.toString("base64") });
      chunkId += 1;
      const rest = joined.subarray(UPLOAD_CHUNK);
      acc = rest.length ? [rest] : []; accLen = rest.length;
    }
  }
  await flush(); // final partial (or the only, possibly-empty, chunk)
}

function resultStream(driveId: string, secret: string, srcPath: string, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  const cleanup = () => { callAgent(driveId, secret, { method: "delete", path: srcPath }).catch(() => {}); };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= size) { controller.close(); cleanup(); return; }
      try {
        const length = Math.min(STREAM_CHUNK, size - offset);
        const r = await callAgent(driveId, secret, { method: "download-chunk", path: srcPath, offset, length }, { timeoutMs: 120_000 });
        const buf = Buffer.from(r.data, "base64");
        if (buf.length === 0) { controller.close(); cleanup(); return; }
        offset += buf.length;
        controller.enqueue(new Uint8Array(buf));
        if (r.eof || offset >= size) { controller.close(); cleanup(); }
      } catch (e) { cleanup(); controller.error(e); }
    },
    cancel() { cleanup(); },
  });
}
