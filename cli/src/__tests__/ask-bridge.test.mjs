import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { handleRpc, parentPortAskBridge, setAskBridge } from "../rpc.js";

/** A fake utility-process parent port: what the Mac app would answer, by message id. */
function fakePort(answer) {
  const port = new EventEmitter();
  port.sent = [];
  port.postMessage = (m) => { port.sent.push(m); setTimeout(() => port.emit("message", { data: answer(m) }), 0); };
  return port;
}

describe("agent-ask inside the Mac app goes to the on-device agent over the parent port", () => {
  it("round-trips a question and its answer by id", async () => {
    const port = fakePort((m) => ({ type: "agent-ask", id: m.id, result: { answer: `answered ${m.query} in ${m.root}`, sources: [{ path: "a.jpg", snippet: "2026-09-01 · photo" }] } }));
    setAskBridge(parentPortAskBridge(port));
    try {
      const r = await handleRpc({ method: "agent-ask", agentId: "agt_x", query: "photos of trees" }, "/Users/me/Photos");
      expect(r).toMatchObject({ method: "agent-ask", answer: "answered photos of trees in /Users/me/Photos" });
      expect(r.sources).toHaveLength(1);
      expect(port.sent[0]).toMatchObject({ type: "agent-ask", root: "/Users/me/Photos", query: "photos of trees", agentId: "agt_x" });
    } finally { setAskBridge(null); }
  });

  it("surfaces the app's error, and times out instead of hanging the socket", async () => {
    const failing = fakePort((m) => ({ type: "agent-ask", id: m.id, error: "no such folder" }));
    setAskBridge(parentPortAskBridge(failing));
    try { await expect(handleRpc({ method: "agent-ask", query: "x" }, "/f")).rejects.toThrow(/no such folder/); }
    finally { setAskBridge(null); }
    const silent = new EventEmitter(); silent.postMessage = () => {};
    setAskBridge(parentPortAskBridge(silent, 30));
    try { await expect(handleRpc({ method: "agent-ask", query: "x" }, "/f")).rejects.toThrow(/did not answer/); }
    finally { setAskBridge(null); }
  });
});
