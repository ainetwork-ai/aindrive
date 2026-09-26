"use client";
import { useEffect, useRef, useState } from "react";
import { a2uiForSkill, actionToSkill, type A2uiAction, type A2uiMessage } from "@/shared/a2ui";
import { ainuiForSkill, dispatchAinuiAction, type AinuiEnv } from "@/shared/a2ui/ainui";
import type { SkillResult } from "@/shared/agent-skills";
// Plain-JS renderer shared with the MCP Apps view.
import { createA2uiRenderer, A2UI_RENDERER_CSS } from "@/shared/a2ui/renderer.js";

const ok = (structured: unknown, text = "") => ({ kind: "ok" as const, structured, text });
const DRIVE = "demo-drive";
const MTIME = 1790371220456;

type Entry = { name: string; isDir: boolean; size?: number; locked?: boolean; mtimeMs?: number };

const svg = (fill: string, label: string) => typeof btoa === "function"
  ? btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="24" fill="${fill}"/><text x="60" y="74" font-size="36" text-anchor="middle" fill="#fff" font-family="sans-serif">${label}</text></svg>`)
  : "";

/** A fake drive so the playground can answer clicks with real surfaces (AINUI mode may edit it). */
const TREE: Record<string, Entry[]> = {
  "": [
    { name: "docs", isDir: true }, { name: "photos", isDir: true }, { name: "premium", isDir: true, locked: true },
    { name: "README.md", isDir: false, size: 1834, mtimeMs: MTIME },
  ],
  docs: [{ name: "plan.md", isDir: false, size: 920, mtimeMs: MTIME }, { name: "notes.txt", isDir: false, size: 120, mtimeMs: MTIME }],
  photos: [
    { name: "logo.svg", isDir: false, size: 410, mtimeMs: MTIME },
    { name: "sunset.svg", isDir: false, size: 380, mtimeMs: MTIME },
    { name: "forest.svg", isDir: false, size: 380, mtimeMs: MTIME },
  ],
};
const FILES: Record<string, string> = {
  "README.md": "# Demo drive\n\nThis surface is **A2UI v0.9**, rendered from the same code the MCP, A2A and AG-UI endpoints use.",
  "docs/plan.md": "## Q4 plan\n\n- ship MCP Apps view\n- document A2UI actions",
  "docs/notes.txt": "plain text is shown in a code block",
  "photos/logo.svg": svg("#0b57d0", "ai"),
  "photos/sunset.svg": svg("#e8710a", "☀"),
  "photos/forest.svg": svg("#188038", "🌲"),
};

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The fake drive's skills — the shapes runSkill returns. */
async function fakeSkill(skill: string, args: Record<string, unknown>): Promise<SkillResult> {
  const path = String(args.path ?? "").replace(/^\/+|\/+$/g, "");
  const siblings = () => (TREE[parentOf(path)] ??= []);
  switch (skill) {
    case "list_files":
      return TREE[path] ? ok({ entries: TREE[path] }) : { kind: "err", code: "not_found", message: `no folder ${path}` };
    case "stat": {
      const e = siblings().find((x) => x.name === baseOf(path));
      return e ? ok(e) : { kind: "err", code: "not_found", message: `no entry at ${path}` };
    }
    case "read_file":
      return ok({ content: FILES[path] ?? "", encoding: path.endsWith(".svg") ? "base64" : "utf8" });
    case "search": {
      const q = String(args.query ?? "").toLowerCase();
      const matches = Object.entries(TREE).flatMap(([dir, es]) =>
        es.filter((e) => e.name.toLowerCase().includes(q)).map((e) => ({ path: dir ? `${dir}/${e.name}` : e.name, isDir: e.isDir })));
      return ok({ matches, truncated: false });
    }
    case "write_file": {
      const content = String(args.content ?? "");
      FILES[path] = content;
      const e = siblings().find((x) => x.name === baseOf(path));
      if (e) Object.assign(e, { size: content.length, mtimeMs: Date.now() });
      else siblings().push({ name: baseOf(path), isDir: false, size: content.length, mtimeMs: Date.now() });
      return ok({ ok: true }, `wrote ${path}`);
    }
    case "delete_path": {
      TREE[parentOf(path)] = siblings().filter((x) => x.name !== baseOf(path));
      delete FILES[path];
      return ok({ ok: true, path, kind: "file" }, `deleted ${path}`);
    }
    default:
      return { kind: "err", code: "invalid_params", message: `${skill} is not in the playground` };
  }
}

function answer(skill: string, args: Record<string, unknown>): A2uiMessage[] {
  const path = String(args.path ?? "");
  switch (skill) {
    case "list_files": return a2uiForSkill(skill, args, ok({ entries: TREE[path] ?? [] }), DRIVE);
    case "read_file": {
      const isSvg = path.endsWith(".svg");
      return a2uiForSkill(skill, args, ok({ content: FILES[path] ?? "", encoding: isSvg ? "base64" : "utf8" }), DRIVE);
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

const AINUI_ENV: AinuiEnv = { canWrite: true, canDelete: true, rootLabel: DRIVE };

/** Asset refs resolve to the fake drive's bytes (a real host uses its authorized route). */
function resolveAsset(a: { path: string; mime: string }): string {
  return a.mime === "image/svg+xml" && FILES[a.path] ? `data:image/svg+xml;base64,${FILES[a.path]}` : "";
}

type Mode = "basic" | "ainui";

export function Playground() {
  const host = useRef<HTMLDivElement>(null);
  const mode = useRef<Mode>("basic");
  const view = useRef<ReturnType<typeof createA2uiRenderer> | null>(null);
  const [shownMode, setShownMode] = useState<Mode>("basic");
  const [lastAction, setLastAction] = useState<A2uiAction | null>(null);
  const [messages, setMessages] = useState<A2uiMessage[]>([]);

  const show = (next: A2uiMessage[]) => { setMessages(next); view.current?.replace(next); };

  const start = (m: Mode) => {
    mode.current = m;
    setShownMode(m);
    setLastAction(null);
    const args = { drive_id: DRIVE, path: "" };
    show(m === "ainui"
      ? ainuiForSkill("list_files", args, ok({ entries: TREE[""] }), DRIVE, AINUI_ENV)
      : answer("list_files", args));
  };

  useEffect(() => {
    if (!host.current) return;
    view.current = createA2uiRenderer(host.current, {
      resolveAsset,
      onAction: async (action: A2uiAction) => {
        setLastAction(action);
        if (mode.current === "ainui") {
          const reply = await dispatchAinuiAction(action, { run: fakeSkill, allowed: () => true, env: () => AINUI_ENV, driveId: DRIVE });
          show(reply.kind === "done"
            ? reply.surface
            : a2uiForSkill("unknown", {}, { kind: "err", code: "invalid_params", message: reply.kind === "refused" ? `refused: ${reply.skill}` : reply.error }));
          return;
        }
        const call = actionToSkill(action, DRIVE);
        show("error" in call
          ? a2uiForSkill("unknown", {}, { kind: "err", code: "invalid_params", message: call.error })
          : answer(call.skill, call.args));
      },
    });
    start("basic");
  }, []);

  return (
    <div className="docs-playground">
      <style>{A2UI_RENDERER_CSS}</style>
      <div className="docs-playground-modes" role="group" aria-label="Catalog">
        {(["basic", "ainui"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={shownMode === m} onClick={() => start(m)}>
            {m === "basic" ? "Basic catalog" : "AINUI"}
          </button>
        ))}
      </div>
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
