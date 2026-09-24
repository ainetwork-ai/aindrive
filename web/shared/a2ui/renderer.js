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
 * Plain ES module, browser-only APIs, no imports. Everything user-supplied is
 * written via textContent / escaped HTML; image URLs are limited to data:/https:.
 */

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
      let h = escapeHtml(p.trim());
      const m = h.match(/^(#{1,6})\s+(.*)$/);
      if (m) return `<h${m[1].length}>${m[2]}</h${m[1].length}>`;
      h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
      return `<p>${h.replace(/\n/g, "<br>")}</p>`;
    }).join("");
  }).join("");
}

function pointerGet(obj, pointer) {
  if (!pointer || pointer === "/") return obj;
  return pointer.replace(/^\//, "").split("/").reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), obj);
}

function pointerSet(obj, pointer, value) {
  const keys = pointer.replace(/^\//, "").split("/").filter(Boolean);
  if (!keys.length) return value;
  let o = obj;
  keys.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; });
  o[keys[keys.length - 1]] = value;
  return obj;
}

export function createA2uiRenderer(container, { onAction } = {}) {
  /** surfaceId → { components: Map, data: object } */
  const surfaces = new Map();

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
        if (/^h[1-5]$/.test(v)) el.textContent = String(t);
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
        const src = String(resolve(c.url, surf, scope) ?? "");
        const img = document.createElement("img");
        if (/^(data:image\/|https:\/\/)/.test(src)) img.src = src;
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
        const input = document.createElement("input");
        input.value = String(resolve(c.value, surf, scope) ?? "");
        input.placeholder = span.textContent;
        if (c.value && typeof c.value.path === "string") {
          input.addEventListener("input", () => {
            if (c.value.path.startsWith("/")) pointerSet(surf.data, c.value.path, input.value);
            else if (scope) pointerSet(scope, "/" + c.value.path, input.value);
          });
        }
        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
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
        b.className = `a2ui-button a2ui-button-${c.variant || "default"}`;
        b.appendChild(renderNode(surfaceId, c.child, scope));
        b.addEventListener("click", () => fire(surfaceId, c, scope));
        el.appendChild(b);
        el.className = "a2ui-button-wrap";
        break;
      }
      default:
        el.className = "a2ui-unsupported";
        el.textContent = `[${c.component}]`;
    }
    if (typeof c.weight === "number") el.style.flex = String(c.weight);
    return el;
  }

  function fire(surfaceId, c, scope) {
    const ev = c.action && c.action.event;
    if (!ev || !onAction) return;
    const surf = surfaces.get(surfaceId);
    const context = {};
    for (const [k, v] of Object.entries(ev.context || {})) context[k] = resolve(v, surf, scope);
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
.a2ui-text p{margin:0 0 6px}.a2ui-text h1,.a2ui-text h2,.a2ui-text h3{margin:4px 0}
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
@media (prefers-color-scheme:dark){.a2ui-surface{color:#e6e9ef}.a2ui-card,.a2ui-button,.a2ui-textfield input{background:#1b1f27;border-color:#343b48;color:inherit}.a2ui-button:hover,.a2ui-button-borderless:hover{background:#262c36}.a2ui-text pre{background:#262c36}.a2ui-text-caption{color:#9aa4b8}}
`;
