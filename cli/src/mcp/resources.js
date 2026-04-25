/**
 * Resource handlers for the aindrive MCP server.
 *
 * URI scheme: aindrive://drive/<driveId>/<path>
 *   - aindrive://drive/<id>            → root listing as JSON
 *   - aindrive://drive/<id>/<path>     → file contents (utf8)
 *
 * Resources are advertised lazily: list_drives is cheap, but enumerating
 * the entire tree per drive could be huge — instead we expose a single
 * "drive root" resource per drive and rely on resource-template URIs for
 * files the LLM constructs on the fly.
 */

const SCHEME = "aindrive";

export function makeResourceTemplates() {
  return [
    {
      uriTemplate: `${SCHEME}://drive/{driveId}/{+path}`,
      name: "Drive file",
      description: "A file inside an aindrive drive. Path '' = root listing as JSON.",
      mimeType: "text/plain",
    },
  ];
}

export async function listResources(ctx) {
  if (!ctx.client.hasOwnerAuth) return { resources: [] };
  try {
    const r = await ctx.client.get("/api/drives");
    const resources = (r.body?.drives ?? []).map((d) => ({
      uri: `${SCHEME}://drive/${d.id}/`,
      name: `${d.name} (root)`,
      description: `Root of drive ${d.id}${d.online ? " — online" : " — offline"}`,
      mimeType: "application/json",
    }));
    return { resources };
  } catch {
    return { resources: [] };
  }
}

export async function readResource(uri, ctx) {
  const parsed = parseUri(uri);
  if (!parsed) throw new Error(`unsupported uri: ${uri}`);
  const { driveId, path } = parsed;

  if (!path || path === "/") {
    const r = await ctx.client.get(`/api/drives/${driveId}/fs/list`, { query: { path: "" } });
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(r.body, null, 2) }],
    };
  }

  // Try directory listing first; if 4xx-ish (not a dir), fall through to file read.
  try {
    const list = await ctx.client.get(`/api/drives/${driveId}/fs/list`, { query: { path } });
    if (list.body?.entries) {
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(list.body, null, 2) }],
      };
    }
  } catch {
    // fall through
  }

  const file = await ctx.client.get(`/api/drives/${driveId}/fs/read`, { query: { path, encoding: "utf8" } });
  const content = file.body?.content ?? "";
  return {
    contents: [{ uri, mimeType: "text/plain", text: content }],
  };
}

function parseUri(uri) {
  if (!uri.startsWith(`${SCHEME}://`)) return null;
  const rest = uri.slice(`${SCHEME}://`.length); // e.g. "drive/abc/docs/spec.md"
  if (!rest.startsWith("drive/")) return null;
  const tail = rest.slice("drive/".length);
  const slash = tail.indexOf("/");
  if (slash === -1) return { driveId: tail, path: "" };
  return { driveId: tail.slice(0, slash), path: tail.slice(slash + 1) };
}
