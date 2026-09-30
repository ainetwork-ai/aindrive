import { describe, it, expect, vi, beforeEach } from "vitest";

// `aindrive login|mcp --server <url>` must talk to <url>: the program and the
// subcommand both declare --server, and the subcommand's default used to win.
const seen = [];
vi.mock("../commands/login.js", () => ({ cmdLogin: async (args) => seen.push({ cmd: "login", server: args.flags.server }) }));
vi.mock("../commands/mcp.js", () => ({ cmdMcp: async (args) => seen.push({ cmd: "mcp", server: args?.flags?.server }) }));
vi.mock("../commands/serve.js", () => ({ cmdServe: async (args) => seen.push({ cmd: "serve", server: args.flags.server }) }));

const { runCli } = await import("../main.js");
const PROD = process.env.AINDRIVE_SERVER || "https://aindrive.ainetwork.ai";

beforeEach(() => { seen.length = 0; });

describe("--server on subcommands", () => {
  it("mcp --server <url> uses <url>", async () => {
    await runCli(["mcp", "--server", "http://127.0.0.1:3797"]);
    expect(seen).toEqual([{ cmd: "mcp", server: "http://127.0.0.1:3797" }]);
  });
  it("--server before the subcommand works too", async () => {
    await runCli(["--server", "http://self.host", "mcp"]);
    expect(seen).toEqual([{ cmd: "mcp", server: "http://self.host" }]);
  });
  it("mcp without --server leaves it to the saved login (no hard default)", async () => {
    await runCli(["mcp"]);
    expect(seen).toEqual([{ cmd: "mcp", server: undefined }]);
  });
  it("login --server <url> signs in to <url>, then serves on <url>", async () => {
    await runCli(["login", "--server", "http://127.0.0.1:3797", "--no-open"]);
    expect(seen).toEqual([
      { cmd: "login", server: "http://127.0.0.1:3797" },
      { cmd: "serve", server: "http://127.0.0.1:3797" },
    ]);
  });
  it("login without --server keeps the default server", async () => {
    await runCli(["login", "--no-open"]);
    expect(seen[0]).toEqual({ cmd: "login", server: PROD });
  });
});
