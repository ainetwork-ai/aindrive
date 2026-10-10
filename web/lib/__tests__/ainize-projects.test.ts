// lib/ainize-projects.ts: the browser-side reader behind the Deployments block.
// Every failure mode (404 no project, CORS/network error, odd shapes) degrades
// to null / [] so the panel never shows an error.
import { describe, it, expect, vi } from "vitest";
import { fetchProjectByRepo, fetchDeployments, connectProjectUrl, deploymentLogUrl, deploymentTime } from "../ainize-projects";

const A = "https://ainize.example.test";
const REPO = "https://drive.example.test/comcom/git/clef";
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchProjectByRepo", () => {
  it("asks by-repo with the encoded clone URL and returns the project", async () => {
    const f = vi.fn(async () => ok({ id: "prj_1", repo: REPO, branch: "main", kind: "script", status: "ready" }));
    const p = await fetchProjectByRepo(A, REPO, f as unknown as typeof fetch);
    expect(p?.id).toBe("prj_1");
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${A}/api/projects/by-repo?repo=${encodeURIComponent(REPO)}`);
  });
  it("404, a CORS/network failure and non-JSON all answer null", async () => {
    expect(await fetchProjectByRepo(A, REPO, (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchProjectByRepo(A, REPO, (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchProjectByRepo(A, REPO, (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("fetchDeployments", () => {
  it("accepts a bare array or {deployments}, newest first, capped", async () => {
    const list = Array.from({ length: 7 }, (_, i) => ({ id: `dep_${i}`, sha: "a".repeat(40), status: i === 0 ? "building" : "ready" }));
    expect((await fetchDeployments(A, "prj_1", (async () => ok(list)) as unknown as typeof fetch)).map((d) => d.id)).toEqual(["dep_0", "dep_1", "dep_2", "dep_3", "dep_4"]);
    expect((await fetchDeployments(A, "prj_1", (async () => ok({ deployments: list.slice(0, 2) })) as unknown as typeof fetch)).length).toBe(2);
    expect(await fetchDeployments(A, "prj_1", (async () => new Response("", { status: 500 })) as unknown as typeof fetch)).toEqual([]);
    expect(await fetchDeployments(A, "prj_1", (async () => ok({ nope: 1 })) as unknown as typeof fetch)).toEqual([]);
  });
});

describe("links", () => {
  it("connect, inspect and time", () => {
    expect(connectProjectUrl(A, REPO)).toBe(`${A}/projects/new?repo=${encodeURIComponent(REPO)}`);
    expect(deploymentLogUrl(A, { id: "dep 1", sha: "", status: "ready" })).toBe(`${A}/api/deployments/dep%201/log`);
    expect(deploymentLogUrl(A, { id: "x", sha: "", status: "ready", logUrl: "https://l/og" })).toBe("https://l/og");
    expect(deploymentTime({ id: "x", sha: "", status: "ready", startedAt: "2026-10-10T00:00:00Z", finishedAt: "2026-10-10T00:01:00Z" })).toBe("2026-10-10T00:01:00Z");
    expect(deploymentTime({ id: "x", sha: "", status: "queued", startedAt: 0 })).toBe("1970-01-01T00:00:00.000Z");
    expect(deploymentTime({ id: "x", sha: "", status: "queued" })).toBe("");
  });
});
