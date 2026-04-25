import { runMcpServer } from "../mcp/server.js";

export async function cmdMcp(args) {
  await runMcpServer({ server: args?.flags?.server });
}
