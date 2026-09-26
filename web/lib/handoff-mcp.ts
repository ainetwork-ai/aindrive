/**
 * The MCP view of one handoff grant (lib/handoff.ts createHandoffGrant): `list_files` and
 * `read_file` over exactly the files the owner handed off together — nothing else on the device
 * is reachable, because the device serves only the keys it registered (`handoff-read`). A file
 * whose link was revoked or expired drops out; every read is logged like a link fetch.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getDrive } from "./drives";
import { AgentError } from "./rpc";
import { DOWNLOAD_CHUNK_BYTES } from "./agent-stream";
import { grantFiles, logFetch, readHandoffChunk, type HandoffRow } from "./handoff";
import { withCors } from "./mcp-http";

/** Text an agent reads in one call; longer files come back cut, and say so. */
export const READ_MAX_BYTES = 1024 * 1024;
/**
 * A picture or another file (a PDF) an agent reads in one call, whole — base64 in the MCP answer. A picture is
 * what "what is in this folder?" needs to answer about photos; a cut picture is no picture, so bigger ones are
 * refused by name rather than sent broken.
 */
export const READ_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const READ_BINARY_MAX_BYTES = 32 * 1024 * 1024;

const TEXT_MIME = /^text\/|^application\/(json|xml|x-ndjson|javascript|x-yaml|yaml)\b|\+(json|xml)\b/i;
const TEXT_NAME = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?|log|srt|vtt)$/i;

const TOOLS = [
  {
    name: "list_files",
    description: "List the files the owner handed you: id, name (a path when it is in a subfolder), type and size. Only these files can be read.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "read_file",
    description: "Read one handed-off file by its id (from list_files): text as text (up to 1 MiB), a picture as an image, a PDF or other file as its bytes.",
    inputSchema: { type: "object" as const, properties: { id: { type: "string", description: "The file's id from list_files" } }, required: ["id"] },
  },
];

type Meta = { ip: string | null; userAgent: string | null };

/** Up to `max` bytes of a handed-off file, from the device through its carrier drive. */
async function readBytes(f: HandoffRow, meta: Meta, max: number): Promise<{ bytes: Buffer; truncated: boolean } | { error: string }> {
  const drive = getDrive(f.drive_id);
  if (!drive) { logFetch(f.id, meta.ip, meta.userAgent, 404); return { error: "the device's drive is gone" }; }
  const chunks: Buffer[] = [];
  let offset = 0, size = Infinity;
  try {
    while (offset < Math.min(size, max)) {
      const r = await readHandoffChunk(f, drive.drive_secret, offset, Math.min(DOWNLOAD_CHUNK_BYTES, max - offset));
      size = r.size;
      const buf = Buffer.from(r.data, "base64");
      if (!buf.length) break;
      chunks.push(buf); offset += buf.length;
      if (r.eof) break;
    }
  } catch (e) {
    const status = e instanceof AgentError ? e.status : 503;
    logFetch(f.id, meta.ip, meta.userAgent, status);
    return { error: status === 503 || status === 504 ? "the owner's device is offline" : (e as Error).message };
  }
  logFetch(f.id, meta.ip, meta.userAgent, 200);
  return { bytes: Buffer.concat(chunks), truncated: size > offset };
}

export async function serveGrantMcp(req: Request, grantId: string): Promise<Response> {
  const meta: Meta = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip"),
    userAgent: req.headers.get("user-agent"),
  };
  const server = new Server({ name: "aindrive-handoff", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const err = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
    const files = grantFiles(grantId);
    if (call.params.name === "list_files") {
      const list = files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size }));
      return {
        content: [{ type: "text" as const, text: list.length ? list.map((f) => `${f.id}\t${f.name}\t${f.mime}\t${f.size}`).join("\n") : "No files are shared with you any more." }],
        structuredContent: { files: list },
      };
    }
    if (call.params.name === "read_file") {
      const id = String((call.params.arguments ?? {}).id ?? "");
      const f = files.find((x) => x.id === id);
      if (!f) return err("not one of the files handed to you (or its link was revoked or expired)");
      if (TEXT_MIME.test(f.mime) || TEXT_NAME.test(f.name)) {
        const r = await readBytes(f, meta, READ_MAX_BYTES);
        if ("error" in r) return err(r.error);
        const text = r.bytes.toString("utf8");
        return { content: [{ type: "text" as const, text: r.truncated ? `${text}\n\n[cut at ${READ_MAX_BYTES} bytes]` : text }] };
      }
      // Not text: the file whole, as MCP content the agent can use — a picture as an image, anything else (a PDF)
      // as an embedded resource. Too big to send whole is said by name; a cut picture or PDF would be unreadable.
      const image = /^image\//i.test(f.mime);
      const max = image ? READ_IMAGE_MAX_BYTES : READ_BINARY_MAX_BYTES;
      if (f.size > max) return err(`${f.name} is ${f.size} bytes, more than the ${Math.round(max / 1024 / 1024)} MB an agent can read in one call`);
      const r = await readBytes(f, meta, max);
      if ("error" in r) return err(r.error);
      if (r.truncated) return err(`${f.name} is larger than ${Math.round(max / 1024 / 1024)} MB`);
      const data = r.bytes.toString("base64");
      return image
        ? { content: [{ type: "image" as const, data, mimeType: f.mime }] }
        : { content: [{ type: "resource" as const, resource: { uri: `aindrive://handoff/${f.id}/${encodeURIComponent(f.name)}`, mimeType: f.mime, blob: data } }] };
    }
    return err(`unknown tool: ${call.params.name}`);
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return withCors(await transport.handleRequest(req));
}
