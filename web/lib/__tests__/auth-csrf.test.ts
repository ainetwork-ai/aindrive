// Login CSRF (lib/auth-csrf.ts): another site's page auto-submits a top-level
// `enctype=text/plain` form whose body parses as JSON — a simple request, no
// preflight — and the Lax session cookie in the answer would be stored. Every
// auth POST that sets or ends the session refuses a request the browser marks
// as cross-origin, and the JSON ones refuse any body that is not
// application/json. Same-origin pages and native clients (no Origin) work as
// before.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { cookieJar } from "./sso-test-issuer";

const PUBLIC_URL = "https://drive.example.test";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-auth-csrf-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "auth-csrf-test-secret-0123456789abcdef";
process.env.AINDRIVE_GOOGLE_CLIENT_IDS = "web-client.apps.googleusercontent.com";
process.env.AINDRIVE_DEV_BYPASS_OTP = "1";

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));
vi.mock("@/lib/google-auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/google-auth")>()),
  verifyGoogleIdToken: async () => ({ sub: "g-mallory", email: "g-mallory@example.com", name: "Mallory" }),
}));

const { db } = await import("../db.js");
const { authPostRefusal } = await import("../auth-csrf");
const loginRoute = await import("../../app/api/auth/login/route.js");
const signupRoute = await import("../../app/api/auth/signup/route.js");
const googleRoute = await import("../../app/api/auth/google/route.js");
const walletLoginRoute = await import("../../app/api/wallet/login/route.js");
const logoutRoute = await import("../../app/api/auth/logout/route.js");
const session = await import("../session");

type Handler = (req: Request) => Promise<Response>;
const CROSS = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };

/** What `<form method=POST enctype=text/plain>` with name='{"k":"v",…,"x":"' value='"}' sends. */
function formPost(path: string, fields: Record<string, string>, headers: Record<string, string> = CROSS) {
  const body = `${JSON.stringify({ ...fields, x: "" }).slice(0, -2)}="}\r\n`; // {…,"x":"="}
  expect(JSON.parse(body)).toMatchObject(fields); // req.json() would accept it
  return new Request(`${PUBLIC_URL}${path}`, { method: "POST", headers: { "content-type": "text/plain", ...headers }, body });
}
function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${PUBLIC_URL}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const MALLORY = { email: "mallory@evil.example", password: "pw-mallory" };
const ROUTES: Array<[string, Handler, Record<string, string>]> = [
  ["/api/auth/login", loginRoute.POST, MALLORY],
  ["/api/auth/signup", signupRoute.POST, { email: "new-mallory@evil.example", name: "Mallory", password: "pw-mallory-2" }],
  ["/api/auth/google", googleRoute.POST, { idToken: "an-attacker-obtained-google-id-token" }],
  ["/api/wallet/login", walletLoginRoute.POST, { address: `0x${"1".repeat(40)}`, signature: "0xsig", nonce: "nonce-1234", message: "a SIWE message" }],
];

beforeAll(() => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u_mallory", MALLORY.email, "Mallory", bcrypt.hashSync(MALLORY.password, 4));
});
beforeEach(() => {
  jar.clear();
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
});

describe("a cross-site form can't sign the browser in", () => {
  it.each(ROUTES)("%s: a text/plain form POST from another site → 403, no session", async (path, handler, fields) => {
    const res = await handler(formPost(path, fields));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad origin" });
    expect(jar.get("aindrive_session")).toBeUndefined();
  });

  it.each(ROUTES)("%s: not application/json → 415 even without Origin (older browsers, stripped headers)", async (path, handler, fields) => {
    const res = await handler(formPost(path, fields, {}));
    expect(res.status).toBe(415);
    expect(jar.get("aindrive_session")).toBeUndefined();
  });

  it.each(ROUTES)("%s: JSON from another origin, a sibling site or a sandboxed frame (Origin: null) → 403", async (path, handler, fields) => {
    for (const headers of <Record<string, string>[]>[{ origin: "https://evil.example" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { origin: "null" }]) {
      expect((await handler(jsonPost(path, fields, headers))).status).toBe(403);
    }
    expect(jar.get("aindrive_session")).toBeUndefined();
  });

  it("the sign-in page (same origin) and native apps (no Origin, JSON) still sign in", async () => {
    const page = await loginRoute.POST(jsonPost("/api/auth/login", MALLORY, { origin: PUBLIC_URL, "sec-fetch-site": "same-origin" }));
    expect(page.status).toBe(200);
    expect(await session.verify(jar.get("aindrive_session")!)).toBe("u_mallory");
    jar.clear();
    // mobile/: POST /api/auth/google through CapacitorHttp — JSON, no Origin, no Sec-Fetch-*.
    const app = await googleRoute.POST(jsonPost("/api/auth/google", { idToken: "a-google-id-token-from-the-phone" }, { "content-type": "application/json; charset=utf-8" }));
    expect(app.status).toBe(200);
    expect(jar.get("aindrive_session")).toBeTruthy();
    // Behind the proxy the Host header, not the public URL, may name this server.
    const proxied = new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, body: JSON.stringify(MALLORY),
    });
    expect(authPostRefusal(proxied, { json: true })).toBeNull();
  });
});

describe("sign-out", () => {
  it("another site can't sign the browser out; the page's own form can", async () => {
    await session.setCookie("u_mallory");
    const cross = await logoutRoute.POST(new Request(`${PUBLIC_URL}/api/auth/logout`, { method: "POST", headers: CROSS }));
    expect(cross.status).toBe(403);
    expect(jar.get("aindrive_session")).toBeTruthy();
    const own = await logoutRoute.POST(new Request(`${PUBLIC_URL}/api/auth/logout`, {
      method: "POST", headers: { origin: PUBLIC_URL, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
    }));
    expect(own.status).toBe(303);
    expect(jar.get("aindrive_session")).toBeUndefined();
  });
});

describe("source guard", () => {
  function routes(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? routes(p) : f === "route.ts" ? [p] : [];
    });
  }

  it("every API route that sets the session cookie asks authPostRefusal first", () => {
    const api = join(__dirname, "../../app/api");
    const setters = routes(api).filter((p) => /\bsetCookie\(/.test(readFileSync(p, "utf8")));
    expect(setters.map((p) => p.slice(api.length + 1)).sort()).toEqual([
      "auth/google/route.ts", "auth/login/route.ts", "auth/signup/route.ts", "wallet/login/route.ts",
    ]);
    for (const p of setters) {
      const src = readFileSync(p, "utf8");
      const post = src.slice(src.indexOf("export async function POST"));
      expect(post, p).toMatch(/^export async function POST\(req: Request\) \{\n(\s*\/\/.*\n)*\s*const csrf = authPostRefusal\(req, \{ json: true \}\);\n\s*if \(csrf\) return csrf;/);
    }
    expect(readFileSync(join(api, "auth/logout/route.ts"), "utf8")).toContain("const csrf = authPostRefusal(req, { json: false });");
  });
});
