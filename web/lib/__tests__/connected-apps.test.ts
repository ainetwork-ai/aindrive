import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway dir BEFORE importing db.js (it opens on import).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-apps-"));

const { db } = await import("../db.js");
const { checkSpacesUrl, upsertApp, listApps, removeApp, spacesForFolder, setFolderShared } = await import("../connected-apps");

beforeAll(() => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u1", "a@example.com", "A", "x");
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u2", "b@example.com", "B", "x");
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AINDRIVE_APPS_ALLOW_PRIVATE;
});

describe("checkSpacesUrl", () => {
  it("refuses what this server must not fetch", async () => {
    expect(await checkSpacesUrl("http://example.com/x")).toBe("url must be https");
    expect(await checkSpacesUrl("https://localhost/x")).toBe("url must be a public address");
    expect(await checkSpacesUrl("https://127.0.0.1/x")).toBe("url must be a public address");
    expect(await checkSpacesUrl("https://10.1.2.3/x")).toBe("url must be a public address");
    expect(await checkSpacesUrl("https://[::1]/x")).toBe("url must be a public address");
    expect(await checkSpacesUrl("https://u:p@8.8.8.8/x")).toBe("url must not carry credentials or a fragment");
    expect(await checkSpacesUrl(42)).toBe("url required");
  });
  it("takes a public https address, and local ones only when allowed", async () => {
    expect(await checkSpacesUrl("https://8.8.8.8/api/spaces")).toBeInstanceOf(URL);
    process.env.AINDRIVE_APPS_ALLOW_PRIVATE = "1";
    expect(await checkSpacesUrl("http://127.0.0.1:3000/api/spaces")).toBeInstanceOf(URL);
  });
});

describe("connected apps", () => {
  it("keeps one row per app origin, per account", () => {
    const a = upsertApp("u1", { name: "ainmem", url: new URL("https://8.8.8.8/api/aindrive-app/spaces"), key: "k".repeat(20) });
    const again = upsertApp("u1", { name: "ainmem 2", url: new URL("https://8.8.8.8/api/aindrive-app/spaces"), key: "j".repeat(20) });
    expect(again.id).toBe(a.id);
    expect(listApps("u1")).toEqual([{ id: a.id, name: "ainmem 2", origin: "https://8.8.8.8" }]);
    expect(listApps("u2")).toEqual([]);
    expect(removeApp("u2", a.id)).toBe(false);
  });

  it("asks the app with its key, and relays a toggle", async () => {
    const [app] = listApps("u1");
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "GET")
        return new Response(JSON.stringify({ spaces: [{ id: "ts1", name: "Our Family", shared: true }, { bad: 1 }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const got = await spacesForFolder("u1", "d1", "photos");
    expect(got).toEqual([{ app, spaces: [{ id: "ts1", name: "Our Family", shared: true }] }]);
    expect(calls[0].url).toBe("https://8.8.8.8/api/aindrive-app/spaces?driveId=d1&path=photos");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${"j".repeat(20)}`);
    expect(await setFolderShared("u1", app.id, "ts1", { driveId: "d1", path: "photos", shared: false })).toEqual({ ok: true });
    expect(calls[1].url).toBe("https://8.8.8.8/api/aindrive-app/spaces/ts1");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ driveId: "d1", path: "photos", shared: false });
    expect(await setFolderShared("u2", app.id, "ts1", { driveId: "d1", path: "", shared: true })).toMatchObject({ ok: false, status: 404 });
  });

  it("reports an app that does not answer instead of failing the sheet", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    const [r] = await spacesForFolder("u1", "d1", "");
    expect(r.spaces).toEqual([]);
    expect(r.error).toMatch(/did not answer/);
  });
});
