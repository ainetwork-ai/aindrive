import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-mcp-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

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

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const tokens = await import("../mcp-tokens");
const oauth = await import("../oauth");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");
const tokensRoute = await import("../../app/api/drives/[driveId]/mcp-tokens/route.js");
const tokenIdRoute = await import("../../app/api/drives/[driveId]/mcp-tokens/[tokenId]/route.js");
const registerRoute = await import("../../app/api/oauth/register/route.js");
const authorizeRoute = await import("../../app/api/oauth/authorize/route.js");
const tokenRoute = await import("../../app/api/oauth/token/route.js");
const prmRoute = await import("../../app/.well-known/oauth-protected-resource/mcp/d/[driveId]/route.js");

const driveCtx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
const MCP_URL = "http://drive.test/mcp/d/d1";

function rpc(driveId: string, token: string | null, body: unknown) {
  return mcpRoute.POST(
    new Request(`http://drive.test/mcp/d/${driveId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    driveCtx(driveId),
  );
}

/** Streamable HTTP may answer as JSON or a single SSE event — normalize. */
async function rpcResult(res: Response): Promise<any> {
  const text = await res.text();
  const data = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("viewer1", "v@example.com", "Viewer", "x");
  u.run("stranger", "s@example.com", "Stranger", "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("d1", "owner1", "D1", "h", "s");
  d.run("d2", "owner1", "D2", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "d1", "viewer1", "", "viewer");
});

describe("mcp tokens (lib)", () => {
  it("clamps scope to the user's highest role", () => {
    expect(tokens.clampScope("d1", "owner1", "write")).toBe("write");
    expect(tokens.clampScope("d1", "viewer1", "write")).toBe("read");
    expect(tokens.clampScope("d1", "stranger", "read")).toBeNull();
  });

  it("issues, verifies, expires and revokes a PAT; only hashes are stored", () => {
    const { token, row } = tokens.issuePat({ userId: "owner1", driveId: "d1", name: "t", scope: "read", ttlDays: 30 });
    expect(token.startsWith("aind_pat_")).toBe(true);
    expect(JSON.stringify(db.prepare("SELECT * FROM mcp_tokens WHERE id = ?").get(row.id))).not.toContain(token);
    expect(tokens.verifyMcpToken(token)).toMatchObject({ userId: "owner1", driveId: "d1", scope: "read" });

    db.prepare("UPDATE mcp_tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, row.id);
    expect(tokens.verifyMcpToken(token)).toBeNull();
    db.prepare("UPDATE mcp_tokens SET expires_at = NULL WHERE id = ?").run(row.id);
    expect(tokens.verifyMcpToken(token)).not.toBeNull();
    expect(tokens.revokeToken(row.id)).toBe(true);
    expect(tokens.verifyMcpToken(token)).toBeNull();
    expect(tokens.verifyMcpToken("aind_pat_nope")).toBeNull();
  });

  it("tokens die with their drive (ON DELETE CASCADE)", () => {
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("dgone", "owner1", "Gone", "h", "s");
    const { token } = tokens.issuePat({ userId: "owner1", driveId: "dgone", name: "t", scope: "read", ttlDays: null });
    db.prepare("DELETE FROM drives WHERE id = 'dgone'").run();
    expect(tokens.verifyMcpToken(token)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_tokens WHERE drive_id = 'dgone'").get()).toEqual({ n: 0 });
  });
});

describe("/mcp/d/[driveId]", () => {
  it("401s with a resource_metadata pointer when no token is sent", async () => {
    const res = await rpc("d1", null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://drive.test/.well-known/oauth-protected-resource/mcp/d/d1"',
    );
  });

  it("403s a token bound to another drive", async () => {
    const { token } = tokens.issuePat({ userId: "owner1", driveId: "d2", name: "t", scope: "read", ttlDays: null });
    const res = await rpc("d1", token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("read token: lists no write_file / drive_id, and write_file is refused", async () => {
    const { token } = tokens.issuePat({ userId: "owner1", driveId: "d1", name: "t", scope: "read", ttlDays: null });
    const list = await rpcResult(await rpc("d1", token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_files", "read_file", "stat", "search", "a2ui_action"]);
    expect(JSON.stringify(list.result.tools)).not.toContain("drive_id");

    const call = await rpcResult(await rpc("d1", token, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_file", arguments: { path: "a.txt", content: "x" } },
    }));
    expect(call.result.isError).toBe(true);
  });

  it("write token still can't exceed the user's live role", async () => {
    const { token, row } = tokens.issuePat({ userId: "owner1", driveId: "d1", name: "t", scope: "write", ttlDays: null });
    const list = await rpcResult(await rpc("d1", token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("write_file");
    // Simulate a token whose holder is only a viewer (e.g. downgraded after issue).
    db.prepare("UPDATE mcp_tokens SET user_id = 'viewer1' WHERE id = ?").run(row.id);
    const call = await rpcResult(await rpc("d1", token, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_file", arguments: { path: "a.txt", content: "x" } },
    }));
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("forbidden");
  });
});

describe("token management API", () => {
  it("viewer can issue read but not write; owner sees everyone's; holder/owner can revoke", async () => {
    cookieJar.set("aindrive_session", await sign("viewer1"));
    const post = (body: unknown) => tokensRoute.POST(
      new Request("http://drive.test/api", { method: "POST", headers: { "content-type": "application/json", origin: "http://drive.test" }, body: JSON.stringify(body) }) as any,
      driveCtx("d1"),
    );
    expect((await post({ name: "w", scope: "write", ttlDays: 30 })).status).toBe(403);
    const noOrigin = await tokensRoute.POST(
      new Request("http://drive.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) }) as any,
      driveCtx("d1"),
    );
    expect(noOrigin.status).toBe(403); // CSRF guard
    const ok = await post({ name: "mine", scope: "read", ttlDays: null });
    expect(ok.status).toBe(201);
    const { token, row, mcpUrl } = await ok.json();
    expect(mcpUrl).toBe(MCP_URL);
    expect(tokens.verifyMcpToken(token)).not.toBeNull();

    const mine = await (await tokensRoute.GET(new Request("http://drive.test") as any, driveCtx("d1"))).json();
    expect(mine.canWrite).toBe(false);
    expect(mine.tokens.every((t: { user_id: string }) => t.user_id === "viewer1")).toBe(true);

    cookieJar.set("aindrive_session", await sign("stranger"));
    expect((await tokensRoute.GET(new Request("http://drive.test") as any, driveCtx("d1"))).status).toBe(403);
    const del = (id: string) => tokenIdRoute.DELETE(new Request("http://drive.test", { headers: { origin: "http://drive.test" } }) as any, { params: Promise.resolve({ driveId: "d1", tokenId: id }) });
    expect((await del(row.id)).status).toBe(403);

    cookieJar.set("aindrive_session", await sign("owner1"));
    const all = await (await tokensRoute.GET(new Request("http://drive.test") as any, driveCtx("d1"))).json();
    expect(all.isOwner).toBe(true);
    expect(all.tokens.some((t: { user_email: string }) => t.user_email === "v@example.com")).toBe(true);
    expect((await del(row.id)).status).toBe(200);
    expect(tokens.verifyMcpToken(token)).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths and drops open-redirect forms", async () => {
    const { safeNextPath } = await import("../safe-next");
    expect(safeNextPath("/oauth/authorize?client_id=a&x=1")).toBe("/oauth/authorize?client_id=a&x=1");
    for (const bad of ["//evil.com", "/\\evil.com", "/%5Cevil.com".replace("%5C", "\\"), "https://evil.com", "", null]) {
      expect(safeNextPath(bad as string | null)).toBe("/");
    }
  });
});

describe("OAuth 2.1 flow", () => {
  const redirectUri = "http://127.0.0.1:33418/callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let clientId = "";

  const form = (p: Record<string, string>) => tokenRoute.POST(new Request("http://drive.test/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(p).toString(),
  }));

  const approve = (extra: Record<string, unknown> = {}, origin = "http://drive.test") => authorizeRoute.POST(new Request("http://drive.test/api/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: "drive.test" },
    body: JSON.stringify({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
      code_challenge_method: "S256", scope: "drive:read drive:write", state: "xyz", resource: MCP_URL,
      decision: "approve", ...extra,
    }),
  }));

  it("serves protected-resource metadata", async () => {
    const res = await prmRoute.GET(new Request("http://drive.test"), driveCtx("d1"));
    expect(await res.json()).toMatchObject({ resource: MCP_URL, authorization_servers: ["http://drive.test"] });
  });

  it("rejects unsafe redirect URIs at registration", async () => {
    for (const bad of ["javascript:alert(1)", "http://evil.example/cb", "https://x.example/cb#frag"]) {
      const res = await registerRoute.POST(new Request("http://drive.test", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [bad] }),
      }));
      expect(res.status).toBe(400);
    }
    expect(oauth.isAllowedRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(oauth.isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(oauth.isAllowedRedirectUri("intent://x#Intent;end")).toBe(false);
  });

  it("register → consent → code exchange → call → refresh rotation → revoke", async () => {
    const reg = await registerRoute.POST(new Request("http://drive.test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test App", redirect_uris: [redirectUri] }),
    }));
    expect(reg.status).toBe(201);
    clientId = (await reg.json()).client_id;

    cookieJar.set("aindrive_session", await sign("owner1"));
    expect((await approve({}, "http://evil.example")).status).toBe(403); // CSRF guard
    expect((await approve({ resource: "http://drive.test/mcp/d/nope/extra" })).status).toBe(400);

    const denied = await (await approve({ decision: "deny" })).json();
    expect(new URL(denied.redirect).searchParams.get("error")).toBe("access_denied");

    const { redirect } = await (await approve()).json();
    const back = new URL(redirect);
    expect(back.origin + back.pathname).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe("http://drive.test");
    const code = back.searchParams.get("code")!;

    const badVerifier = await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: "x".repeat(43) });
    expect(badVerifier.status).toBe(400);
    // The failed attempt burned the code — even the right verifier now fails.
    const replay = await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier });
    expect((await replay.json()).error).toBe("invalid_grant");

    const code2 = new URL((await (await approve()).json()).redirect).searchParams.get("code")!;
    const tok = await form({ grant_type: "authorization_code", code: code2, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier });
    expect(tok.status).toBe(200);
    const t1 = await tok.json();
    expect(t1).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "drive:read drive:write" });

    const list = await rpcResult(await rpc("d1", t1.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("write_file");

    const r = await form({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId });
    const t2 = await r.json();
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(tokens.verifyMcpToken(t1.access_token)).toBeNull();
    expect(tokens.verifyMcpToken(t2.access_token)).not.toBeNull();
    const row = tokens.listActiveTokens("d1", "owner1").find((x) => x.kind === "oauth")!;
    expect(row.name).toBe("Test App");

    // Replaying the superseded refresh token = leak → the whole grant dies.
    const reused = await form({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId });
    expect(reused.status).toBe(400);
    expect(tokens.verifyMcpToken(t2.access_token)).toBeNull();
    expect((await form({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId })).status).toBe(400);
    expect(tokens.getToken(row.id)?.revoked_at).not.toBeNull();
  });

  it("revoking a connected app kills its tokens", async () => {
    cookieJar.set("aindrive_session", await sign("owner1"));
    const code = new URL((await (await approve()).json()).redirect).searchParams.get("code")!;
    const t = await (await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier })).json();
    const row = tokens.listActiveTokens("d1", "owner1").find((x) => x.kind === "oauth")!;
    tokens.revokeToken(row.id);
    expect(tokens.verifyMcpToken(t.access_token)).toBeNull();
    expect((await form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId })).status).toBe(400);
  });

  it("clamps an OAuth grant to read for a viewer", async () => {
    cookieJar.set("aindrive_session", await sign("viewer1"));
    const code = new URL((await (await approve({ scope_choice: "write" })).json()).redirect).searchParams.get("code")!;
    const t = await (await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier })).json();
    expect(t.scope).toBe("drive:read");
  });
});
