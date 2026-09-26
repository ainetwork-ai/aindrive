/**
 * MCP Apps (SEP-1865, io.modelcontextprotocol/ui) view for aindrive's MCP
 * endpoints: ONE `ui://` resource — a sandboxed HTML app that renders the A2UI
 * surface every tool result carries in `_meta[A2UI_META_KEY]`
 * (shared/a2ui/index.ts). Hosts that support MCP Apps (Claude, ChatGPT, VS Code,
 * Goose, …) show a real file browser / preview / search UI with zero work from
 * the integrator; clicks go back through the host's authenticated MCP session
 * via `tools/call a2ui_action`, so the iframe never holds credentials.
 *
 * The HTML inlines two files read from disk once per process:
 *   - @modelcontextprotocol/ext-apps `app-with-deps.js` (official App SDK
 *     bundle; its trailing `export {…}` is rewritten to a global)
 *   - shared/a2ui/renderer.js (our dependency-free A2UI renderer)
 * Both ship in the runtime image (Dockerfile copies node_modules + shared/).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

export const MCP_APP_URI = "ui://aindrive/browser";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** `_meta.ui` for tools whose result the view renders. */
export const MCP_APP_TOOL_META = { ui: { resourceUri: MCP_APP_URI, visibility: ["model", "app"] } } as const;
/** `_meta.ui` for tools only the view calls (hidden from the model). */
export const MCP_APP_ONLY_META = { ui: { resourceUri: MCP_APP_URI, visibility: ["app"] } } as const;
export const MCP_APP_RESOURCE_META = { ui: { prefersBorder: true } } as const;

let cachedHtml: string | null = null;

/** Rewrite the bundle's final `export{…,X as App,…}` into `globalThis.__mcpExtApps = { App: X }`. */
export function exposeAppGlobal(bundle: string): string {
  const m = bundle.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error("ext-apps bundle: trailing export clause not found");
  const app = m[1].split(",").map((s) => s.trim()).find((s) => /\bas\s+App$/.test(s));
  if (!app) throw new Error("ext-apps bundle: `App` export not found");
  const local = app.replace(/\s+as\s+App$/, "").trim();
  return `${bundle.slice(0, m.index)}globalThis.__mcpExtApps={App:${local}};`;
}

function root(...p: string[]) {
  return join(process.cwd(), ...p);
}

export function mcpAppHtml(): string {
  if (cachedHtml) return cachedHtml;
  const bundle = exposeAppGlobal(
    readFileSync(root("node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"), "utf8"),
  );
  const renderer = readFileSync(createRequire(import.meta.url).resolve("ain-ui/renderer"), "utf8");
  const css = renderer.match(/A2UI_RENDERER_CSS = `([\s\S]*?)`;/)?.[1] ?? "";
  const rendererCode = renderer.replace(/export const A2UI_RENDERER_CSS[\s\S]*$/, "").replace(/^export /gm, "");
  // `</script` inside inlined JS would end the tag early.
  const safe = (js: string) => js.replace(/<\/script/gi, "<\\/script");
  cachedHtml = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>aindrive</title>
<style>body{margin:0;padding:12px;background:transparent}${css}.aindrive-status{font:13px system-ui,sans-serif;color:#54607a}</style>
</head><body>
<div id="app"><p class="aindrive-status">Loading aindrive…</p></div>
<script type="module">${safe(bundle)}</script>
<script type="module">
${safe(rendererCode)}
const META_KEY = "ai.aindrive/a2ui";
const appEl = document.getElementById("app");
const status = (t) => { const p = document.createElement("p"); p.className = "aindrive-status"; p.textContent = t; appEl.replaceChildren(p); };
const { App } = globalThis.__mcpExtApps;
const app = new App({ name: "aindrive", version: "1.0.0" });
const view = createA2uiRenderer(appEl, {
  onAction: async (action) => {
    try { show(await app.callServerTool({ name: "a2ui_action", arguments: { action } })); }
    catch (e) { status("Action failed: " + (e && e.message || e)); }
  },
});
function show(result) {
  const msgs = result && result._meta && result._meta[META_KEY];
  if (Array.isArray(msgs) && msgs.length) return view.replace(msgs);
  const t = (result && result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\\n");
  status(t || "No preview for this result.");
}
app.ontoolresult = show;
await app.connect();
</script>
</body></html>`;
  return cachedHtml;
}
