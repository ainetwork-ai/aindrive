import { beforeEach, expect, it, vi } from "vitest";
import { fileSnippet, repoSnippet } from "../ainui-snippet";

const runtime = vi.hoisted(() => ({ actor: vi.fn(), source: vi.fn() }));
vi.mock("../run-ainize", () => ({ runActorFor: runtime.actor, projectSourceOnAinize: runtime.source }));
const { pinnedSnippetSource } = await import("../ainui-snippet-source");
const sha = "a".repeat(40);
beforeEach(() => { vi.clearAllMocks(); runtime.actor.mockResolvedValue({ subject: "viewer", token: "machine" }); });

it("uses the viewer and the displayed commit's input declarations", async () => {
  runtime.source.mockResolvedValue(Response.json({ sha, manifest: { kind: "script", entry: "old.py", inputs: { MODEL: { type: "choice", options: ["old-model"], default: "old-model" } } } }));
  const source = await pinnedSnippetSource("project", "viewer-id", sha);
  expect(runtime.actor).toHaveBeenCalledWith("viewer-id");
  expect(runtime.source.mock.calls[0][0]).toMatchObject({ projectId: "project", target: "commit", sha, actor: { subject: "viewer" } });
  expect(source?.inputs[0].options).toEqual(["old-model"]);
  const run = { ...source!, endpoint: "https://drive.test/run", repoPath: "repositories/repo" };
  const file = fileSnippet({ org: "org", repo: "repo", ref: "old", path: "old.py", content: "print('old')", size: 12, pageUrl: "https://drive.test/file", rawUrl: "https://drive.test/raw", run });
  const repo = repoSnippet({ org: "org", repo: "repo", branch: "main", head: null, pageUrl: "https://drive.test/repo", ainize: null, run });
  for (const snippet of [file, repo]) {
    expect(snippet.actions.run).toMatchObject({ body: { target: "commit", sha, entry: "old.py" } });
    expect(JSON.stringify(snippet.surface)).toContain("Commit aaaaaaa");
  }
});

it("refuses missing actors, denied sources, mismatched commits and non-script versions", async () => {
  runtime.actor.mockResolvedValueOnce(null);
  expect(await pinnedSnippetSource("project", null, sha)).toBeNull();
  expect(runtime.source).not.toHaveBeenCalled();
  for (const response of [Response.json({}, { status: 403 }), Response.json({ sha: "b".repeat(40), manifest: { kind: "script", entry: "wrong.py" } }), Response.json({ sha, manifest: { kind: "docker", entry: "service.py" } })]) {
    runtime.source.mockResolvedValueOnce(response);
    expect(await pinnedSnippetSource("project", "viewer", sha)).toBeNull();
  }
});
