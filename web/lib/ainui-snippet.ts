/**
 * AIN-UI link snippets (docs/AINUI-LINK-SNIPPETS.md): what a chat shows when a
 * repo or file URL of this aindrive is pasted. Pure builders — no IO, no Next —
 * so the surface shape is testable against the A2UI v0.9 schema on its own.
 *
 * The surface is A2UI v0.9 messages over the BASIC catalog with only the
 * components every consumer renderer already draws for agent answers (Column,
 * Row, Card, Text, Divider, TextField, Button); the envelope's `actions` map
 * says what each button does. Component ids are the contract (§2.1 of the doc).
 */
import { inputEnvName, type ManifestInput } from "./run-inputs";
import type { AinizeDeployment, AinizeProject } from "./ainize-projects";
import { deploymentTime } from "./ainize-projects";
import { relativeTime, shortSha } from "./git-panel";
import type { GitCommit } from "./protocol";

export const AINUI_MEDIA_TYPE = "application/vnd.ain.ui+json";
export const AINUI_ENVELOPE_VERSION = 1;
export const A2UI_VERSION = "v0.9";
export const A2UI_BASIC_CATALOG = "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";

/** `Accept` asks for the snippet (and not for a page): the UI media type is present, `text/html` is not. */
export function wantsAinui(accept: string | null | undefined): boolean {
  const a = (accept ?? "").toLowerCase();
  return a.includes(AINUI_MEDIA_TYPE) && !a.includes("text/html");
}

export type A2uiComponent = { id: string; component: string } & Record<string, unknown>;
export type A2uiMessage =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path: string; value: Record<string, unknown> } };

export type SnippetAction =
  | { method: "GET"; url: string; navigate: true }
  | { method: "POST"; url: string; body: Record<string, unknown>; stream?: "sse"; output?: { path: string; status: string } };

export type SnippetKind = "aindrive.repo" | "aindrive.file" | "denied";

export type AinuiSnippet = {
  ainui: typeof AINUI_ENVELOPE_VERSION;
  kind: SnippetKind;
  title: string;
  subtitle?: string;
  icon?: "git" | "file" | "deploy" | "lock";
  url: string;
  surface: A2uiMessage[];
  actions: Record<string, SnippetAction>;
  refresh?: number;
};

// ------------------------------------------------------------------------------------------ components

const bind = (path: string) => ({ path });
const text = (id: string, t: string | { path: string }, variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body"): A2uiComponent =>
  ({ id, component: "Text", text: t, ...(variant ? { variant } : {}) });
const column = (id: string, children: string[]): A2uiComponent => ({ id, component: "Column", children });
const row = (id: string, children: string[]): A2uiComponent => ({ id, component: "Row", children, align: "center" });
const card = (id: string, child: string): A2uiComponent => ({ id, component: "Card", child });
const divider = (id: string): A2uiComponent => ({ id, component: "Divider" });
/** A button is a Text child + an action naming an entry of the envelope's `actions`. */
function button(id: string, label: string, action: string, opts: { context?: Record<string, unknown>; variant?: "primary" | "borderless" } = {}): A2uiComponent[] {
  return [
    text(`${id}.label`, label),
    { id, component: "Button", child: `${id}.label`, action: { event: { name: action, ...(opts.context ? { context: opts.context } : {}) } }, ...(opts.variant ? { variant: opts.variant } : {}) },
  ];
}

function surface(surfaceId: string, components: A2uiComponent[], data: Record<string, unknown>): A2uiMessage[] {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: data } },
  ];
}

// ------------------------------------------------------------------------------------------ blocks

/**
 * The Run card: one TextField per manifest input bound to `/inputs/<NAME>`, the
 * entry named, ▶ Run → `run` with the answers as `INPUT_<NAME>` context (what the
 * run route takes as `env`), status and output bound to `/run/*`.
 */
export function runBlock(entry: string, inputs: ManifestInput[]): { components: A2uiComponent[]; data: Record<string, unknown>; context: Record<string, unknown> } {
  const comps: A2uiComponent[] = [];
  const fields: string[] = [];
  const inputsData: Record<string, string | string[]> = {};
  const context: Record<string, unknown> = {};
  for (const i of inputs) {
    const id = `run.input.${i.name}`;
    const path = `/inputs/${i.name}`;
    let label = i.description ?? i.name;
    if (i.required) label += " *";
    if (i.type === "choice" && i.options) label += ` (${i.options.join(" | ")})`;
    if (i.type === "boolean") label += " (true | false)";
    const options = i.type === "choice" ? i.options : i.type === "boolean" ? ["true", "false"] : null;
    comps.push(options ? { id, component: "ChoicePicker", label, value: bind(path), variant: "mutuallyExclusive", options: options.map((value) => ({ label: value, value })) } : { id, component: "TextField", label, value: bind(path), ...(i.type === "number" ? { variant: "number" } : {}) });
    fields.push(id);
    inputsData[i.name] = options ? (i.default === null ? [] : [i.default]) : i.default ?? "";
    context[inputEnvName(i.name)] = bind(path);
  }
  comps.push(text("run.entry", `▶ Run ${entry}`, "h5"));
  comps.push(...button("run.button", "Run", "run", { context, variant: "primary" }));
  comps.push(row("run.controls", ["run.entry", "run.button", "run.status"]));
  comps.push(text("run.status", bind("/run/status"), "caption"));
  comps.push(text("run.output", bind("/run/output"), "body"));
  comps.push(column("run.body", [...fields, "run.controls", "run.output"]));
  comps.push(card("run", "run.body"));
  return { components: comps, data: { inputs: inputsData, run: { status: "idle", output: "" } }, context };
}

export type DeploymentRowLinks = { inspect: string | null; visit: string | null };

const DOT: Record<string, string> = { ready: "● ready", building: "● building", queued: "● queued", error: "● error" };

/** The Deployments card: up to 3 static rows (no List templates — their v0.9 spelling differs between renderers). */
export function deploymentsBlock(project: AinizeProject, deployments: AinizeDeployment[], actions: Record<string, SnippetAction>, now = Date.now()): A2uiComponent[] {
  const comps: A2uiComponent[] = [text("deployments.title", `Deployments · ${project.kind} · ${project.branch}`, "h5")];
  const rows: string[] = ["deployments.title"];
  const list = deployments.slice(0, 3);
  if (list.length === 0) {
    comps.push(text("deployments.empty", `No deployments yet — push to ${project.branch}.`, "caption"));
    rows.push("deployments.empty");
  }
  list.forEach((d, n) => {
    const id = `deployments.${n}`;
    const when = deploymentTime(d);
    const label = `${DOT[d.status] ?? `● ${d.status}`}  ${shortSha(d.sha || "")}${d.status === "error" && d.exitCode != null ? ` (exit ${d.exitCode})` : ""}${when ? ` · ${relativeTime(when, now)}` : ""}`;
    const children = [`${id}.text`];
    comps.push(text(`${id}.text`, label, "body"));
    // Inspect goes to the project page (the log endpoint needs the owner's ainize session), as the git panel does.
    const inspect = project.pageUrl || d.logUrl;
    if (inspect) { actions[`open:inspect:${n}`] = { method: "GET", url: inspect, navigate: true }; comps.push(...button(`${id}.inspect`, "Inspect", `open:inspect:${n}`, { variant: "borderless" })); children.push(`${id}.inspect`); }
    if (d.status === "ready" && d.outputUrl) { actions[`open:visit:${n}`] = { method: "GET", url: d.outputUrl, navigate: true }; comps.push(...button(`${id}.visit`, "Visit", `open:visit:${n}`, { variant: "borderless" })); children.push(`${id}.visit`); }
    comps.push(row(id, children));
    rows.push(id);
  });
  comps.push(column("deployments.body", rows));
  comps.push(card("deployments", "deployments.body"));
  return comps;
}

// ------------------------------------------------------------------------------------------ snippets

export type RepoSnippetInput = {
  org: string;
  repo: string;
  branch: string;
  head: GitCommit | null;
  /** canonical page URL of the repo (absolute) */
  pageUrl: string;
  /** the Run block, when `ainize.json` (or a runnable root file) says what to run */
  run: { entry: string; inputs: ManifestInput[]; endpoint: string; repoPath: string } | null;
  /** the bound ainize project and its newest deployments, when known */
  ainize: { project: AinizeProject; deployments: AinizeDeployment[]; pageUrl: string } | null;
  now?: number;
};

export function repoSnippet(i: RepoSnippetInput): AinuiSnippet {
  const actions: Record<string, SnippetAction> = { "open:aindrive": { method: "GET", url: i.pageUrl, navigate: true } };
  const comps: A2uiComponent[] = [];
  const sections: string[] = ["header"];
  const headSub = i.head ? `${shortSha(i.head.sha)} ${i.head.subject}` : "no commits yet";
  comps.push(text("header.title", `${i.org}/${i.repo}`, "h4"), text("header.sub", `${i.branch} · ${headSub}`, "caption"), row("header", ["header.title", "header.sub"]));
  let data: Record<string, unknown> = {};
  if (i.run) {
    const r = runBlock(i.run.entry, i.run.inputs);
    comps.push(...r.components);
    data = { ...data, ...r.data };
    actions.run = { method: "POST", url: i.run.endpoint, body: { repo: i.run.repoPath, entry: i.run.entry, env: { $context: true } }, stream: "sse", output: { path: "/run/output", status: "/run/status" } };
    sections.push("run");
  }
  if (i.ainize) {
    comps.push(...deploymentsBlock(i.ainize.project, i.ainize.deployments, actions, i.now));
    sections.push("deployments");
  }
  const links = [...button("links.aindrive", "Open in aindrive", "open:aindrive", { variant: "borderless" })];
  const linkIds = ["links.aindrive"];
  if (i.ainize) {
    actions["open:inspect"] = { method: "GET", url: i.ainize.pageUrl, navigate: true };
    links.push(...button("links.ainize", "Project on ainize", "open:inspect", { variant: "borderless" }));
    linkIds.push("links.ainize");
  }
  comps.push(...links, divider("links.divider"), row("links", linkIds));
  sections.push("links.divider", "links");
  comps.push(column("root", sections));
  return {
    ainui: AINUI_ENVELOPE_VERSION, kind: "aindrive.repo", icon: "git",
    title: `${i.org}/${i.repo}`, subtitle: `${i.branch} · ${headSub}`, url: i.pageUrl,
    surface: surface("aindrive.repo", comps, data), actions, ...(i.ainize ? { refresh: 30 } : {}),
  };
}

export const FILE_PREVIEW_LINES = 40;
export const FILE_PREVIEW_BYTES = 8 * 1024;

/** The first lines of a file, bounded in lines and bytes; says how much was left out. */
export function previewOf(content: string): { text: string; truncated: boolean } {
  const lines = content.split("\n");
  let out = lines.slice(0, FILE_PREVIEW_LINES).join("\n");
  let truncated = lines.length > FILE_PREVIEW_LINES;
  if (Buffer.byteLength(out, "utf8") > FILE_PREVIEW_BYTES) { out = Buffer.from(out, "utf8").subarray(0, FILE_PREVIEW_BYTES).toString("utf8").replace(/�$/, ""); truncated = true; }
  return { text: out, truncated };
}

export type FileSnippetInput = {
  org: string;
  repo: string;
  ref: string;
  path: string;
  /** utf-8 text, or null for a binary file */
  content: string | null;
  size: number;
  pageUrl: string;
  rawUrl: string;
  run: { inputs: ManifestInput[]; endpoint: string; repoPath: string } | null;
};

export function fileSnippet(i: FileSnippetInput): AinuiSnippet {
  const actions: Record<string, SnippetAction> = {
    "open:aindrive": { method: "GET", url: i.pageUrl, navigate: true },
    "open:raw": { method: "GET", url: i.rawUrl, navigate: true },
  };
  const comps: A2uiComponent[] = [];
  const sections = ["header", "file.code"];
  const name = i.path.slice(i.path.lastIndexOf("/") + 1);
  comps.push(text("header.title", i.path, "h4"), text("header.sub", `${i.org}/${i.repo} @ ${i.ref} · ${humanBytes(i.size)}`, "caption"), row("header", ["header.title", "header.sub"]));
  if (i.content === null) comps.push(text("file.code", `${name} is a binary file (${humanBytes(i.size)}).`, "caption"));
  else {
    const p = previewOf(i.content);
    comps.push(text("file.code", p.text + (p.truncated ? `\n… (first ${FILE_PREVIEW_LINES} lines; open the file for the rest)` : ""), "body"));
  }
  let data: Record<string, unknown> = {};
  if (i.run) {
    const r = runBlock(i.path, i.run.inputs);
    comps.push(...r.components);
    data = { ...data, ...r.data };
    actions.run = { method: "POST", url: i.run.endpoint, body: { repo: i.run.repoPath, entry: i.path, env: { $context: true } }, stream: "sse", output: { path: "/run/output", status: "/run/status" } };
    sections.push("run");
  }
  comps.push(...button("links.aindrive", "Open", "open:aindrive", { variant: "borderless" }), ...button("links.raw", "Raw", "open:raw", { variant: "borderless" }), divider("links.divider"), row("links", ["links.aindrive", "links.raw"]));
  sections.push("links.divider", "links");
  comps.push(column("root", sections));
  return {
    ainui: AINUI_ENVELOPE_VERSION, kind: "aindrive.file", icon: "file",
    title: i.path, subtitle: `${i.org}/${i.repo} @ ${i.ref}`, url: i.pageUrl,
    surface: surface("aindrive.file", comps, data), actions,
  };
}

/** The 403 body: one sentence and a link, so the chat still shows something clickable (doc §4). */
export function deniedSnippet(host: string, what: string, pageUrl: string): AinuiSnippet {
  const comps: A2uiComponent[] = [
    text("denied.text", `Sign in to ${host} or ask for access to ${what}.`, "body"),
    ...button("links.aindrive", "Open", "open:aindrive", { variant: "borderless" }),
    row("links", ["links.aindrive"]),
    column("root", ["denied.text", "links"]),
  ];
  return {
    ainui: AINUI_ENVELOPE_VERSION, kind: "denied", icon: "lock", title: what, subtitle: "no access", url: pageUrl,
    surface: surface("denied", comps, {}), actions: { "open:aindrive": { method: "GET", url: pageUrl, navigate: true } },
  };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The snippet as an HTTP response body + headers (the route and tests share it). */
export function snippetResponse(s: AinuiSnippet, status = 200): Response {
  return new Response(JSON.stringify(s), { status, headers: { "Content-Type": AINUI_MEDIA_TYPE, "Cache-Control": "private, no-store", Vary: "Accept, Authorization, X-AIN-Actor" } });
}
