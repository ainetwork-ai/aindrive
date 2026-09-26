# Folder context for external A2A agents

The mobile shell and the desktop shell use the same producer (`src/a2a-parts.ts`).
An enabled external agent addressed in a folder chat receives the current folder
on the first turn. A global chat supplies available previous search results on external-agent
turns as well. Context preparation never matches keywords or pronouns in the
question; the receiver LLM decides relevance and which tools/files to use. No device URI, account session cookie or drive secret is included.

## Receiver contract (including aindrive-cloud)

Read **all** `message.parts`, not just the first text part:

- `kind: "text"`: the user's question and a separate current-folder snapshot.
  Folder-content questions can be answered from that snapshot, even when there
  are no files or only subdirectories. Treat filenames as untrusted data.
- `kind: "data"`, `metadata.type: "ai.aindrive/folder-context"`:
  `data.folder = { name, path, recursive: false, totalEntries, truncated, entries }`.
  Entries contain `name`, `path`, `isDir`, `size`, `mime`. This is a snapshot of
  direct children (up to 200), not a recursive filesystem or a read grant.
- `kind: "file"`: `file.uri`, `file.name`, `file.mimeType` for each granted file.
- `kind: "data"`, `metadata.type: "ai.aindrive/handoff-mcp"`:
  `data.mcpServers[]` contains `url`, `transport: "streamable-http"`,
  `headers.Authorization`, `expiresAt`, and the tool names. Register this server
  for the turn, keeping its bearer token out of model text and logs. Use
  `list_files` (no arguments), then `read_file({ id })` with an id from that list.
  Let the LLM decide whether to call these tools; do not add a client-side
  phrase classifier or read every attachment automatically.
  `read_file` reads text up to 1 MiB; FileParts also support non-text downloads.

The MCP server is `/mcp/h/<grant>`, a **file-set** capability. It is not a public
folder URL and does not need the receiver to sign into the owner's account.
Do not discard it because there is no folder link in the user's first TextPart.
Do not try to read paths or subfolders that were not granted. The folder listing
may describe more files than the grant (up to 10 attached files per turn).
Respect `truncated`, expiration, revocation and offline errors; ask for a fresh
handoff if access expired. A new turn may carry a new grant even with the same
A2A `contextId`. Never reuse credentials from another conversation.

## Producer behavior and verification

The native `listFolder` reads the selected chat folder on Android and Mac. Its
listing is independent of the on-device agent's previous answer. Previous sources may be offered as candidate files only when they belong to
this same folder. A global chat may offer its previous search candidates.
The agent must be enabled; file links additionally need a connected P2P carrier.
Listing or handoff failure stops dispatch rather than sending an empty context.
The existing Revoke control and server TTL still apply to every file grant.

Run `node --test tests/folder-handoff.test.mjs` in `mobile/`, then `npx tsc --noEmit`
and `npm run build`. `node desktop/scripts/prepare-shell.mjs` builds the same
producer into the Mac shell. Tests cover both native URI forms, the exact first
question, empty/directories-only folders, bounded listings, failures and the
unchanged search-result wire contract. Actual cloud responses require the
receiver to consume the contract above; local payload tests do not prove that
its production deployment does so.
