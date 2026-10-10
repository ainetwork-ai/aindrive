// The AIN-UI link snippet builders (lib/ainui-snippet.ts, docs/AINUI-LINK-SNIPPETS.md):
// every surface they emit validates against the A2UI v0.9 message schema with the
// BASIC catalog (the official JSON schemas shipped in @a2ui/web_core), every button
// names an action of the envelope, and the ids the doc promises are there.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import {
  AINUI_MEDIA_TYPE, A2UI_BASIC_CATALOG, deniedSnippet, fileSnippet, previewOf, repoSnippet, runBlock, wantsAinui, type A2uiComponent, type AinuiSnippet,
} from "../ainui-snippet";
import type { ManifestInput } from "../run-inputs";

// @a2ui/web_core ships the official schemas in its source tree (not an export): read them from the package directory.
const schemas = fileURLToPath(new URL("../../node_modules/@a2ui/web_core/src/v0_9/schemas/", import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(join(schemas, p), "utf8"));
// `discriminator` (OpenAPI-style) is left as an annotation: the catalog's alternatives use allOf, which ajv's
// discriminator cannot read; the `component: const` in each alternative makes the oneOf decide on its own.
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("uri", true);
ajv.addSchema(load("common_types.json"));
const basic = load("catalogs/basic/catalog.json");
ajv.addSchema(basic);
// server_to_client.json refers to `catalog.json` relative to itself: the catalog of the surface, i.e. the basic one.
ajv.addSchema({ ...basic, $id: "https://a2ui.org/specification/v0_9/catalog.json" });
const validateMessage = ajv.compile(load("server_to_client.json"));

/** Structural rules the schema cannot say: one root, ids unique, every reference resolves, every button has an action. */
function checkSurface(s: AinuiSnippet) {
  for (const m of s.surface) {
    const ok = validateMessage(m);
    expect(ok, JSON.stringify(validateMessage.errors?.slice(0, 3), null, 1)).toBe(true);
  }
  const create = s.surface.find((m) => "createSurface" in m)!;
  expect(create && "createSurface" in create && create.createSurface.catalogId).toBe(A2UI_BASIC_CATALOG);
  const comps = (s.surface.find((m) => "updateComponents" in m) as { updateComponents: { components: A2uiComponent[] } }).updateComponents.components;
  const ids = comps.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("root");
  for (const c of comps) {
    const refs = [...(Array.isArray(c.children) ? (c.children as string[]) : []), ...(typeof c.child === "string" ? [c.child] : [])];
    for (const r of refs) expect(ids, `${c.id} → ${r}`).toContain(r);
    if (c.component === "Button") {
      const name = (c.action as { event: { name: string } }).event.name;
      expect(Object.keys(s.actions), `button ${c.id}`).toContain(name);
    }
  }
  // Only the vocabulary every consumer renderer already draws (doc §2.1).
  for (const c of comps) expect(["Column", "Row", "Card", "Text", "Divider", "TextField", "Button"]).toContain(c.component);
  return comps;
}

const INPUTS: ManifestInput[] = [
  { name: "DESC", description: "작품 묘사", type: "string", required: true, options: null, default: "a quiet harbour" },
  { name: "MODEL", description: null, type: "choice", required: false, options: ["clef-flash", "clef"], default: "clef-flash" },
  { name: "TOP_K", description: "how many", type: "number", required: false, options: null, default: "5" },
];
const PROJECT = { id: "prj_1", org: "comcom", repoName: "clef", repo: "https://drive.example.test/comcom/git/clef", branch: "main", kind: "script", status: "ready", url: "https://ainize.example/comcom/clef", pageUrl: "https://ainize.example/projects/prj_1" };
const DEPLOYS = [
  { id: "dep_3", sha: "cccccccc1", status: "building" as const, startedAt: 1_000_000, logUrl: "https://ainize.example/api/deployments/dep_3/log" },
  { id: "dep_2", sha: "bbbbbbbb1", status: "ready" as const, finishedAt: 900_000, outputUrl: "https://ainize.example/api/deployments/dep_2/output" },
  { id: "dep_1", sha: "aaaaaaaa1", status: "error" as const, finishedAt: 800_000, exitCode: 1 },
  { id: "dep_0", sha: "99999999", status: "ready" as const, finishedAt: 700_000 },
];
const RUN = { entry: "art_search.py", inputs: INPUTS, endpoint: "https://drive.example.test/api/drives/d1/run", repoPath: "repositories/clef" };

describe("the schema check itself", () => {
  it("rejects what the catalog forbids, so a green run means something", () => {
    const msg = (components: unknown[]) => ({ version: "v0.9", updateComponents: { surfaceId: "s", components } });
    expect(validateMessage(msg([{ id: "root", component: "Text", text: "ok" }]))).toBe(true);
    expect(validateMessage(msg([{ id: "b", component: "Button" }]))).toBe(false); // no child, no action
    expect(validateMessage(msg([{ id: "t", component: "Text", text: "x", colour: "red" }]))).toBe(false); // unknown property
    expect(validateMessage(msg([{ id: "f", component: "TextField", value: "x" }]))).toBe(false); // label required
    expect(validateMessage({ version: "v0.8", createSurface: { surfaceId: "s", catalogId: "c" } })).toBe(false);
  });
});

describe("negotiation", () => {
  it("is the UI media type in Accept, and never a browser", () => {
    expect(wantsAinui(AINUI_MEDIA_TYPE)).toBe(true);
    expect(wantsAinui(`application/json, ${AINUI_MEDIA_TYPE};q=0.9`)).toBe(true);
    expect(wantsAinui("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(false);
    expect(wantsAinui(`text/html, ${AINUI_MEDIA_TYPE}`)).toBe(false);
    expect(wantsAinui("application/json")).toBe(false);
    expect(wantsAinui(null)).toBe(false);
  });
});

describe("repo snippet", () => {
  const s = repoSnippet({ org: "comcom", repo: "clef", branch: "main", head: { sha: "0123456789abcdef", subject: "run as the person", author: "Ann", date: "2026-10-10" }, pageUrl: "https://drive.example.test/comcom/git/clef", run: RUN, ainize: { project: PROJECT, deployments: DEPLOYS, pageUrl: PROJECT.pageUrl }, now: 2_000_000 });

  it("validates against A2UI v0.9 + basic catalog and uses the promised ids", () => {
    const comps = checkSurface(s);
    const ids = comps.map((c) => c.id);
    for (const id of ["header", "run", "run.button", "run.status", "run.output", "run.input.DESC", "run.input.MODEL", "run.input.TOP_K", "deployments", "deployments.0", "deployments.1", "deployments.2", "links"]) expect(ids).toContain(id);
    expect(ids).not.toContain("deployments.3"); // three rows at most
    expect(s).toMatchObject({ ainui: 1, kind: "aindrive.repo", title: "comcom/clef", subtitle: "main · 0123456 run as the person", icon: "git", refresh: 30 });
  });

  it("renders the inputs from the manifest with defaults and binds them to the run action's env", () => {
    const comps = checkSurface(s);
    const desc = comps.find((c) => c.id === "run.input.DESC")!;
    expect(desc).toMatchObject({ component: "TextField", label: "작품 묘사 *", value: { path: "/inputs/DESC" } });
    expect(comps.find((c) => c.id === "run.input.MODEL")).toMatchObject({ label: "MODEL (clef-flash | clef)" });
    expect(comps.find((c) => c.id === "run.input.TOP_K")).toMatchObject({ variant: "number" });
    const data = (s.surface[2] as { updateDataModel: { value: Record<string, unknown> } }).updateDataModel.value;
    expect(data).toEqual({ inputs: { DESC: "a quiet harbour", MODEL: "clef-flash", TOP_K: "5" }, run: { status: "idle", output: "" } });
    const button = comps.find((c) => c.id === "run.button")!;
    expect(button.action).toEqual({ event: { name: "run", context: { INPUT_DESC: { path: "/inputs/DESC" }, INPUT_MODEL: { path: "/inputs/MODEL" }, INPUT_TOP_K: { path: "/inputs/TOP_K" } } } });
    expect(s.actions.run).toEqual({ method: "POST", url: RUN.endpoint, body: { repo: "repositories/clef", entry: "art_search.py", env: { $context: true } }, stream: "sse", output: { path: "/run/output", status: "/run/status" } });
    expect(comps.find((c) => c.id === "run.output")).toMatchObject({ component: "Text", text: { path: "/run/output" } });
  });

  it("shows the newest three deployments with status dots and Visit / Inspect links", () => {
    const comps = checkSurface(s);
    const texts = [0, 1, 2].map((n) => comps.find((c) => c.id === `deployments.${n}.text`)!.text as string);
    expect(texts[0]).toMatch(/^● building {2}ccccccc · /);
    expect(texts[1]).toMatch(/^● ready {2}bbbbbbb · /);
    expect(texts[2]).toMatch(/^● error {2}aaaaaaa \(exit 1\) · /);
    expect(s.actions["open:visit:1"]).toEqual({ method: "GET", url: DEPLOYS[1].outputUrl, navigate: true });
    expect(s.actions["open:visit:0"]).toBeUndefined(); // only a ready deployment has somewhere to visit
    expect(s.actions["open:inspect:0"]).toEqual({ method: "GET", url: PROJECT.pageUrl, navigate: true });
    expect(s.actions["open:inspect"]).toEqual({ method: "GET", url: PROJECT.pageUrl, navigate: true });
    expect(s.actions["open:aindrive"]).toEqual({ method: "GET", url: "https://drive.example.test/comcom/git/clef", navigate: true });
  });

  it("leaves the Run and Deployments blocks out when there is nothing to run or no project", () => {
    const bare = repoSnippet({ org: "comcom", repo: "notes", branch: "main", head: null, pageUrl: "https://drive.example.test/comcom/git/notes", run: null, ainize: null });
    const ids = checkSurface(bare).map((c) => c.id);
    expect(ids).not.toContain("run");
    expect(ids).not.toContain("deployments");
    expect(Object.keys(bare.actions)).toEqual(["open:aindrive"]);
    expect(bare.subtitle).toBe("main · no commits yet");
    expect(bare.refresh).toBeUndefined();
    const empty = repoSnippet({ ...{ org: "comcom", repo: "clef", branch: "main", head: null, pageUrl: "x://p", run: null }, ainize: { project: PROJECT, deployments: [], pageUrl: PROJECT.pageUrl } });
    expect(checkSurface(empty).find((c) => c.id === "deployments.empty")?.text).toBe("No deployments yet — push to main.");
  });

  it("carries no secrets: the serialized envelope names only the action URLs, never env values or tokens", () => {
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/whsec_|aind_aat_|Bearer|secret/i);
  });
});

describe("file snippet", () => {
  const code = Array.from({ length: 60 }, (_, i) => `print(${i})`).join("\n");
  const s = fileSnippet({ org: "comcom", repo: "clef", ref: "main", path: "art_search.py", content: code, size: 600, pageUrl: "https://drive.example.test/comcom/git/clef/blob/main/art_search.py", rawUrl: "https://drive.example.test/comcom/git/clef/raw/main/art_search.py", run: { inputs: INPUTS, endpoint: RUN.endpoint, repoPath: RUN.repoPath } });

  it("previews the first 40 lines and says the rest was left out", () => {
    const comps = checkSurface(s);
    const text = comps.find((c) => c.id === "file.code")!.text as string;
    expect(text.split("\n").length).toBe(41);
    expect(text).toMatch(/^print\(0\)\n/);
    expect(text).toMatch(/print\(39\)\n… \(first 40 lines/);
    expect(previewOf("a\nb").truncated).toBe(false);
    expect(previewOf("x".repeat(10_000)).text.length).toBeLessThanOrEqual(8 * 1024);
  });

  it("runs THIS file: the run action's entry is the path; the links open the blob and the raw bytes", () => {
    expect(s.actions.run).toMatchObject({ method: "POST", body: { repo: "repositories/clef", entry: "art_search.py", env: { $context: true } }, stream: "sse" });
    expect(s.actions["open:aindrive"].url).toMatch(/\/blob\/main\/art_search\.py$/);
    expect(s.actions["open:raw"].url).toMatch(/\/raw\/main\/art_search\.py$/);
    expect(s).toMatchObject({ kind: "aindrive.file", icon: "file", title: "art_search.py" });
  });

  it("says so for a binary file, and offers no Run when the file is not runnable", () => {
    const bin = fileSnippet({ org: "comcom", repo: "clef", ref: "main", path: "logo.png", content: null, size: 2048, pageUrl: "x://p", rawUrl: "x://r", run: null });
    const comps = checkSurface(bin);
    expect(comps.find((c) => c.id === "file.code")!.text).toBe("logo.png is a binary file (2.0 KB).");
    expect(comps.map((c) => c.id)).not.toContain("run");
    expect(bin.actions.run).toBeUndefined();
  });
});

describe("denied snippet", () => {
  it("is one sentence and a link — and still a valid surface", () => {
    const s = deniedSnippet("drive.example.test", "comcom/clef", "https://drive.example.test/comcom/git/clef");
    const comps = checkSurface(s);
    expect(comps.find((c) => c.id === "denied.text")!.text).toBe("Sign in to drive.example.test or ask for access to comcom/clef.");
    expect(s).toMatchObject({ kind: "denied", icon: "lock", actions: { "open:aindrive": { navigate: true } } });
  });
});

describe("runBlock", () => {
  it("has no input fields and an empty context when the manifest declares none", () => {
    const r = runBlock("main.py", []);
    expect(r.context).toEqual({});
    expect(r.components.find((c) => c.id === "run.button")!.action).toEqual({ event: { name: "run", context: {} } });
    expect(r.data).toEqual({ inputs: {}, run: { status: "idle", output: "" } });
  });
});
