import { request } from "undici";

export async function apiFetch(server, path, opts = {}) {
  const url = new URL(path, server).toString();
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  const { statusCode, body: respBody } = await request(url, {
    method: opts.method || "GET",
    headers,
    body,
  });
  const text = await respBody.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (statusCode >= 400) {
    throw new Error(`${statusCode}: ${json?.error || text || "request failed"}`);
  }
  return json;
}
