import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { request } from "undici";
import { writeGlobalCreds } from "../config.js";

export async function cmdLogin(args) {
  const server = stripTrailingSlash(args.flags.server);
  const url = `${server}/cli-login`;

  console.log(`\n  open this URL in your browser to get a code:`);
  console.log(`  ${url}\n`);

  if (args.flags.open !== false) tryOpen(url);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const code = (await rl.question("  Code: ")).trim();
    if (!code) throw new Error("no code entered");

    const { statusCode, body } = await request(`${server}/api/auth/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const text = await body.text();
    if (statusCode >= 400) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(`exchange failed (${statusCode}): ${msg}`);
    }
    const { token, user } = JSON.parse(text);
    if (!token) throw new Error("server did not return a session token");

    await writeGlobalCreds({ server, email: user?.email, sessionCookie: token, savedAt: Date.now() });
    console.log(`  ✓ signed in${user?.email ? ` as ${user.email}` : ""}`);
  } finally {
    rl.close();
  }
}

function stripTrailingSlash(s) {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function tryOpen(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
