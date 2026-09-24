# aindrive integration guide

aindrive is a shared drive with agents inside. Everything a person can do in a
drive — browse, preview, search, write — is also available to **other apps and
agents** through four open standards. They all share one skill set, one
permission model and **one UI definition**, so you get a working file UI in your
product without building it.

| Standard | What it is | Endpoint | Use it when |
|---|---|---|---|
| [**MCP**](/docs/mcp) | Model Context Protocol (Streamable HTTP) + **MCP Apps** UI | `{{BASE}}/mcp/d/<driveId>` | You connect aindrive to an AI host: claude.ai, ChatGPT, Claude Code, Cursor, VS Code, Goose… |
| [**A2A**](/docs/a2a) | Agent2Agent protocol v0.3 (JSON-RPC, streaming) | `{{BASE}}/a2a` | Your agent talks to aindrive as a peer agent |
| [**AG-UI**](/docs/ag-ui) | Agent–User Interaction protocol 1.0 (event stream) | `{{BASE}}/agui` · `{{BASE}}/agui/d/<driveId>` | You build your own agent frontend (CopilotKit or any AG-UI client) |
| [**A2UI**](/docs/a2ui) | Agent-to-User Interface v0.9 (declarative UI JSON) | carried by all three above | You want native, ready-to-render UI for every result |

## How the pieces fit

```
                ┌──────────── skills ────────────┐
   your app ──▶ │ list_drives · list_files · read_file · write_file │
                │ delete_path · stat · search                        │
                └──────────────┬──────────────────┘
                               │ every result also becomes an
                               ▼ A2UI surface (one UI definition)
     MCP  ─ result._meta + MCP Apps view (ui://aindrive/browser)
     A2A  ─ DataPart  application/a2ui+json   (A2UI extension)
     AG-UI─ ACTIVITY_SNAPSHOT  activityType "a2ui-surface"
```

A click in any rendered surface comes back as an **A2UI action**
(`aindrive.open`, `aindrive.search`, `aindrive.open_drive`), which aindrive maps
to the next skill call — the same way over every transport.

## Quick start (60 seconds)

1. Open a drive → sidebar **MCP** → copy the **Server URL**.
2. Pick one:
   - **claude.ai / ChatGPT**: *Settings → Connectors → Add custom connector*, paste the URL, sign in, approve. Done — tool results render as an interactive file browser.
   - **Claude Code**: generate a token in the same panel, then
     ```bash
     claude mcp add --transport http aindrive {{BASE}}/mcp/d/<driveId> \
       --header "Authorization: Bearer aind_pat_…"
     ```
   - **Your own agent (A2A)**:
     ```bash
     curl -s {{BASE}}/a2a -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
       "jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"kind":"message","role":"user","messageId":"1",
         "parts":[{"kind":"text","text":"ls"}]}}}'
     ```

## Next

- [Authentication](/docs/auth) — tokens, OAuth 2.1, scopes
- [Skills reference](/docs/skills) — every operation and its arguments
- [A2UI surfaces & playground](/docs/a2ui) — what the UI looks like, live
