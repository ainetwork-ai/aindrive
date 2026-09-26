// The Mac's local model, in its own process. In the main process a warm generation took ~8 s where the
// same call takes ~2.5 s alone: the model's JS side shares the main thread with the window, IPC and
// indexing. A utility process gives it a thread of its own (desktop/src/mac-agent.js llmInWorker).
//   parent → {type:"init", modelPath, budgetMs} | {type:"warm"} | {type:"understand", id, text, context, nowMs} | {type:"unload"}
//   worker → {type:"ready"} | {type:"result", id, result} | {type:"error", id, message} | {type:"log", message}
import { GeoLookup } from "./agent/geo-lookup.js";
import { createLlm } from "./agent/llm.js";

const port = process.parentPort;
let llm = null;
const log = (message) => port.postMessage({ type: "log", message });

port.on("message", async (ev) => {
  const m = ev?.data ?? ev;
  try {
    if (m.type === "init") {
      llm = createLlm({ modelPath: () => m.modelPath, geo: GeoLookup.loadDefault(), budgetMs: m.budgetMs, idleMs: Infinity, log });
      port.postMessage({ type: "ready" });
    } else if (m.type === "warm") llm?.warm();
    else if (m.type === "unload") await llm?.unload();
    else if (m.type === "understand") {
      const result = llm ? await llm.understand({ text: m.text, context: m.context, nowMs: m.nowMs }) : null;
      port.postMessage({ type: "result", id: m.id, result });
    }
  } catch (e) {
    port.postMessage({ type: "error", id: m?.id, message: e?.message ?? String(e) });
  }
});
port.start?.();
