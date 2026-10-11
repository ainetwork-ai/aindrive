import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ projectId: "prj_1" as string | null, actor: { token: "machine-token", subject: "acc_person" } as { token: string; subject: string } | null }));
const projectSource = vi.hoisted(() => vi.fn());
const projectRun = vi.hoisted(() => vi.fn());
const collect = vi.hoisted(() => vi.fn());
vi.mock("../require-access", () => ({ requireDriveRole: async () => ({ userId: "person", drive: { drive_secret: "drive-secret" } }) }));
vi.mock("../ainui-actor", () => ({ resolveActingCaller: async () => ({ kind: "session" }), gateActingCaller: vi.fn() }));
vi.mock("../git-project-hooks", () => ({ projectHookFor: () => state.projectId ? { projectId: state.projectId, secret: "never-forward-this" } : null }));
vi.mock("../run-ainize", () => ({
  languageFor: () => "python", collectRepoFiles: collect,
  runActorFor: async () => state.actor, runProjectOnAinize: projectRun, projectSourceOnAinize: projectSource, runOnAinize: vi.fn(),
}));
const { POST, GET } = await import("../../app/api/drives/[driveId]/run/route");
const invoke = (body: unknown) => POST(new Request("http://drive.test/api/drives/d1/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ driveId: "d1" }) });
beforeEach(() => { vi.clearAllMocks(); state.projectId = "prj_1"; state.actor = { token: "machine-token", subject: "acc_person" }; projectRun.mockResolvedValue(new Response('event: exit\ndata: {"code":0}\n\n', { headers: { "content-type": "text/event-stream", "x-ainize-execution": "run_1" } })); });

describe("repository version runs", () => {
  it("forwards the pinned commit and original actor to ainize, never reading mutable working files", async () => {
    const sha = "a".repeat(40);
    const res = await invoke({ repo: "repositories/clef", entry: "art_search.py", target: "commit", sha, env: { INPUT_MODEL: "clef" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ainize-execution")).toBe("run_1");
    expect(projectRun.mock.calls[0][0]).toMatchObject({ projectId: "prj_1", target: "commit", sha, entry: "art_search.py", env: { INPUT_MODEL: "clef" }, actor: state.actor });
    expect(JSON.stringify(projectRun.mock.calls)).not.toContain("never-forward-this");
    expect(collect).not.toHaveBeenCalled();
  });
  it("refuses a missing commit, ambiguous SHA, unbound repo or missing identity", async () => {
    const base = { repo: "repositories/clef", entry: "art_search.py" };
    expect((await invoke({ ...base, target: "commit" })).status).toBe(400);
    expect((await invoke({ ...base, target: "deployed", sha: "a".repeat(40) })).status).toBe(400);
    state.projectId = null;
    expect((await invoke({ ...base, target: "deployed" })).status).toBe(409);
    state.projectId = "prj_1"; state.actor = null;
    expect((await invoke({ ...base, target: "deployed" })).status).toBe(401);
    expect(projectRun).not.toHaveBeenCalled();
  });
  it("relays upstream authorization failures rather than falling back to different source files", async () => {
    projectRun.mockResolvedValue(new Response(JSON.stringify({ error: { code: "not_member", message: "membership required" } }), { status: 403, headers: { "content-type": "application/json" } }));
    const res = await invoke({ repo: "repositories/clef", entry: "art_search.py", target: "deployed" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "not_member" } });
    expect(collect).not.toHaveBeenCalled();
  });
});

it('version forms are read as the viewer without reading or executing working files', async () => {
  const sha = 'b'.repeat(40);
  projectSource.mockResolvedValue(Response.json({ sha, manifest: { entry: 'old.py', inputs: { MODEL: { default: 'old-model' } } } }));
  const response = await GET(new Request(`http://drive.test/api/drives/d1/run?repo=repositories%2Fclef&target=commit&sha=${sha}`), { params: Promise.resolve({ driveId: 'd1' }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sha, manifest: { entry: 'old.py' } });
  expect(projectSource.mock.calls[0][0]).toMatchObject({ projectId: 'prj_1', target: 'commit', sha, actor: state.actor });
  expect(collect).not.toHaveBeenCalled();
  expect(projectRun).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
