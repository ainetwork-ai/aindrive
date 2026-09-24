"use client";
import { useEffect, useRef, useState } from "react";
import { a2uiForSkill, actionToSkill, type A2uiAction, type A2uiMessage } from "@/shared/a2ui";
// Plain-JS renderer shared with the MCP Apps view.
import { createA2uiRenderer, A2UI_RENDERER_CSS } from "@/shared/a2ui/renderer.js";

const ok = (structured: unknown, text = "") => ({ kind: "ok" as const, structured, text });
const DRIVE = "demo-drive";

/** A fake drive so the playground can answer clicks with real surfaces. */
const TREE: Record<string, { name: string; isDir: boolean; size?: number; locked?: boolean }[]> = {
  "": [
    { name: "docs", isDir: true }, { name: "photos", isDir: true }, { name: "premium", isDir: true, locked: true },
    { name: "README.md", isDir: false, size: 1834 },
  ],
  docs: [{ name: "plan.md", isDir: false, size: 920 }, { name: "notes.txt", isDir: false, size: 120 }],
  photos: [{ name: "logo.svg", isDir: false, size: 410 }],
};
const FILES: Record<string, string> = {
  "README.md": "# Demo drive\n\nThis surface is **A2UI v0.9**, rendered from the same code the MCP, A2A and AG-UI endpoints use.",
  "docs/plan.md": "## Q4 plan\n\n- ship MCP Apps view\n- document A2UI actions",
  "docs/notes.txt": "plain text is shown in a code block",
  "photos/logo.svg": typeof btoa === "function"
    ? btoa('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="24" fill="#0b57d0"/><text x="60" y="74" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">ai</text></svg>')
    : "",
};

function answer(skill: string, args: Record<string, unknown>): A2uiMessage[] {
  const path = String(args.path ?? "");
  switch (skill) {
    case "list_files": return a2uiForSkill(skill, args, ok({ entries: TREE[path] ?? [] }), DRIVE);
    case "read_file": {
      const svg = path.endsWith(".svg");
      return a2uiForSkill(skill, args, ok({ content: FILES[path] ?? "", encoding: svg ? "base64" : "utf8" }), DRIVE);
    }
    case "search": {
      const q = String(args.query ?? "").toLowerCase();
      const matches = Object.entries(TREE).flatMap(([dir, es]) =>
        es.filter((e) => e.name.toLowerCase().includes(q)).map((e) => ({ path: dir ? `${dir}/${e.name}` : e.name, isDir: e.isDir })));
      return a2uiForSkill(skill, args, ok({ matches, truncated: false }), DRIVE);
    }
    default:
      return a2uiForSkill(skill, args, { kind: "err", code: "invalid_params", message: `${skill} is not in the playground` }, DRIVE);
  }
}

export function Playground() {
  const host = useRef<HTMLDivElement>(null);
  const [lastAction, setLastAction] = useState<A2uiAction | null>(null);
  const [messages, setMessages] = useState<A2uiMessage[]>([]);

  useEffect(() => {
    if (!host.current) return;
    const view = createA2uiRenderer(host.current, {
      onAction: (action: A2uiAction) => {
        setLastAction(action);
        const call = actionToSkill(action, DRIVE);
        const next = "error" in call
          ? a2uiForSkill("unknown", {}, { kind: "err", code: "invalid_params", message: call.error })
          : answer(call.skill, call.args);
        setMessages(next);
        view.replace(next);
      },
    });
    const first = answer("list_files", { drive_id: DRIVE, path: "" });
    setMessages(first);
    view.replace(first);
  }, []);

  return (
    <div className="docs-playground">
      <style>{A2UI_RENDERER_CSS}</style>
      <div className="docs-playground-view" ref={host} />
      <details>
        <summary>Last action sent by the renderer</summary>
        <pre>{lastAction ? JSON.stringify(lastAction, null, 2) : "(click something above)"}</pre>
      </details>
      <details>
        <summary>A2UI messages for the current surface</summary>
        <pre>{JSON.stringify(messages, null, 2)}</pre>
      </details>
    </div>
  );
}
