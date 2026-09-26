/**
 * Minimal, dependency-free A2UI v0.9 renderer for the basic-catalog subset
 * aindrive emits (shared/a2ui/index.ts): Column, Row, List, Card, Text, Button,
 * TextField, Image, Divider, Icon — with JSON-Pointer data binding, templated
 * children and action events.
 *
 * Used by the MCP Apps view (app/mcp/ui — inlined into the sandboxed iframe)
 * and the /docs playground. Third parties should use an official renderer
 * (@a2ui/lit, @a2ui/react, CopilotKit); this one exists so aindrive's own
 * surfaces render anywhere without a build step.
 *
 * AINUI (docs/AINUI.md, catalog AINUI_CATALOG in ./ainui.ts) is understood too:
 * Grid, Tile, FileView, Breadcrumbs, Segmented, Button `tone`/`confirm`,
 * Text `mono`, TextField `longText`, and `{$asset}` references, resolved by
 * `opts.resolveAsset(asset)` or — by default — through aindrive's own routes
 * (`{assetBase}/api/drives/{drive_id}/fs/thumbnail|stream?path=…`), which only
 * work where the viewer has aindrive's session. Unknown components draw their
 * children, else nothing.
 *
 * Plain ES module, browser-only APIs, no imports. Everything user-supplied is
 * written via textContent / escaped HTML; media URLs are limited to data:,
 * https:, blob: and same-origin paths.
 */

const KIND_EMOJI = { folder: "📁", image: "🖼", video: "🎬", audio: "🎵", pdf: "📕", file: "📄" };

/** Media URLs we let into src attributes. */
function safeMediaUrl(u) {
  const s = typeof u === "string" ? u : "";
  return /^(data:(image|video|audio)\/|https:\/\/|blob:)/.test(s) || /^\/(?!\/)/.test(s) ? s : "";
}

function humanSize(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

/** aindrive's own byte routes for an AINUI asset (works where the viewer has the session cookie). */
export function aindriveAssetUrl(asset, base = "") {
  if (!asset || typeof asset.drive_id !== "string" || typeof asset.path !== "string") return "";
  const route = asset.variant === "thumb" ? "thumbnail" : "stream";
  const v = typeof asset.v === "number" ? `&v=${asset.v}` : "";
  return `${base}/api/drives/${encodeURIComponent(asset.drive_id)}/fs/${route}?path=${encodeURIComponent(asset.path)}${v}`;
}

const ICON_EMOJI = { folder: "📁", search: "🔍", arrowBack: "⬅", home: "🏠", delete: "🗑", download: "⬇", share: "🔗", lock: "🔒", info: "ℹ️", warning: "⚠️", check: "✅" };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Tiny safe markdown: fenced code, headings, bold, inline code, paragraphs. */
function miniMarkdown(src) {
  const parts = String(src).split(/```[^\n]*\n?/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) return `<pre><code>${escapeHtml(chunk.replace(/\n$/, ""))}</code></pre>`;
    return chunk.split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
      const inline = (t) => escapeHtml(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
      const block = p.trim();
      const m = block.match(/^(#{1,6})\s+([^\n]*)(?:\n([\s\S]*))?$/);
      if (m) return `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>` + (m[3] ? miniMarkdown(m[3]) : "");
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    }).join("");
  }).join("");
}

function pointerGet(obj, pointer) {
  if (!pointer || pointer === "/") return obj;
  return pointer.replace(/^\//, "").split("/").reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), obj);
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function pointerSet(obj, pointer, value) {
  const keys = pointer.replace(/^\//, "").split("/").filter(Boolean);
  if (keys.some((k) => UNSAFE_KEYS.has(k))) return obj;
  if (!keys.length) return value;
  let o = obj;
  keys.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   onAction?: (action: any) => unknown,
 *   resolveAsset?: (asset: { drive_id: string, path: string, variant: string, mime: string, v?: number }) => string,
 *   assetBase?: string,
 * }} [opts]  resolveAsset: AINUI {$asset} → URL (default: aindrive's own fs routes under assetBase)
 */
export function createA2uiRenderer(container, { onAction, resolveAsset, assetBase = "" } = {}) {
  /** surfaceId → { components: Map, data: object } */
  const surfaces = new Map();

  /** A `Media` value (URL string or {$asset}) → a safe URL, or "". */
  function mediaUrl(v) {
    if (v && typeof v === "object" && v.$asset) {
      return safeMediaUrl(resolveAsset ? resolveAsset(v.$asset) : aindriveAssetUrl(v.$asset, assetBase));
    }
    return safeMediaUrl(v);
  }

  function kindIcon(kind) {
    const i = document.createElement("span");
    i.className = "a2ui-kind-icon";
    i.textContent = KIND_EMOJI[kind] || KIND_EMOJI.file;
    return i;
  }

  function resolve(v, surf, scope) {
    if (v && typeof v === "object" && typeof v.path === "string") {
      return v.path.startsWith("/") ? pointerGet(surf.data, v.path) : pointerGet(scope ?? {}, "/" + v.path);
    }
    if (v && typeof v === "object" && typeof v.call === "string") return "";
    return v;
  }

  function childIds(spec, surf, scope) {
    if (Array.isArray(spec)) return spec.map((id) => ({ id, scope }));
    if (spec && typeof spec === "object" && spec.componentId) {
      const list = resolve({ path: spec.path }, surf, scope);
      return Array.isArray(list) ? list.map((item) => ({ id: spec.componentId, scope: item })) : [];
    }
    return [];
  }

  function renderNode(surfaceId, id, scope) {
    const surf = surfaces.get(surfaceId);
    const c = surf?.components.get(id);
    const el = document.createElement("div");
    if (!c) { el.className = "a2ui-missing"; return el; }
    const kids = (spec, into) => childIds(spec, surf, scope).forEach((k) => into.appendChild(renderNode(surfaceId, k.id, k.scope)));
    switch (c.component) {
      case "Column":
      case "Row":
      case "List": {
        const dir = c.component === "Row" || c.direction === "horizontal" ? "row" : "column";
        el.className = `a2ui-${c.component.toLowerCase()}`;
        el.style.flexDirection = dir;
        if (c.align) el.style.alignItems = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch" }[c.align] || "";
        if (c.justify) el.style.justifyContent = { start: "flex-start", end: "flex-end", center: "center", spaceBetween: "space-between", spaceAround: "space-around", spaceEvenly: "space-evenly" }[c.justify] || "";
        kids(c.children, el);
        break;
      }
      case "Card":
        el.className = "a2ui-card";
        el.appendChild(renderNode(surfaceId, c.child, scope));
        break;
      case "Text": {
        const v = c.variant || "body";
        const t = resolve(c.text, surf, scope) ?? "";
        el.className = `a2ui-text a2ui-text-${v}`;
        if (/^h[1-5]$/.test(v) || v === "mono") el.textContent = String(t);
        else el.innerHTML = miniMarkdown(t);
        break;
      }
      case "Icon":
        el.className = "a2ui-icon";
        el.textContent = typeof c.name === "string" ? (ICON_EMOJI[c.name] || "•") : "•";
        break;
      case "Divider":
        el.className = "a2ui-divider";
        break;
      case "Image": {
        const img = document.createElement("img");
        const safe = mediaUrl(resolve(c.url, surf, scope));
        if (safe && !/^data:(video|audio)/.test(safe)) img.src = safe;
        img.alt = String(resolve(c.description, surf, scope) ?? "");
        img.className = "a2ui-image";
        el.appendChild(img);
        break;
      }
      case "TextField": {
        const label = document.createElement("label");
        label.className = "a2ui-textfield";
        const span = document.createElement("span");
        span.textContent = String(resolve(c.label, surf, scope) ?? "");
        const long = c.variant === "longText";
        const input = document.createElement(long ? "textarea" : "input");
        if (long) { input.rows = 14; label.classList.add("a2ui-textfield-long"); }
        input.value = String(resolve(c.value, surf, scope) ?? "");
        input.placeholder = span.textContent;
        if (c.value && typeof c.value.path === "string") {
          input.addEventListener("input", () => {
            if (c.value.path.startsWith("/")) pointerSet(surf.data, c.value.path, input.value);
            else if (scope) pointerSet(scope, "/" + c.value.path, input.value);
          });
        }
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || long) return;
          // Enter submits the nearest primary button's action, if any.
          const primary = [...surf.components.values()].find((x) => x.component === "Button" && x.variant === "primary");
          if (primary) fire(surfaceId, primary, scope);
        });
        label.append(span, input);
        el.appendChild(label);
        if (typeof c.weight === "number") el.style.flex = String(c.weight);
        return el;
      }
      case "Button": {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `a2ui-button a2ui-button-${c.variant || "default"}${c.tone === "danger" ? " a2ui-button-danger" : ""}`;
        b.appendChild(renderNode(surfaceId, c.child, scope));
        const question = c.confirm !== undefined ? String(resolve(c.confirm, surf, scope) ?? "") : "";
        b.addEventListener("click", () => {
          if (!question) return fire(surfaceId, c, scope);
          // Inline confirmation: sandboxed iframes (MCP Apps) block window.confirm.
          const ask = document.createElement("span");
          ask.className = "a2ui-confirm";
          const q = document.createElement("span");
          q.textContent = question;
          const no = document.createElement("button");
          no.type = "button"; no.className = "a2ui-button"; no.textContent = "Cancel";
          const yes = document.createElement("button");
          yes.type = "button"; yes.className = `a2ui-button${c.tone === "danger" ? " a2ui-button-danger" : " a2ui-button-primary"}`;
          yes.textContent = "OK";
          no.addEventListener("click", () => el.replaceChildren(b));
          yes.addEventListener("click", () => { el.replaceChildren(b); fire(surfaceId, c, scope); });
          ask.append(q, no, yes);
          el.replaceChildren(ask);
          no.focus();
        });
        el.appendChild(b);
        el.className = "a2ui-button-wrap";
        break;
      }
      // ── AINUI components ──
      case "Grid": {
        el.className = "a2ui-grid";
        const min = typeof c.minItemWidth === "number" && c.minItemWidth > 0 ? c.minItemWidth : 128;
        el.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))`;
        el.style.gap = `${typeof c.gap === "number" && c.gap >= 0 ? c.gap : 8}px`;
        kids(c.children, el);
        break;
      }
      case "Tile": {
        const kind = String(resolve(c.kind, surf, scope) ?? "file");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "a2ui-tile";
        const media = document.createElement("span");
        media.className = "a2ui-tile-media";
        const src = mediaUrl(resolve(c.media, surf, scope));
        if (src && !/^data:(video|audio)/.test(src)) {
          const img = document.createElement("img");
          img.loading = "lazy";
          img.alt = "";
          img.addEventListener("error", () => media.replaceChildren(kindIcon(kind)));
          img.src = src;
          media.appendChild(img);
        } else media.appendChild(kindIcon(kind));
        const label = document.createElement("span");
        label.className = "a2ui-tile-label";
        label.textContent = String(resolve(c.label, surf, scope) ?? "");
        b.title = label.textContent;
        b.append(media, label);
        const captionText = c.caption !== undefined ? String(resolve(c.caption, surf, scope) ?? "") : "";
        if (captionText) {
          const cap = document.createElement("span");
          cap.className = "a2ui-tile-caption";
          cap.textContent = captionText;
          b.appendChild(cap);
        }
        b.addEventListener("click", () => fire(surfaceId, c, scope));
        el.className = "a2ui-tile-wrap";
        el.appendChild(b);
        break;
      }
      case "FileView": {
        el.className = "a2ui-fileview";
        const name = String(resolve(c.name, surf, scope) ?? "");
        const mime = String(resolve(c.mime, surf, scope) ?? "");
        const size = resolve(c.size, surf, scope);
        const src = mediaUrl(resolve(c.src, surf, scope));
        const tag = !src ? "" : mime.startsWith("image/") ? "img" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "";
        if (tag) {
          const m = document.createElement(tag);
          m.className = `a2ui-fileview-${tag}`;
          if (tag === "img") m.alt = name;
          else { m.controls = true; m.preload = "metadata"; }
          m.src = src;
          el.appendChild(m);
        } else {
          const box = document.createElement("div");
          box.className = "a2ui-fileview-icon";
          box.appendChild(kindIcon(mime === "application/pdf" ? "pdf" : "file"));
          el.appendChild(box);
        }
        const info = document.createElement("div");
        info.className = "a2ui-fileview-info";
        const n = document.createElement("span");
        n.className = "a2ui-fileview-name";
        n.textContent = name;
        const sz = document.createElement("span");
        sz.className = "a2ui-text-caption";
        sz.textContent = humanSize(size);
        info.append(n, sz);
        el.appendChild(info);
        break;
      }
      case "Breadcrumbs": {
        el.className = "a2ui-breadcrumbs";
        el.setAttribute("role", "navigation");
        const items = resolve(c.items, surf, scope);
        (Array.isArray(items) ? items : []).forEach((item, i, all) => {
          if (i > 0) {
            const sep = document.createElement("span");
            sep.className = "a2ui-crumb-sep";
            sep.textContent = "›";
            el.appendChild(sep);
          }
          const label = String(item && item.label != null ? item.label : "");
          if (i === all.length - 1) {
            // The last crumb is where we are: plain text.
            const cur = document.createElement("span");
            cur.className = "a2ui-crumb a2ui-crumb-current";
            cur.textContent = label;
            el.appendChild(cur);
            return;
          }
          const b = document.createElement("button");
          b.type = "button";
          b.className = "a2ui-crumb";
          b.textContent = label;
          b.addEventListener("click", () => fire(surfaceId, c, item, { path: item && item.path }));
          el.appendChild(b);
        });
        break;
      }
      case "Segmented": {
        el.className = "a2ui-segmented";
        el.setAttribute("role", "group");
        const current = String(resolve(c.value, surf, scope) ?? "");
        for (const opt of Array.isArray(c.options) ? c.options : []) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "a2ui-segment";
          b.textContent = String(opt && opt.label != null ? opt.label : opt && opt.value);
          b.setAttribute("aria-pressed", String(opt && opt.value === current));
          b.addEventListener("click", () => {
            if (c.value && typeof c.value.path === "string") {
              if (c.value.path.startsWith("/")) pointerSet(surf.data, c.value.path, opt.value);
              else if (scope) pointerSet(scope, "/" + c.value.path, opt.value);
            }
            fire(surfaceId, c, scope, { value: opt.value });
          });
          el.appendChild(b);
        }
        break;
      }
      default:
        // Unknown component: draw its children if it has any, else nothing (AINUI §3).
        el.className = "a2ui-unknown";
        if (c.children) kids(c.children, el);
        else if (typeof c.child === "string") el.appendChild(renderNode(surfaceId, c.child, scope));
    }
    if (typeof c.weight === "number") el.style.flex = String(c.weight);
    return el;
  }

  function fire(surfaceId, c, scope, extra) {
    const ev = c.action && c.action.event;
    if (!ev || !onAction) return;
    const surf = surfaces.get(surfaceId);
    const context = {};
    for (const [k, v] of Object.entries(ev.context || {})) context[k] = resolve(v, surf, scope);
    Object.assign(context, extra || {});
    onAction({ name: ev.name, surfaceId, sourceComponentId: c.id, timestamp: new Date().toISOString(), context });
  }

  function render() {
    container.replaceChildren();
    for (const [surfaceId, surf] of surfaces) {
      if (!surf.components.has("root")) continue;
      const wrap = document.createElement("section");
      wrap.className = "a2ui-surface";
      wrap.appendChild(renderNode(surfaceId, "root", undefined));
      container.appendChild(wrap);
    }
  }

  /** Apply a batch of server→client messages, then re-render. */
  function process(messages) {
    for (const m of messages || []) {
      if (m.createSurface) surfaces.set(m.createSurface.surfaceId, { components: new Map(), data: {} });
      else if (m.updateComponents) {
        const s = surfaces.get(m.updateComponents.surfaceId);
        if (s) for (const c of m.updateComponents.components) s.components.set(c.id, c);
      } else if (m.updateDataModel) {
        const s = surfaces.get(m.updateDataModel.surfaceId);
        if (s) {
          const p = m.updateDataModel.path || "/";
          if (p === "/") s.data = m.updateDataModel.value ?? {};
          else pointerSet(s.data, p, m.updateDataModel.value);
        }
      } else if (m.deleteSurface) surfaces.delete(m.deleteSurface.surfaceId);
    }
    render();
  }

  /** Drop every surface and show just these messages (one result = one view). */
  function replace(messages) { surfaces.clear(); process(messages); }

  return { process, replace, surfaces };
}

export const A2UI_RENDERER_CSS = `
.a2ui-surface{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f1319}
.a2ui-column,.a2ui-row,.a2ui-list{display:flex;gap:8px}
.a2ui-list{gap:2px}
.a2ui-card{border:1px solid #dce3ec;border-radius:12px;padding:12px;background:#fff;overflow:auto;max-height:480px}
.a2ui-text p,.a2ui-text ul,.a2ui-text ol{margin:0 0 6px}.a2ui-text ul{list-style:disc;padding-left:20px}.a2ui-text ol{list-style:decimal;padding-left:20px}.a2ui-text h1,.a2ui-text h2,.a2ui-text h3{margin:4px 0}
.a2ui-text-h1{font-size:24px;font-weight:600}.a2ui-text-h2{font-size:20px;font-weight:600}.a2ui-text-h3{font-size:16px;font-weight:600}
.a2ui-text-caption{font-size:12px;color:#54607a}.a2ui-text-caption p{margin:0}
.a2ui-text pre{background:#f2f5f9;padding:8px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.a2ui-button{font:inherit;border:1px solid #dce3ec;background:#fff;border-radius:999px;padding:4px 12px;cursor:pointer}
.a2ui-button:hover{background:#eaeef4}
.a2ui-button-primary{background:#0b57d0;border-color:#0b57d0;color:#fff}.a2ui-button-primary:hover{background:#0842a0}
.a2ui-button-borderless{border:0;background:none;padding:2px 4px;text-align:left}.a2ui-button-borderless:hover{background:#eaeef4}
.a2ui-button .a2ui-text p{margin:0}
.a2ui-textfield{display:flex;flex-direction:column;flex:1}.a2ui-textfield span{display:none}
.a2ui-textfield input{font:inherit;border:1px solid #dce3ec;border-radius:999px;padding:4px 12px;min-width:120px}
.a2ui-image{max-width:100%;max-height:420px;object-fit:contain}
.a2ui-divider{border-top:1px solid #dce3ec;margin:4px 0}
.a2ui-row .a2ui-text-caption{white-space:nowrap}
.a2ui-button-danger{color:#b3261e;border-color:#f2b8b5}.a2ui-button-danger.a2ui-button-primary,.a2ui-confirm .a2ui-button-danger{background:#b3261e;border-color:#b3261e;color:#fff}
.a2ui-confirm{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.a2ui-text-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.a2ui-textfield-long{min-width:0}.a2ui-textfield-long textarea{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid #dce3ec;border-radius:12px;padding:8px 12px;resize:vertical;min-height:240px;width:100%;box-sizing:border-box}
.a2ui-row{flex-wrap:wrap}
.a2ui-grid{display:grid}
.a2ui-tile-wrap{min-width:0}
.a2ui-tile{display:flex;flex-direction:column;gap:4px;width:100%;font:inherit;color:inherit;text-align:left;border:0;background:none;padding:4px;border-radius:12px;cursor:pointer}
.a2ui-tile:hover,.a2ui-tile:focus-visible{background:#eaeef4}
.a2ui-tile-media{display:flex;align-items:center;justify-content:center;aspect-ratio:1;width:100%;border-radius:10px;overflow:hidden;background:#f2f5f9}
.a2ui-tile-media img{width:100%;height:100%;object-fit:cover}
.a2ui-tile-media .a2ui-kind-icon{font-size:40px}
.a2ui-tile-label{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a2ui-tile-caption{font-size:12px;color:#54607a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a2ui-fileview{display:flex;flex-direction:column;gap:8px}
.a2ui-fileview-img,.a2ui-fileview-video{max-width:100%;max-height:70vh;object-fit:contain;border-radius:10px;background:#f2f5f9}
.a2ui-fileview-audio{width:100%}
.a2ui-fileview-icon{display:flex;align-items:center;justify-content:center;height:160px;border-radius:10px;background:#f2f5f9;font-size:56px}
.a2ui-fileview-info{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.a2ui-fileview-name{font-weight:600;word-break:break-all}
.a2ui-breadcrumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;font-size:13px}
.a2ui-crumb{display:inline-flex;align-items:center;font:inherit;color:#0b57d0;border:0;background:none;padding:0 6px;border-radius:8px;cursor:pointer;min-height:36px;box-sizing:border-box}
.a2ui-crumb:hover{background:#eaeef4}.a2ui-crumb-current{color:inherit;font-weight:600;cursor:default}
.a2ui-crumb-sep{color:#54607a}
.a2ui-segmented{display:inline-flex;border:1px solid #dce3ec;border-radius:999px;overflow:hidden}
.a2ui-segment{font:inherit;border:0;background:#fff;color:inherit;padding:4px 14px;cursor:pointer;min-height:36px}
.a2ui-segment[aria-pressed=true]{background:#0b57d0;color:#fff}
@media (prefers-color-scheme:dark){.a2ui-surface{color:#e6e9ef}.a2ui-card,.a2ui-button,.a2ui-textfield input,.a2ui-textfield textarea,.a2ui-segment{background:#1b1f27;border-color:#343b48;color:inherit}.a2ui-segmented{border-color:#343b48}.a2ui-segment[aria-pressed=true]{background:#0b57d0;color:#fff}.a2ui-button:hover,.a2ui-button-borderless:hover,.a2ui-tile:hover,.a2ui-crumb:hover{background:#262c36}.a2ui-text pre,.a2ui-tile-media,.a2ui-fileview-icon,.a2ui-fileview-img,.a2ui-fileview-video{background:#262c36}.a2ui-text-caption,.a2ui-tile-caption,.a2ui-crumb-sep{color:#9aa4b8}.a2ui-crumb{color:#a8c7fa}.a2ui-button-danger{color:#f2b8b5;border-color:#8c1d18}}
`;
