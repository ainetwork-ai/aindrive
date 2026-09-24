import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-acct-oauth-"));
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
const oauth = await import("../oauth");
const acct = await import("../account-tokens");
const mcpTokens = await import("../mcp-tokens");
const mcpRoute = await import("../../app/mcp/d/[driveId]/route.js");
const authorizeRoute = await import("../../app/api/oauth/authorize/route.js");
const tokenRoute = await import("../../app/api/oauth/token/route.js");
const userinfoRoute = await import("../../app/api/oauth/userinfo/route.js");
const drivesRoute = await import("../../app/api/oauth/drives/route.js");
const listRoute = await import("../../app/api/oauth/account-tokens/route.js");
const revokeRoute = await import("../../app/api/oauth/account-tokens/[id]/route.js");
const asMetaRoute = await import("../../app/.well-known/oauth-authorization-server/route.js");

const REDIRECT = "https://afan.example/auth/aindrive/callback";
const MCP_D1 = "http://drive.test/mcp/d/d1";
const WALLET = "0xabcdef0000000000000000000000000000000001";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
let clientId = "";

const authParams = (extra: Record<string, string | null> = {}) => ({
  response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
  code_challenge: challenge, code_challenge_method: "S256", state: "st", ...extra,
});

function rpc(driveId: string, token: string, body: unknown) {
  return mcpRoute.POST(
    new Request(`http://drive.test/mcp/d/${driveId}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ driveId }) },
  );
}

async function rpcResult(res: Response): Promise<any> {
  const text = await res.text();
  const data = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

const form = (p: Record<string, string>) => tokenRoute.POST(new Request("http://drive.test/api/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(p).toString(),
}));

const bearerGet = (route: { GET: (r: Request) => Response }, token: string | null) =>
  route.GET(new Request("http://drive.test/api/oauth/x", { headers: token ? { authorization: `Bearer ${token}` } : {} }));

const issue = (userId: string, scope: string) =>
  acct.issueAccountTokens({ userId, clientId, clientName: "Afan", scopes: oauth.parseAccountScopes(scope) });

beforeAll(() => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  u.run("owner1", "o@example.com", "Owner", "x");
  u.run("viewer1", "v@example.com", "Viewer", "x");
  u.run("w_wallet1", `${WALLET}@wallet.aindrive.local`, "wallet:0xabcdef00", "x");
  u.run("w_attached", "attached@example.com", "Attached", "x");
  db.prepare("INSERT INTO account_wallets (id, account_id, wallet_address, verified_via, login_enabled) VALUES (?,?,?,?,1)")
    .run("aw1", "w_wallet1", WALLET, "payment");
  db.prepare("INSERT INTO account_wallets (id, account_id, wallet_address, verified_via, login_enabled) VALUES (?,?,?,?,1)")
    .run("aw2", "w_attached", "0x2222222222222222222222222222222222222222", "payment");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  d.run("d1", "owner1", "D1", "h", "s");
  d.run("d2", "owner1", "D2", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m1", "d1", "viewer1", "", "viewer");
  clientId = oauth.registerClient("Afan", [REDIRECT]).client_id;
});

describe("(a) validateAuthorize: account vs drive grants", () => {
  it("no resource + only account scopes → account grant (driveId null, canonical scope order)", () => {
    const v = oauth.validateAuthorize(authParams({ scope: "drives:read profile" }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.driveId).toBeNull();
    if (v.value.driveId !== null) return;
    expect(v.value.accountScopes).toEqual(["profile", "drives:read"]);
    const one = oauth.validateAuthorize(authParams({ scope: "profile" }));
    expect(one.ok && one.value.driveId === null && one.value.accountScopes).toEqual(["profile"]);
  });

  it("drive resource keeps today's lenient drive:* rules", () => {
    const v = oauth.validateAuthorize(authParams({ resource: MCP_D1, scope: "drive:read drive:write" }));
    expect(v.ok && v.value).toMatchObject({ driveId: "d1", requestedScope: "write" });
    const noScope = oauth.validateAuthorize(authParams({ resource: MCP_D1 }));
    expect(noScope.ok && noScope.value).toMatchObject({ driveId: "d1", requestedScope: "read" });
  });

  it("rejects mixed, unknown, empty and drive-only-without-resource requests", () => {
    const err = (scope: string | null, resource: string | null = null) => {
      const v = oauth.validateAuthorize(authParams({ scope, resource }));
      return v.ok ? null : v.error;
    };
    expect(err("profile drive:read")).toMatch(/can't be combined/);
    expect(err("profile openid")).toMatch(/Unknown scope: openid/);
    expect(err("")).toMatch(/resource/);
    expect(err(null)).toMatch(/resource/);
    expect(err("drive:read")).toMatch(/resource/);
    expect(err("profile", "http://drive.test/mcp/d/nope/extra")).toMatch(/resource/);
  });

  it("advertises account scopes + userinfo in AS metadata, drive scopes only in PRM", async () => {
    const meta = await asMetaRoute.GET().json();
    expect(meta.scopes_supported).toEqual(["drive:read", "drive:write", "profile", "drives:read", "drives:write", "drives:sell"]);
    expect(meta.userinfo_endpoint).toBe("http://drive.test/api/oauth/userinfo");
    expect(oauth.protectedResourceMetadata("d1", "D1").scopes_supported).toEqual(["drive:read", "drive:write"]);
  });
});

describe("(b) account authorization codes", () => {
  const redeem = (code: string, v = verifier, redirectUri = REDIRECT) =>
    oauth.redeemAccountCode({ code, clientId, redirectUri, codeVerifier: v });
  const newCode = () => oauth.issueAccountCode({ clientId, userId: "owner1", scopes: ["profile", "drives:read"], redirectUri: REDIRECT, codeChallenge: challenge });

  it("redeems once with the right PKCE verifier; only the hash is stored", () => {
    const code = newCode();
    expect(JSON.stringify(db.prepare("SELECT * FROM account_oauth_codes").all())).not.toContain(code);
    expect(redeem(code)).toEqual({ userId: "owner1", scopes: ["profile", "drives:read"] });
    expect(redeem(code)).toBeNull();
  });

  it("a wrong verifier or redirect burns the code", () => {
    const code = newCode();
    expect(redeem(code, "x".repeat(43))).toBeNull();
    expect(redeem(code)).toBeNull();
    const code2 = newCode();
    expect(redeem(code2, verifier, "https://afan.example/other")).toBeNull();
    expect(redeem(code2)).toBeNull();
  });

  it("expired codes fail", () => {
    const code = newCode();
    db.prepare("UPDATE account_oauth_codes SET expires_at = ? WHERE code_hash = ?").run(Date.now() - 1, mcpTokens.hashToken(code));
    expect(redeem(code)).toBeNull();
  });

  it("drive and account codes never cross tables", () => {
    const acode = newCode();
    expect(oauth.redeemCode({ code: acode, clientId, redirectUri: REDIRECT, codeVerifier: verifier })).toBeNull();
    expect(redeem(acode)).not.toBeNull();
    const dcode = oauth.issueCode({ clientId, userId: "owner1", driveId: "d1", scope: "read", redirectUri: REDIRECT, codeChallenge: challenge });
    expect(redeem(dcode)).toBeNull();
    expect(oauth.redeemCode({ code: dcode, clientId, redirectUri: REDIRECT, codeVerifier: verifier })).not.toBeNull();
  });
});

describe("(c) account tokens", () => {
  it("issues aind_aat_/aind_art_, stores only hashes, verifies, expires", () => {
    const pair = issue("owner1", "profile drives:read");
    expect(pair.access_token.startsWith("aind_aat_")).toBe(true);
    expect(pair.refresh_token.startsWith("aind_art_")).toBe(true);
    expect(pair).toMatchObject({ expires_in: 3600, scope: "profile drives:read" });
    const rows = JSON.stringify(db.prepare("SELECT * FROM account_tokens").all());
    expect(rows).not.toContain(pair.access_token);
    expect(rows).not.toContain(pair.refresh_token);
    const v = acct.verifyAccountToken(pair.access_token)!;
    expect(v).toMatchObject({ userId: "owner1", clientId, scopes: ["profile", "drives:read"] });
    // Drive-token verification never accepts an account token, and vice versa.
    expect(mcpTokens.verifyMcpToken(pair.access_token)).toBeNull();
    const { token: pat } = mcpTokens.issuePat({ userId: "owner1", driveId: "d1", name: "p", scope: "read", ttlDays: null });
    expect(acct.verifyAccountToken(pat)).toBeNull();

    db.prepare("UPDATE account_tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, v.id);
    expect(acct.verifyAccountToken(pair.access_token)).toBeNull();
  });

  it("refresh rotates; replaying the superseded refresh token revokes the grant", () => {
    const t1 = issue("owner1", "profile");
    const t2 = acct.refreshAccountTokens(t1.refresh_token, clientId)!;
    expect(t2.scope).toBe("profile");
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(acct.verifyAccountToken(t1.access_token)).toBeNull();
    const live = acct.verifyAccountToken(t2.access_token)!;
    expect(live).not.toBeNull();
    expect(acct.refreshAccountTokens(t2.refresh_token, "aind_client_other")).toBeNull(); // wrong client

    expect(acct.refreshAccountTokens(t1.refresh_token, clientId)).toBeNull(); // reuse → revoke
    expect(acct.verifyAccountToken(t2.access_token)).toBeNull();
    expect(acct.refreshAccountTokens(t2.refresh_token, clientId)).toBeNull();
    expect(acct.getAccountToken(live.id)?.revoked_at).not.toBeNull();
  });

  it("an expired refresh token can't refresh", () => {
    const t = issue("owner1", "profile");
    db.prepare("UPDATE account_tokens SET refresh_expires_at = ? WHERE token_hash = ?").run(Date.now() - 1, mcpTokens.hashToken(t.access_token));
    expect(acct.refreshAccountTokens(t.refresh_token, clientId)).toBeNull();
  });

  it("lists and revokes only the user's own grants; a revoked grant dies", () => {
    const t = issue("viewer1", "drives:read");
    const [row] = acct.listAccountTokens("viewer1");
    expect(row).toMatchObject({ name: "Afan", client_id: clientId, scope: "drives:read" });
    expect(acct.revokeAccountToken("owner1", row.id)).toBe(false);
    expect(acct.revokeAccountToken("viewer1", row.id)).toBe(true);
    expect(acct.verifyAccountToken(t.access_token)).toBeNull();
    expect(acct.refreshAccountTokens(t.refresh_token, clientId)).toBeNull();
    expect(acct.listAccountTokens("viewer1")).toEqual([]);
  });

  it("keeps a client with only account grants out of registration GC", () => {
    const old = oauth.registerClient("Old", [REDIRECT]);
    db.prepare("UPDATE oauth_clients SET created_at = 0 WHERE client_id = ?").run(old.client_id);
    acct.issueAccountTokens({ userId: "owner1", clientId: old.client_id, clientName: "Old", scopes: ["profile"] });
    oauth.gcOAuth();
    expect(oauth.getClient(old.client_id)).not.toBeNull();
  });
});

describe("(d) userinfo", () => {
  it("email account: verified email, no wallet until one is linked (lowercased)", () => {
    expect(acct.accountUserinfo("viewer1")).toEqual({
      sub: "viewer1", email: "v@example.com", email_verified: true, name: "Viewer", wallet_address: null,
    });
    db.prepare("INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?,?,?,?)")
      .run("aw3", "viewer1", "0x3333333333333333333333333333333333333333", "siwe");
    expect(acct.accountUserinfo("viewer1")?.wallet_address).toBe("0x3333333333333333333333333333333333333333");
  });

  it("wallet account: own address, synthetic email is not verified", () => {
    expect(acct.accountUserinfo("w_wallet1")).toEqual({
      sub: "w_wallet1", email: `${WALLET}@wallet.aindrive.local`, email_verified: false,
      name: "wallet:0xabcdef00", wallet_address: WALLET,
    });
  });

  it("wallet account that attached a real email: address from its minted wallet link", () => {
    expect(acct.accountUserinfo("w_attached")).toMatchObject({
      email: "attached@example.com", email_verified: true, wallet_address: "0x2222222222222222222222222222222222222222",
    });
  });

  it("GET /api/oauth/userinfo: 401 without/with a bad token, 403 without profile, 200 with it", async () => {
    const none = await bearerGet(userinfoRoute, null);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(none.headers.get("access-control-allow-origin")).toBe("*");
    expect((await bearerGet(userinfoRoute, "aind_aat_bogus")).status).toBe(401);

    const drivesOnly = issue("owner1", "drives:read");
    const forbidden = await bearerGet(userinfoRoute, drivesOnly.access_token);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: "insufficient_scope" });
    expect(forbidden.headers.get("www-authenticate")).toContain('scope="profile"');

    const ok = await bearerGet(userinfoRoute, issue("w_wallet1", "profile").access_token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ sub: "w_wallet1", wallet_address: WALLET });
  });

  it("GET /api/oauth/drives lists the user's drives with their role (needs drives:read)", async () => {
    expect((await bearerGet(drivesRoute, issue("owner1", "profile").access_token)).status).toBe(403);
    const owner = await (await bearerGet(drivesRoute, issue("owner1", "drives:read").access_token)).json();
    expect(owner.drives.map((d: { id: string }) => d.id).sort()).toEqual(["d1", "d2"]);
    expect(owner.drives[0]).toMatchObject({ role: "owner", online: false });
    const viewer = await (await bearerGet(drivesRoute, issue("viewer1", "drives:read").access_token)).json();
    expect(viewer.drives).toEqual([{ id: "d1", name: "D1", online: false, role: "viewer" }]);
  });
});

describe("(e) /mcp/d/[driveId] with an account token", () => {
  it("member drive: read tools only, write_file refused", async () => {
    const { access_token } = issue("viewer1", "drives:read");
    const list = await rpcResult(await rpc("d1", access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["list_files", "read_file", "stat", "search", "a2ui_action"]);
    const call = await rpcResult(await rpc("d1", access_token, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "write_file", arguments: { path: "a.txt", content: "x" } },
    }));
    expect(call.result.isError).toBe(true);
  });

  it("even the owner's account token gets no write tools", async () => {
    const { access_token } = issue("owner1", "drives:read");
    const list = await rpcResult(await rpc("d1", access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delete_path");
  });

  it("403 on a drive the user isn't a member of, and without drives:read", async () => {
    const res = await rpc("d2", issue("viewer1", "drives:read").access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
    expect((await rpc("d1", issue("viewer1", "profile").access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
  });

  it("401 with the drive's resource_metadata for a bad/revoked account token", async () => {
    const t = issue("viewer1", "drives:read");
    // Revoke exactly this token: viewer1 holds others from earlier tests, and
    // same-millisecond created_at makes "the first listed" order unstable.
    acct.revokeAccountToken("viewer1", acct.verifyAccountToken(t.access_token)!.id);
    const res = await rpc("d1", t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://drive.test/.well-known/oauth-protected-resource/mcp/d/d1"',
    );
  });
});

describe("account grant end-to-end through the routes", () => {
  const approve = (extra: Record<string, unknown> = {}) => authorizeRoute.POST(new Request("http://drive.test/api/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://drive.test", host: "drive.test" },
    body: JSON.stringify({ ...authParams({ scope: "profile drives:read" }), decision: "approve", ...extra }),
  }));

  it("consent → code → token → userinfo → refresh → list → revoke", async () => {
    cookieJar.set("aindrive_session", await sign("viewer1"));
    const denied = await (await approve({ decision: "deny" })).json();
    expect(new URL(denied.redirect).searchParams.get("error")).toBe("access_denied");
    expect((await approve({ scope: "profile drive:write" })).status).toBe(400);

    const back = new URL((await (await approve()).json()).redirect);
    expect(back.searchParams.get("state")).toBe("st");
    const code = back.searchParams.get("code")!;
    const tok = await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(tok.status).toBe(200);
    const t1 = await tok.json();
    expect(t1).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "profile drives:read" });
    expect(Object.keys(t1).sort()).toEqual(["access_token", "expires_in", "refresh_token", "scope", "token_type"]);
    const replay = await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect((await replay.json()).error).toBe("invalid_grant");

    expect((await (await bearerGet(userinfoRoute, t1.access_token)).json()).sub).toBe("viewer1");

    const r = await form({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId });
    expect(r.status).toBe(200);
    const t2 = await r.json();
    expect(t2).toMatchObject({ token_type: "Bearer", scope: "profile drives:read" });
    expect(t2.refresh_token.startsWith("aind_art_")).toBe(true);

    const id = acct.verifyAccountToken(t2.access_token)!.id;
    const listed = await (await listRoute.GET()).json();
    expect(listed.tokens.find((t: { id: string }) => t.id === id)).toMatchObject({ name: "Afan", scope: "profile drives:read" });
    expect(listed.tokens.every((t: { user_id: string }) => t.user_id === "viewer1")).toBe(true);
    const del = (origin: string | null, tokenId = id) => revokeRoute.DELETE(
      new Request("http://drive.test", { method: "DELETE", headers: origin ? { origin } : {} }) as any,
      { params: Promise.resolve({ id: tokenId }) },
    );
    expect((await del(null)).status).toBe(403); // CSRF guard
    cookieJar.set("aindrive_session", await sign("owner1"));
    expect((await del("http://drive.test")).status).toBe(404); // not the owner's grant
    cookieJar.set("aindrive_session", await sign("viewer1"));
    expect((await del("http://drive.test")).status).toBe(200);
    expect((await bearerGet(userinfoRoute, t2.access_token)).status).toBe(401);
    expect((await del("http://drive.test")).status).toBe(404);
    cookieJar.delete("aindrive_session");
    expect((await listRoute.GET()).status).toBe(401);
  });

  it("drive grants through the same endpoints are unchanged", async () => {
    cookieJar.set("aindrive_session", await sign("owner1"));
    const res = await approve({ scope: "drive:read drive:write", resource: MCP_D1 });
    const code = new URL((await res.json()).redirect).searchParams.get("code")!;
    const t = await (await form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier })).json();
    expect(t.access_token.startsWith("aind_oat_")).toBe(true);
    expect(t.scope).toBe("drive:read drive:write");
    const r = await (await form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId })).json();
    expect(r.access_token.startsWith("aind_oat_")).toBe(true);
  });
});
