import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { request } from "undici";
import { writeGlobalCreds } from "../config.js";

export async function cmdLogin(args) {
  const server = args.flags.server;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const email = args.flags.email || (await rl.question("Email: ")).trim();
    const password = args.flags.password || (await rl.question("Password: ")).trim();

    const { statusCode, body, headers } = await request(new URL("/api/auth/login", server).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const text = await body.text();
    if (statusCode >= 400) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch {}
      throw new Error(`login failed (${statusCode}): ${msg}`);
    }
    const setCookie = headers["set-cookie"];
    const cookieValue = extractSessionCookie(setCookie);
    if (!cookieValue) throw new Error("server did not return session cookie");

    await writeGlobalCreds({ server, email, sessionCookie: cookieValue, savedAt: Date.now() });
    console.log(`  ✓ signed in as ${email}`);
  } finally {
    rl.close();
  }
}

function extractSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const line of arr) {
    const m = line.match(/aindrive_session=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}
