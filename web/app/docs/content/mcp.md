# MCP — Model Context Protocol

Each drive is a **remote MCP server** (Streamable HTTP, stateless):

```
{{BASE}}/mcp/d/<driveId>
```

Tools are scoped to that one drive (no `drive_id` argument). A read token gets
`list_files`, `read_file`, `stat`, `search`; a write token adds `write_file`
and `delete_path`. Full argument list: [Skills](/docs/skills).

## Connect

**claude.ai / ChatGPT / any OAuth-capable host** — add a custom connector with
the URL. The host discovers aindrive's OAuth server from the `401` +
`WWW-Authenticate: resource_metadata=…` response, registers itself, and sends
the user to approve. No token to copy.

**Claude Code**

```bash
claude mcp add --transport http aindrive {{BASE}}/mcp/d/<driveId> \
  --header "Authorization: Bearer aind_pat_…"
```

**Cursor / VS Code / other clients** (`mcp.json`)

```json
{
  "mcpServers": {
    "aindrive": {
      "url": "{{BASE}}/mcp/d/<driveId>",
      "headers": { "Authorization": "Bearer aind_pat_…" }
    }
  }
}
```

**TypeScript SDK**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(
  new URL("{{BASE}}/mcp/d/<driveId>"),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
));
const { tools } = await client.listTools();
const res = await client.callTool({ name: "list_files", arguments: { path: "" } });
```

## Built-in UI (MCP Apps)

aindrive ships an **[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)**
view, so hosts that support the extension (`io.modelcontextprotocol/ui` —
Claude, ChatGPT, VS Code, Goose, …) render tool results as an interactive file
browser, preview and search screen instead of raw JSON:

| | |
|---|---|
| UI resource | `ui://aindrive/browser` (`text/html;profile=mcp-app`) |
| Tool metadata | every tool: `_meta.ui = { resourceUri: "ui://aindrive/browser", visibility: ["model","app"] }` |
| Result payload | `result._meta["ai.aindrive/a2ui"]` — the [A2UI surface](/docs/a2ui) for that result (UI-only; the model sees the normal text) |
| Clicks | the view calls the **app-only** tool `a2ui_action` with the A2UI action; the host forwards it over your already-authenticated MCP session |

You don't need to do anything to enable it — hosts without MCP Apps support
simply ignore the metadata.

## A2UI over MCP

If your client renders [A2UI](/docs/a2ui) natively, ask for the surface inline:
send `X-A2UI: 1` (or append `?a2ui=1` to the URL). Every tool result then also
contains an embedded resource:

```json
{ "type": "resource", "resource": {
    "uri": "a2ui://aindrive/aindrive-browser-k3j2…",
    "mimeType": "application/a2ui+json",
    "text": "[{\"version\":\"v0.9\",\"createSurface\":…}, …]" } }
```

Send user clicks back with `tools/call a2ui_action {"action": <A2UI action>}`.

## Errors

| Situation | Response |
|---|---|
| no / invalid token | HTTP `401` + `WWW-Authenticate: Bearer … resource_metadata="…/.well-known/oauth-protected-resource/mcp/d/<id>"` |
| token for another drive, missing scope | HTTP `403` `insufficient_scope` |
| permission / path / payment problem | tool result `isError: true`, text `[forbidden] …` |
