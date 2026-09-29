// "Continue with AIN" lands on the organization's drive: on a person's first
// AIN sign-in, and on every sign-in while they have no personal drive — so the
// company folder (ComCom) is the first thing they see. An explicit `next` is
// kept; returning people with drives of their own go home, where the
// organization section is listed first.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_ID, CLIENT_SECRET, cookieJar, createTestIssuer, fakeIssuerFetch, ISSUER, PUBLIC_URL, type TokenEndpointCall } from "./sso-test-issuer";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-org-landing-"));
process.env.AINDRIVE_PUBLIC_URL = PUBLIC_URL;
process.env.AINDRIVE_SESSION_SECRET = "org-landing-test-secret-0123456789abcdef";
process.env.AINDRIVE_SSO_ISSUER = ISSUER;
process.env.AINDRIVE_SSO_CLIENT_ID = CLIENT_ID;
process.env.AINDRIVE_SSO_CLIENT_SECRET = CLIENT_SECRET;
process.env.AINDRIVE_SSO_ENABLED = "true";

const { jar, cookies } = cookieJar();
vi.mock("next/headers", () => ({ cookies }));

const { db } = await import("../db.js");
const store = await import("../sso/store.js");
const oidc = await import("../sso/oidc");
const orgs = await import("../orgs.js");
const startRoute = await import("../../app/api/auth/sso/start/route.js");
const callbackRoute = await import("../../app/api/auth/sso/callback/route.js");
const linkRoute = await import("../../app/api/auth/sso/link/route.js");

const issuer = await createTestIssuer();
let lastNonce = "";
let currentSub = "";
const fake = fakeIssuerFetch(issuer, async (_call: TokenEndpointCall) => ({
  access_token: "at", token_type: "Bearer",
  id_token: await issuer.idToken({ sub: currentSub, nonce: lastNonce, sid: `sid-${currentSub}`, name: "Kim", email: `${currentSub}@comcom.ai`, email_verified: true }),
}));

const ORG = { id: "org_comcom", slug: "comcom", name: "ComCom" };
const ORG_DRIVE = "d-comcom";

/** The adapter provisions a ComCom member (a placeholder account until they sign in). */
function provision(sub: string, version = 1, appRole = "member") {
  const { result } = store.applyDesiredState(ISSUER, {
    schema: "ain-sso.adapter.v1", sub, org: ORG, version, status: "active",
    profile: { name: sub, email: null, workEmail: `${sub}@comcom.ai` },
    appRole, groups: [], legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(),
  });
  return result.localUserId;
}

async function signIn(sub: string, next = "/") {
  currentSub = sub;
  const start = await startRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/start?next=${encodeURIComponent(next)}`));
  const url = new URL(start.headers.get("location")!);
  lastNonce = url.searchParams.get("nonce")!;
  return callbackRoute.GET(new Request(`${PUBLIC_URL}/api/auth/sso/callback?${new URLSearchParams({ code: `c-${sub}`, state: url.searchParams.get("state")!, iss: ISSUER })}`));
}
const where = (res: Response) => res.headers.get("location");

beforeAll(() => {
  vi.stubGlobal("fetch", fake.impl);
  oidc.setJwksForTests(issuer.metadata.jwks_uri, issuer.keys);
  // The ComCom drive: served from the (active, admin) owner's account and shared with ComCom.
  const owner = provision("acc_owner", 1, "admin");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run(ORG_DRIVE, owner, "ComCom", "h", "s");
  orgs.shareDriveWithOrg({ driveId: ORG_DRIVE, issuer: ISSUER, orgId: ORG.id, role: "viewer", actor: "operator" });
});
beforeEach(() => {
  jar.clear();
  oidc.clearDiscoveryCache();
  (globalThis as { __rl_buckets__?: Map<unknown, unknown> }).__rl_buckets__?.clear();
  process.env.AINDRIVE_LEGACY_LOGIN = "false";
});

describe("AIN sign-in landing", () => {
  it("first sign-in → the ComCom drive", async () => {
    provision("acc_new");
    const res = await signIn("acc_new");
    expect(res.status).toBe(303);
    expect(where(res)).toBe(`/d/${ORG_DRIVE}`);
    expect(jar.get("aindrive_session")).toBeTruthy();
  });

  it("no personal drive → the ComCom drive on every later sign-in too", async () => {
    expect(where(await signIn("acc_new"))).toBe(`/d/${ORG_DRIVE}`);
  });

  it("an explicit destination is kept", async () => {
    expect(where(await signIn("acc_new", "/d/elsewhere"))).toBe("/d/elsewhere");
  });

  it("with a personal drive: first sign-in → ComCom drive, afterwards → home", async () => {
    const userId = provision("acc_has_drive");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d-mine", userId, "Mine", "h", "s");
    expect(where(await signIn("acc_has_drive"))).toBe(`/d/${ORG_DRIVE}`);
    expect(where(await signIn("acc_has_drive"))).toBe("/");
  });

  it("a suspended member does not land there (the sign-in itself is refused)", async () => {
    store.applyDesiredState(ISSUER, {
      schema: "ain-sso.adapter.v1", sub: "acc_new", org: ORG, version: 2, status: "suspended",
      profile: { name: null, email: null, workEmail: null }, appRole: null, groups: [], legacyUserId: null, ownershipTransferTo: null, issuedAt: new Date().toISOString(),
    });
    expect(where(await signIn("acc_new"))).toBe("/login?sso_error=account_suspended");
  });

  it("\"connect or create\" (/sso/link) answers the same landing", async () => {
    process.env.AINDRIVE_LEGACY_LOGIN = "true";
    provision("acc_linker");
    expect(where(await signIn("acc_linker"))).toBe("/sso/link"); // a placeholder may still connect a legacy account
    const res = await linkRoute.POST(new Request(`${PUBLIC_URL}/api/auth/sso/link`, {
      method: "POST", headers: { "content-type": "application/json", origin: PUBLIC_URL }, body: JSON.stringify({ method: "new" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `/d/${ORG_DRIVE}` });
  });
});

describe("home page — organization sections come first", () => {
  const src = readFileSync(join(__dirname, "../../app/page.tsx"), "utf8");
  it("renders listOrgDrivesForUser's sections (with an empty state) before the personal drives", () => {
    expect(src).toMatch(/import \{ listOrgDrivesForUser \} from "@\/lib\/orgs\.js"/);
    const orgAt = src.indexOf('data-testid="org-section"');
    expect(orgAt).toBeGreaterThan(0);
    expect(src.indexOf('data-testid="org-empty"')).toBeGreaterThan(orgAt);
    expect(src.indexOf("drives.map((d) =>", orgAt)).toBeGreaterThan(orgAt);
  });
  it("chooses paused / empty / one-line empty through orgSectionState (org-policy.test.ts)", () => {
    expect(src).toMatch(/import \{ orgSectionState \} from "@\/lib\/org-policy\.js"/);
    expect(src).toContain('data-testid="org-paused"');
    expect(src).toMatch(/orgSectionState\(\{ drives: o\.drives\.length, pausedDrives: o\.pausedDrives, hasPersonalDrives: drives\.length > 0 \}\)/);
  });
});
