// Shared bits for the sheet modules (share, manage, agents, mcp, account):
// each sheet renders an HTML string and binds its own handlers, and talks to
// the shell only through this context — so main.ts stays the one owner of
// app state and the sheets stay independent.
import type { Web } from "./web";

export interface Ctx {
  web: Web;
  server: string;
  notify(msg: string, error?: boolean): void;
  /** Re-render the whole app (the sheet's render() is called again). */
  rerender(): void;
  confirm(title: string, body: string, ok: string, danger?: boolean): Promise<boolean>;
  close(): void;
  copy(text: string, what?: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** Clear what was typed into these fields (after a successful submit). */
  forget(...ids: string[]): void;
}

/** A full-screen or bottom sheet owned by one module. */
export interface Sheet {
  kind: "drawer" | "page";
  render(): string;
  bind(root: HTMLElement): void;
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function msgOf(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // "/api/drives/x/members → 403: only owner can invite" → "only owner can invite"
  const hit = /→ \d+: (.*)$/.exec(m);
  return hit ? hit[1] : m;
}

export function on(root: HTMLElement, sel: string, ev: string, fn: (el: HTMLElement, e: Event) => void) {
  root.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener(ev, (e) => fn(el, e)));
}

export function val(root: HTMLElement, id: string): string {
  return ((root.querySelector("#" + id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value ?? "").trim();
}

export function when(iso?: string | number | null): string {
  if (!iso) return "";
  const d = typeof iso === "number" ? new Date(iso) : new Date(/^\d+$/.test(iso) ? Number(iso) : iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export function shortAddr(a: string): string { return a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }

export const ROLE_HELP: Record<string, string> = {
  viewer: "Read & download files",
  editor: "Read, upload, rename, delete",
  owner: "Everything, including sharing and selling",
};
