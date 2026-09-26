// web/lib/__tests__/willow-ainmem-routes.test.ts
// The HTTP side of ainmem's entries: ainmem's server calls these with the person's
// session JWT as a bearer (ainmem docs/willow-ainmem-plan.md Tasks 3 and 5).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-ainmem-routes-"));
const roles: Record<string, string> = { "u-ed": "editor", "u-view": "viewer" };
vi.mock("@/lib/willow/roles", () => ({
  roleOf: (_d: string, u: string | null) => (u ? roles[u] ?? "none" : "none"),
  isMember: (_d: string, u: string | null) => !!u && !!roles[u],
  paywalled: () => false,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { db } = await import("@/lib/db.js");
for (const id of ["u-ed", "u-view", "u-none"]) db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, `${id}@example.com`, id, "x");
const { sign } = await import("@/lib/session");
const ingest = await import("@/app/api/willow/ingest/route");
const authors = await import("@/app/api/willow/ainmem-authors/route");
const cert = await import("@/app/api/willow/cert/route");
const { generateDeviceKey } = await import("@/shared/willow/keys");
const { toHex } = await import("@/shared/willow/bytes");

const bearer = async (u: string) => ({ authorization: `Bearer ${await sign(u)}`, "content-type": "application/json" });

describe("ainmem routes", () => {
  it("certifies a device for the bearer's user", async () => {
    const kp = await generateDeviceKey();
    const res = await cert.POST(new Request("http://x/api/willow/cert", { method: "POST", headers: await bearer("u-view"), body: JSON.stringify({ deviceKey: toHex(kp.publicKey), label: "ainmem browser" }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).cert).toMatchObject({ userId: "u-view", deviceKey: toHex(kp.publicKey) });
  });
  it("refuses an invalid bearer instead of falling back to the cookie", async () => {
    const res = await cert.POST(new Request("http://x/api/willow/cert", { method: "POST", headers: { authorization: "Bearer nope" }, body: JSON.stringify({ deviceKey: "0".repeat(64) }) }));
    expect(res.status).toBe(401);
  });
  it("ingest: 401 without a user, one verdict per entry for an editor", async () => {
    expect((await ingest.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ drive: "dR", entries: [] }) }))).status).toBe(401);
    const res = await ingest.POST(new Request("http://x", { method: "POST", headers: await bearer("u-ed"), body: JSON.stringify({ drive: "dR", entries: [{ bad: 1 }] }) }));
    expect(await res.json()).toEqual({ results: ["malformed"] });
    const big = await ingest.POST(new Request("http://x", { method: "POST", headers: await bearer("u-ed"), body: JSON.stringify({ drive: "dR", entries: new Array(201).fill({}) }) }));
    expect(big.status).toBe(413);
  });
  it("authors: readers of the drive only", async () => {
    const url = "http://x/api/willow/ainmem-authors?drive=dR&teamspace=t&page=p";
    expect((await authors.GET(new Request(url, { headers: await bearer("u-none") }))).status).toBe(403);
    const ok = await authors.GET(new Request(url, { headers: await bearer("u-view") }));
    expect(await ok.json()).toEqual({ authors: [] });
  });
});
