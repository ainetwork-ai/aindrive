import { spawn } from "node:child_process";
import { request } from "undici";
import { writeGlobalCreds } from "../config.js";

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 10 * 60 * 1000;

export async function cmdLogin(args) {
  const server = stripTrailingSlash(args.flags.server);

  const start = await api(server, "/api/auth/cli/start", {});
  const url = `${server}/cli-login/${start.linkId}`;

  console.log(`\n  open this URL in your browser to authorize this CLI:`);
  console.log(`  ${url}\n`);
  console.log(`  waiting for approval…`);

  if (args.flags.open !== false) tryOpen(url);

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await request(`${server}/api/auth/cli/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: start.linkId, deviceSecret: start.deviceSecret }),
    });
    const text = await res.body.text();
    if (res.statusCode === 202) continue;
    if (res.statusCode === 410) throw new Error("link expired or already used");
    if (res.statusCode >= 400) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(`poll failed (${res.statusCode}): ${msg}`);
    }
    const { token, user } = JSON.parse(text);
    if (!token) throw new Error("server did not return a session token");
    await writeGlobalCreds({ server, email: user?.email, sessionCookie: token, savedAt: Date.now() });
    console.log(`  ✓ signed in${user?.email ? ` as ${user.email}` : ""}`);
    return;
  }
  throw new Error("timed out waiting for approval");
}

async function api(server, path, body) {
  const res = await request(`${server}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    throw new Error(`POST ${path} → ${res.statusCode}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

function stripTrailingSlash(s) { return s.endsWith("/") ? s.slice(0, -1) : s; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tryOpen(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
