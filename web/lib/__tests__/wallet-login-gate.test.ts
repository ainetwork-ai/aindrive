import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiweMessage } from "siwe";

// Throwaway DB + a deterministic public URL, set before db.js / route load.
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-walletlogin-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";

// Isolate the route's account/gate logic: the SIWE crypto is siwe-verify's
// concern (its own test), so stub it true here; stub cookie + rate-limit too.
vi.mock("@/lib/siwe-verify", () => ({ verifyWalletSignature: vi.fn(async () => true) }));
const setCookie = vi.fn(async () => {});
vi.mock("@/lib/session", () => ({ setCookie }));
vi.mock("@/lib/rate-limit", () => ({ tryConsume: () => ({ ok: true }), clientKey: () => "k" }));

const { db } = await import("../db.js");
const wallet = await import("../wallet.js");
const { POST } = await import("../../app/api/wallet/login/route.js");

// Valid 40-hex-char addresses (all-digit → no checksum concern).
const mkAddr = (c: string) => "0x" + c.repeat(40);
// A real email account with a NON-login-enabled linked wallet (the gate case).
const BLOCKED = mkAddr("3");
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("e1", "e1@x.com", "E1", "h");
wallet.linkWalletToAccount("e1", BLOCKED, "siwe"); // login_enabled defaults 0

// The route derives ip from x-forwarded-for/x-real-ip; with neither set it is
// "anon", so issue the nonce under that key.
function signedReq(address: string) {
  const { nonce } = wallet.issueNonce("anon");
  const message = new SiweMessage({
    domain: "drive.example.test", address, statement: "sign in",
    uri: "https://drive.example.test", version: "1", chainId: 84532, nonce,
  }).prepareMessage();
  return new Request("https://drive.example.test/api/wallet/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature: "0xsig", nonce, message }),
  });
}

describe("POST /api/wallet/login provenance gate", () => {
  beforeEach(() => setCookie.mockClear());

  it("mints a session for an unknown wallet (fresh login-enabled placeholder)", async () => {
    const res = await POST(signedReq(mkAddr("1")));
    expect(res.status).toBe(200);
    expect(setCookie).toHaveBeenCalledOnce();
  });

  it("refuses (403) to log into a real account whose wallet is not login-enabled", async () => {
    const res = await POST(signedReq(BLOCKED));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wallet_login_not_enabled" });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("rejects (400) a SIWE message built for the wrong chainId", async () => {
    const address = mkAddr("5");
    const { nonce } = wallet.issueNonce("anon");
    const message = new SiweMessage({
      domain: "drive.example.test", address, statement: "sign in",
      uri: "https://drive.example.test", version: "1", chainId: 1, nonce, // not the active Base chain
    }).prepareMessage();
    const req = new Request("https://drive.example.test/api/wallet/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature: "0xsig", nonce, message }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("mints a session for a placeholder wallet (login-enabled by construction)", async () => {
    const placeholder = mkAddr("2");
    wallet.resolveAccountForWallet(placeholder); // mints a login-enabled placeholder
    const res = await POST(signedReq(placeholder));
    expect(res.status).toBe(200);
    expect(setCookie).toHaveBeenCalledOnce();
  });
});
