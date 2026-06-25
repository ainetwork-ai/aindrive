// Characterization tests for api.js — agent-first migration safety net.
//
// These SNAPSHOT the *current* behaviour of apiFetch (not an assumed spec) so a
// later structural refactor can be proven behaviour-preserving. Each test makes a
// real undici round-trip against a throwaway node:http server on an ephemeral port
// (127.0.0.1:0) — no mocking framework, so the network/parse/error path is exercised
// exactly as in production. The server records every received request so header /
// method / body / URL-join behaviour can be asserted by echoing them back.
//
// Behaviours locked here (all verified by probe before being written down):
//  - 2xx JSON body            -> parsed value (object/array/number)
//  - 2xx empty body           -> null (only a TRULY empty string; whitespace does NOT)
//  - 2xx non-JSON body        -> { raw: text } (the JSON.parse catch-branch shape)
//  - >=400                    -> throws Error `${status}: ${json.error || text || "request failed"}`
//                               (precedence: json.error, else raw text, else literal "request failed")
//  - Authorization: Bearer    -> present iff opts.token set
//  - content-type default      -> "application/json", overridable via opts.headers
//  - new URL(path, server)     -> leading-"/" path is absolute (drops base path);
//                               no-leading-slash path resolves relative to the base
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";

import { apiFetch } from "../api.js";

// Each handler keys off the request pathname; routes return the body/status/content-type
// needed to characterize one apiFetch branch. Every request is pushed to `received` so
// tests can assert what apiFetch actually sent (headers/method/body/url).
let server;
let base;
let received;

function handler(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    const route = new URL(req.url, "http://placeholder").pathname;
    const sendJson = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const sendText = (status, text, ct = "text/plain") => {
      res.writeHead(status, { "content-type": ct });
      res.end(text);
    };

    switch (route) {
      // --- 2xx bodies ---
      case "/json-object": return sendJson(200, { ok: true, n: 42 });
      case "/json-array": return sendText(200, "[1,2,3]", "application/json");
      case "/json-number": return sendText(200, "42", "text/plain"); // valid JSON scalar
      case "/non-json": return sendText(200, "hello not json");
      case "/whitespace": return sendText(200, "   "); // truthy string -> JSON.parse throws
      case "/empty": { res.writeHead(200); return res.end(""); }
      // --- error bodies ---
      case "/err-json-error-key": return sendJson(400, { error: "bad-thing", other: 1 });
      case "/err-500-error-key": return sendJson(500, { error: "boom" });
      case "/err-json-no-error-key": return sendJson(400, { message: "no error key", detail: "x" });
      case "/err-plain": return sendText(403, "plain forbidden text");
      case "/err-empty": { res.writeHead(404, { "content-type": "text/plain" }); return res.end(""); }
      // --- header / method / url echo ---
      case "/echo": return sendJson(200, { ok: true });
      default: return sendJson(200, { route });
    }
  });
}

beforeAll(async () => {
  received = [];
  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("apiFetch — 2xx body parsing", () => {
  it("parses a JSON object body into the object", async () => {
    expect(await apiFetch(base, "/json-object")).toEqual({ ok: true, n: 42 });
  });

  it("parses a JSON array body into the array", async () => {
    expect(await apiFetch(base, "/json-array")).toEqual([1, 2, 3]);
  });

  it("parses a bare JSON scalar (numeric string) into the number", async () => {
    expect(await apiFetch(base, "/json-number")).toBe(42);
  });

  it("wraps a NON-JSON body as { raw: text } (JSON.parse catch branch)", async () => {
    expect(await apiFetch(base, "/non-json")).toEqual({ raw: "hello not json" });
  });

  it("treats a whitespace-only body as non-JSON -> { raw } (NOT null — it is a truthy string)", async () => {
    expect(await apiFetch(base, "/whitespace")).toEqual({ raw: "   " });
  });

  it("returns null for a truly empty body", async () => {
    expect(await apiFetch(base, "/empty")).toBeNull();
  });
});

describe("apiFetch — error status throws + message precedence", () => {
  it("throws `${status}: ${json.error}` when the error JSON has an `error` key", async () => {
    await expect(apiFetch(base, "/err-json-error-key")).rejects.toThrow("400: bad-thing");
  });

  it("uses json.error for 5xx the same way", async () => {
    await expect(apiFetch(base, "/err-500-error-key")).rejects.toThrow("500: boom");
  });

  it("falls back to the raw text when the JSON has no `error` key", async () => {
    // json?.error is undefined -> message uses the raw (re-serialized) text body.
    await expect(apiFetch(base, "/err-json-no-error-key")).rejects.toThrow(
      '400: {"message":"no error key","detail":"x"}',
    );
  });

  it("uses the plain-text body when the error body is not JSON", async () => {
    await expect(apiFetch(base, "/err-plain")).rejects.toThrow("403: plain forbidden text");
  });

  it("falls back to the literal 'request failed' for an empty error body", async () => {
    await expect(apiFetch(base, "/err-empty")).rejects.toThrow("404: request failed");
  });

  it("throws an Error instance (not a plain rejection)", async () => {
    await expect(apiFetch(base, "/err-plain")).rejects.toBeInstanceOf(Error);
  });
});

describe("apiFetch — request headers", () => {
  it("sends `Authorization: Bearer <token>` when opts.token is set", async () => {
    await apiFetch(base, "/echo", { token: "TKN123" });
    expect(received.at(-1).headers.authorization).toBe("Bearer TKN123");
  });

  it("sends NO Authorization header when opts.token is absent", async () => {
    await apiFetch(base, "/echo");
    expect(received.at(-1).headers.authorization).toBeUndefined();
  });

  it("defaults content-type to application/json", async () => {
    await apiFetch(base, "/echo");
    expect(received.at(-1).headers["content-type"]).toBe("application/json");
  });

  it("lets opts.headers override the default content-type and add custom headers", async () => {
    await apiFetch(base, "/echo", { headers: { "x-custom": "Y", "content-type": "text/weird" } });
    expect(received.at(-1).headers["content-type"]).toBe("text/weird");
    expect(received.at(-1).headers["x-custom"]).toBe("Y");
  });
});

describe("apiFetch — method and body", () => {
  it("defaults the method to GET", async () => {
    await apiFetch(base, "/echo");
    expect(received.at(-1).method).toBe("GET");
  });

  it("uses opts.method and JSON-stringifies opts.body", async () => {
    await apiFetch(base, "/echo", { method: "POST", body: { a: 1 } });
    expect(received.at(-1).method).toBe("POST");
    expect(received.at(-1).body).toBe('{"a":1}');
  });

  it("sends no body when opts.body is absent", async () => {
    await apiFetch(base, "/echo");
    expect(received.at(-1).body).toBe("");
  });
});

describe("apiFetch — new URL(path, server) join semantics", () => {
  it("a leading-slash path is ABSOLUTE: it drops any base path", async () => {
    await apiFetch(`${base}/api`, "/abs/path");
    expect(received.at(-1).url).toBe("/abs/path");
  });

  it("a no-leading-slash path resolves RELATIVE to a base with a trailing slash", async () => {
    await apiFetch(`${base}/api/`, "rel/path");
    expect(received.at(-1).url).toBe("/api/rel/path");
  });

  it("a no-leading-slash path against a base WITHOUT a trailing slash replaces the last segment", async () => {
    await apiFetch(`${base}/api`, "rel/path");
    expect(received.at(-1).url).toBe("/rel/path");
  });
});
