import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-upsess-"));

// Cookie jar so getUser()/getWallet() work outside a request context
// (same pattern as paid-settle.test.ts).
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

// Fake agent: an in-memory filesystem implementing exactly the RPC semantics
// the upload pipeline relies on — chunkId 0 truncates / others append, stat
// reports size, rename moves, delete removes. `failNextChunks` applies the
// chunk and THEN throws (= the part died after bytes landed: the exact
// partial-append case the stat-reconcile recovery exists for).
const fake = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  failNextChunks: 0,
  failRenames: 0,          // throw BEFORE applying (rename never happened)
  renamesLoseResponse: 0,  // APPLY the rename, then throw (response lost on the wire)
}));
vi.mock("@/lib/rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  async function callAgent(_driveId: string, _secret: string, params: Record<string, unknown> & { method: string }) {
    const f = fake.files;
    switch (params.method) {
      case "upload-chunk": {
        const buf = Buffer.from(params.data as string, "base64");
        // Mirrors cli/src/rpc.js maxUploadChunkBytes — a pump bug that sends
        // oversize chunks must fail here like it would against a real agent.
        if (buf.length > 4 * 1024 * 1024) throw new AgentError("chunk too large");
        const path = params.path as string;
        const prev = params.chunkId === 0 ? Buffer.alloc(0) : (f.get(path) ?? Buffer.alloc(0));
        f.set(path, Buffer.concat([prev, buf]));
        if (fake.failNextChunks > 0) { fake.failNextChunks -= 1; throw new AgentError("agent timeout", 504); }
        return { method: "upload-chunk", ok: true, receivedBytes: buf.length };
      }
      case "stat": {
        const b = f.get(params.path as string);
        return {
          method: "stat",
          entry: b === undefined ? null : { name: "", path: params.path, isDir: false, size: b.length, mtimeMs: 0, ext: "", mime: "" },
        };
      }
      case "rename": {
        if (fake.failRenames > 0) { fake.failRenames -= 1; throw new AgentError("rename failed", 504); }
        const b = f.get(params.from as string);
        if (!b) throw new AgentError("missing source");
        f.delete(params.from as string);
        f.set(params.to as string, b);
        if (fake.renamesLoseResponse > 0) { fake.renamesLoseResponse -= 1; throw new AgentError("agent timeout", 504); }
        return { method: "rename", ok: true };
      }
      case "delete": { f.delete(params.path as string); return { method: "delete", ok: true }; }
      default: throw new AgentError(`unexpected rpc ${params.method}`);
    }
  }
  return { AgentError, callAgent, isOnline: () => true };
});

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { getUploadSession, lockSession, unlockSession } = await import("../upload-sessions");
const { getOwnerUsage } = await import("../storage-usage.js");
const { POST: createSession } = await import("../../app/api/drives/[driveId]/fs/upload-sessions/route.js");
const { GET: getState, PATCH: patchPart, DELETE: abortSession } =
  await import("../../app/api/drives/[driveId]/fs/upload-sessions/[uploadId]/route.js");

const createCtx = { params: Promise.resolve({ driveId: "d1" }) };
const ctx = (uploadId: string) => ({ params: Promise.resolve({ driveId: "d1", uploadId }) });

async function open(path: string, size: number) {
  return createSession(new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, size }),
  }), createCtx);
}

function part(uploadId: string, offset: number, body: Buffer) {
  return patchPart(new Request("http://x/api", {
    method: "PATCH",
    headers: { "x-upload-offset": String(offset), "content-type": "application/octet-stream" },
    body: new Uint8Array(body),
  }), ctx(uploadId));
}

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("owner1", "o@example.com", "Owner", "x");
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("editor1", "e@example.com", "Editor", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "d1", "editor1", "", "editor");
  cookieJar.set("aindrive_session", await sign("owner1"));
});

describe("chunked upload sessions", () => {
  it("uploads in sequential parts and publishes atomically on the last", async () => {
    const res = await open("docs/a.bin", 10);
    expect(res.status).toBe(200);
    const { uploadId } = await res.json();

    let r = await part(uploadId, 0, Buffer.from("0123"));
    expect(await r.json()).toMatchObject({ complete: false, receivedBytes: 4 });
    r = await part(uploadId, 4, Buffer.from("4567"));
    expect(await r.json()).toMatchObject({ complete: false, receivedBytes: 8 });
    r = await part(uploadId, 8, Buffer.from("89"));
    expect(await r.json()).toMatchObject({ complete: true, receivedBytes: 10, path: "docs/a.bin" });

    expect(fake.files.get("docs/a.bin")?.toString()).toBe("0123456789");
    // temp renamed away, session row gone
    expect([...fake.files.keys()].filter((k) => k.startsWith(".aindrive/"))).toEqual([]);
    expect((await getState(new Request("http://x"), ctx(uploadId))).status).toBe(404);
  });

  it("re-chunks an 8 MiB part to the agent's 4 MiB RPC limit", async () => {
    const size = 8 * 1024 * 1024;
    const res = await open("docs/big.bin", size);
    const { uploadId, partSize } = await res.json();
    expect(partSize).toBe(size); // one full part
    const r = await part(uploadId, 0, Buffer.alloc(size, 7)); // fake throws if a chunk > 4 MiB
    expect(await r.json()).toMatchObject({ complete: true, receivedBytes: size });
    expect(fake.files.get("docs/big.bin")?.length).toBe(size);
  });

  it("rejects a stale offset with 409 + the authoritative value", async () => {
    const { uploadId } = await (await open("docs/b.bin", 8)).json();
    await part(uploadId, 0, Buffer.from("aaaa"));
    const dup = await part(uploadId, 0, Buffer.from("aaaa")); // replayed first part
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ receivedBytes: 4 });
  });

  it("recovers from a part that died mid-append", async () => {
    const { uploadId } = await (await open("docs/c.bin", 8)).json();
    fake.failNextChunks = 1; // chunk lands on the agent, then the RPC "times out"
    const dead = await part(uploadId, 0, Buffer.from("aaaa"));
    expect(dead.status).toBe(504);

    // Client retries with its old offset → 409 carrying the agent truth (4).
    const retry = await part(uploadId, 0, Buffer.from("aaaa"));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ receivedBytes: 4 });

    // Client re-slices from 4 and completes.
    const done = await part(uploadId, 4, Buffer.from("bbbb"));
    expect(await done.json()).toMatchObject({ complete: true });
    expect(fake.files.get("docs/c.bin")?.toString()).toBe("aaaabbbb");
  });

  it("purges the session (410) when the temp vanished mid-upload", async () => {
    const { uploadId } = await (await open("docs/d.bin", 8)).json();
    await part(uploadId, 0, Buffer.from("aaaa"));
    const temp = getUploadSession(uploadId)!.temp_path;
    fake.files.delete(temp); // agent lost the temp (wipe, disk swap, stat hiccup)
    const st = await getState(new Request("http://x"), ctx(uploadId));
    expect(st.status).toBe(410); // never "resume from 0" — that would truncate blind
    expect(getUploadSession(uploadId)).toBeNull();
  });

  it("detects an already-published file when the rename response was lost", async () => {
    const before = getOwnerUsage("owner1").files;
    const { uploadId } = await (await open("docs/lost-ack.bin", 4)).json();
    fake.renamesLoseResponse = 1; // rename APPLIES on the agent, then the RPC "times out"
    const dead = await part(uploadId, 0, Buffer.from("pppp"));
    expect(dead.status).toBe(504);
    expect(fake.files.get("docs/lost-ack.bin")?.toString()).toBe("pppp"); // already published

    // Client's zero-byte finalize: server sees temp gone + target at declared
    // size → completes the session instead of restarting from 0.
    const retry = await part(uploadId, 4, Buffer.alloc(0));
    expect(await retry.json()).toMatchObject({ complete: true, path: "docs/lost-ack.bin" });
    expect(getUploadSession(uploadId)).toBeNull();
    // bookkeeping ran exactly once (the dead request never reached its bump)
    expect(getOwnerUsage("owner1").files).toBe(before + 1);
  });

  it("rejects DELETE while a part is in flight", async () => {
    const { uploadId } = await (await open("docs/locked.bin", 8)).json();
    await part(uploadId, 0, Buffer.from("aaaa"));
    expect(lockSession(uploadId)).toBe(true); // simulate an in-flight PATCH
    try {
      const r = await abortSession(new Request("http://x", { method: "DELETE" }), ctx(uploadId));
      expect(r.status).toBe(409);
      expect(getUploadSession(uploadId)).not.toBeNull(); // nothing was deleted
    } finally {
      unlockSession(uploadId);
    }
    const ok = await abortSession(new Request("http://x", { method: "DELETE" }), ctx(uploadId));
    expect(ok.status).toBe(200);
  });

  it("retries just the rename via a zero-byte part when the final rename failed", async () => {
    const { uploadId } = await (await open("docs/e.bin", 4)).json();
    fake.failRenames = 1;
    const failed = await part(uploadId, 0, Buffer.from("eeee"));
    expect(failed.status).toBe(504); // bytes all in, publish failed

    const finalize = await part(uploadId, 4, Buffer.alloc(0));
    expect(await finalize.json()).toMatchObject({ complete: true });
    expect(fake.files.get("docs/e.bin")?.toString()).toBe("eeee");
  });

  it("rejects a part that overflows the declared size", async () => {
    const { uploadId } = await (await open("docs/f.bin", 4)).json();
    const r = await part(uploadId, 0, Buffer.from("toolong"));
    expect(r.status).toBe(400);
  });

  it("rejects a session larger than the upload cap", async () => {
    const res = await open("docs/huge.bin", 3 * 1024 * 1024 * 1024);
    expect(res.status).toBe(413);
  });

  it("only the session creator may touch it", async () => {
    const { uploadId } = await (await open("docs/g.bin", 4)).json();
    cookieJar.set("aindrive_session", await sign("editor1")); // editor, but not the creator
    const r = await part(uploadId, 0, Buffer.from("xxxx"));
    expect(r.status).toBe(403);
    cookieJar.set("aindrive_session", await sign("owner1"));
  });

  it("abort deletes the temp and the session", async () => {
    const { uploadId } = await (await open("docs/h.bin", 8)).json();
    await part(uploadId, 0, Buffer.from("aaaa"));
    const temp = getUploadSession(uploadId)!.temp_path;
    expect(fake.files.has(temp)).toBe(true);
    await abortSession(new Request("http://x", { method: "DELETE" }), ctx(uploadId));
    expect(fake.files.has(temp)).toBe(false);
    expect((await getState(new Request("http://x"), ctx(uploadId))).status).toBe(404);
  });
});
