/**
 * Select Explainer — content script.
 *
 * Watches for a text selection, offers a pill button, and opens a popover holding a
 * short thread about the highlighted text. Once a highlight has been answered it
 * becomes a saved note: the text stays marked on the page, clicking the mark reopens
 * the answer, and it survives reloads until deleted. None of it ever enters the
 * conversation the user is reading.
 */

const MAX_SELECTION = 4000;
const MAX_CONTEXT = 4000;
const ANCHOR_CHARS = 40;
const HIGHLIGHT_NAME = "select-explainer";

/** SPA content often lands after document_idle; retry anchoring for a while. */
const ANCHOR_RETRIES = [400, 1200, 3000, 6000];

/** Containers that usually hold one whole chat message, worth preferring as context. */
const MESSAGE_SELECTORS = [
  "[data-message-author-role]",
  '[data-testid^="conversation-turn"]',
  "[data-test-render-count]",
  ".font-claude-message",
  ".font-claude-response",
];

let ui = null; // { host, shadow, pill, panel, els } — built lazily
let pending = null; // last observed selection: { text, context, rect, range }
let notes = []; // saved notes for this page; each may carry a live .range
let active = null; // the note currently open, or null for an unsaved highlight
let thread = []; // turns shown in the open popover
let port = null;
let streaming = false;

const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ storage

function pageKey() {
  return `notes:${location.origin}${location.pathname}${location.search}`;
}

/** Ranges are live DOM objects and can't be serialised — rebuild them on load. */
function serialisable(note) {
  const { range, ...rest } = note;
  return rest;
}

async function persist() {
  try {
    await chrome.storage.local.set({ [pageKey()]: notes.map(serialisable) });
  } catch {
    // Storage full or extension reloading — the popover still works this session.
  }
}

async function loadNotes() {
  try {
    const key = pageKey();
    const stored = await chrome.storage.local.get(key);
    notes = stored[key] ?? [];
  } catch {
    notes = [];
  }
}

// ------------------------------------------------------------- text anchoring

/** Flat text of the page plus the node each character came from. */
function textIndex() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, textarea")) return NodeFilter.FILTER_REJECT;
      if (ui && ui.host.contains(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let text = "";
  let node;
  while ((node = walker.nextNode())) {
    nodes.push({ node, start: text.length });
    text += node.nodeValue;
  }
  return { text, nodes };
}

/** Collapses whitespace while keeping a map back to raw offsets. */
function normalize(raw) {
  let norm = "";
  const map = [];
  let inSpace = false;
  let started = false;

  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (!started || inSpace) continue;
      norm += " ";
      map.push(i);
      inSpace = true;
    } else {
      norm += raw[i];
      map.push(i);
      inSpace = false;
      started = true;
    }
  }
  return { norm, map };
}

function positionAt(index, offset) {
  let low = 0;
  let high = index.nodes.length - 1;
  let found = index.nodes[0];
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index.nodes[mid].start <= offset) {
      found = index.nodes[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!found) return null;
  return { node: found.node, offset: Math.min(offset - found.start, found.node.nodeValue.length) };
}

/**
 * Re-finds a note's text in the current DOM. Tries the surrounding prefix and suffix
 * first so repeated phrases land on the right occurrence, then falls back to the
 * quote alone.
 */
function findRange(note) {
  const exact = collapse(note.exact);
  if (!exact || !document.body) return null;

  const index = textIndex();
  const { norm, map } = normalize(index.text);
  const prefix = collapse(note.prefix);
  const suffix = collapse(note.suffix);

  const candidates = [
    { text: `${prefix} ${exact} ${suffix}`.trim(), lead: prefix ? prefix.length + 1 : 0 },
    { text: `${prefix} ${exact}`.trim(), lead: prefix ? prefix.length + 1 : 0 },
    { text: `${exact} ${suffix}`.trim(), lead: 0 },
    { text: exact, lead: 0 },
  ];

  for (const candidate of candidates) {
    const at = norm.indexOf(candidate.text);
    if (at === -1) continue;
    const start = at + candidate.lead;
    const rawStart = map[start];
    const rawEnd = map[start + exact.length - 1] + 1;
    if (rawStart === undefined || rawEnd === undefined) continue;

    const from = positionAt(index, rawStart);
    const to = positionAt(index, rawEnd);
    if (!from || !to) continue;

    try {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range.collapsed ? null : range;
    } catch {
      continue;
    }
  }
  return null;
}

/** Derives prefix/suffix anchors from the passage we already captured. */
function anchorsFor(exact, context) {
  const nExact = collapse(exact);
  const nContext = collapse(context);
  const at = nContext.indexOf(nExact);
  if (at === -1) return { prefix: "", suffix: "" };
  return {
    prefix: nContext.slice(Math.max(0, at - ANCHOR_CHARS), at),
    suffix: nContext.slice(at + nExact.length, at + nExact.length + ANCHOR_CHARS),
  };
}

// ---------------------------------------------------------------- highlights

function highlightsSupported() {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
}

function ensureHighlightStyle() {
  if (!document.head || document.getElementById("select-explainer-style")) return;
  const style = document.createElement("style");
  style.id = "select-explainer-style";
  // Painted by the Custom Highlight API, so the page's own DOM is never mutated.
  style.textContent = `::highlight(${HIGHLIGHT_NAME}){background-color:rgba(201,100,66,.22);text-decoration:underline;text-decoration-color:rgba(201,100,66,.6);text-decoration-thickness:2px;text-underline-offset:2px;}`;
  document.head.append(style);
}

function paint() {
  if (!highlightsSupported()) return;
  ensureHighlightStyle();
  const ranges = notes.map((n) => n.range).filter(Boolean);
  if (!ranges.length) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

function anchorAll() {
  let anchored = 0;
  for (const note of notes) {
    if (note.range) {
      anchored++;
      continue;
    }
    note.range = findRange(note);
    if (note.range) anchored++;
  }
  paint();
  return anchored;
}

function noteAtPoint(x, y) {
  for (const note of notes) {
    if (!note.range) continue;
    for (const rect of note.range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return note;
    }
  }
  return null;
}

// ---------------------------------------------------------------- selection

function clampAround(text, needle, limit) {
  const clean = collapse(text);
  if (clean.length <= limit) return clean;
  const idx = clean.indexOf(collapse(needle).slice(0, 60));
  if (idx === -1) return clean.slice(0, limit) + "…";
  const start = Math.max(0, idx - Math.floor(limit / 2));
  const slice = clean.slice(start, start + limit);
  return (start > 0 ? "…" : "") + slice + (start + limit < clean.length ? "…" : "");
}

function extractContext(range, selectionText) {
  let node = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node) return selectionText;

  let el = node.closest?.(MESSAGE_SELECTORS.join(","));
  if (!el) {
    el = node;
    while (
      el.parentElement &&
      el.parentElement !== document.body &&
      (el.textContent || "").trim().length < 600
    ) {
      el = el.parentElement;
    }
  }
  return clampAround(el.textContent || selectionText, selectionText, MAX_CONTEXT);
}

/** Reads the current selection, including inside inputs and textareas. */
function readSelection() {
  const active_ = document.activeElement;
  if (
    active_ &&
    (active_.tagName === "TEXTAREA" || active_.tagName === "INPUT") &&
    typeof active_.selectionStart === "number" &&
    active_.selectionEnd > active_.selectionStart
  ) {
    const text = active_.value.slice(active_.selectionStart, active_.selectionEnd).trim();
    if (!text) return null;
    return {
      text: text.slice(0, MAX_SELECTION),
      context: clampAround(active_.value, text, MAX_CONTEXT),
      rect: active_.getBoundingClientRect(),
      range: null, // form fields can't carry a highlight
    };
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (ui && ui.host.contains(sel.anchorNode)) return null;

  const text = sel.toString().trim();
  if (text.length < 2) return null;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  return {
    text: text.slice(0, MAX_SELECTION),
    context: extractContext(range, text),
    rect,
    range: range.cloneRange(),
  };
}

// ------------------------------------------------------------------ styling

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }

:host {
  --bg: rgba(253, 253, 252, .97);
  --bg-solid: #fdfdfc;
  --fg: #1b1b1f;
  --muted: #71717a;
  --faint: #a1a1aa;
  --line: rgba(24, 24, 28, .08);
  --hover: rgba(24, 24, 28, .05);
  --accent: #c05b36;
  --accent-soft: rgba(192, 91, 54, .1);
  --code-bg: rgba(24, 24, 28, .05);
  --danger: #c0392b;
  --shadow: 0 0 0 1px rgba(24,24,28,.06), 0 2px 8px rgba(24,24,28,.06), 0 12px 32px rgba(24,24,28,.12);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: rgba(30, 30, 32, .95);
    --bg-solid: #1e1e20;
    --fg: #ededf0;
    --muted: #9d9da6;
    --faint: #6e6e78;
    --line: rgba(255, 255, 255, .09);
    --hover: rgba(255, 255, 255, .06);
    --accent: #e6906e;
    --accent-soft: rgba(230, 144, 110, .13);
    --code-bg: rgba(255, 255, 255, .07);
    --danger: #e57368;
    --shadow: 0 0 0 1px rgba(255,255,255,.08), 0 2px 8px rgba(0,0,0,.35), 0 16px 40px rgba(0,0,0,.45);
  }
}

.pill, .panel {
  position: fixed;
  z-index: 2147483647;
  color: var(--fg);
  background: var(--bg-solid);
  background: var(--bg);
  box-shadow: var(--shadow);
  backdrop-filter: blur(20px) saturate(1.6);
  -webkit-backdrop-filter: blur(20px) saturate(1.6);
}

.pill {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 6px 5px 11px;
  font-size: 12px; font-weight: 500; letter-spacing: .01em;
  cursor: pointer; user-select: none;
  border-radius: 999px;
  transition: transform .1s ease;
  animation: rise .12s cubic-bezier(.2, 0, 0, 1);
}
.pill:active { transform: translateY(1px) scale(.97); }
.pill svg { width: 12px; height: 12px; color: var(--accent); }
.pill kbd {
  font-size: 9.5px; color: var(--faint);
  border: 1px solid var(--line); border-radius: 4px;
  padding: 2px 4px; font-family: ui-monospace, SFMono-Regular, monospace;
}

.panel {
  width: 400px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column;
  overflow: hidden;
  border-radius: 12px;
  font-size: 13px; line-height: 1.55;
  animation: rise .15s cubic-bezier(.2, 0, 0, 1);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(4px) scale(.985); }
}
@media (prefers-reduced-motion: reduce) {
  .pill, .panel { animation: none; }
  * { transition: none !important; }
}

/* ---- selection header: rail inks in when the thread becomes a saved note ---- */
.quote {
  padding: 9px 10px 9px 12px;
  border-bottom: 1px solid var(--line);
  border-left: 2px solid var(--line);
  transition: border-left-color .35s ease;
  display: flex; gap: 6px; align-items: flex-start;
  max-height: 62px; overflow: hidden;
}
.panel.saved .quote { border-left-color: var(--accent); }
.quote-body { flex: 1; min-width: 0; }
.quote-label {
  display: block;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 9px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--faint); margin-bottom: 2px;
  transition: color .35s ease;
}
.panel.saved .quote-label { color: var(--accent); }
.quote-text {
  display: block; font-size: 12px; color: var(--muted);
  overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.icon {
  border: 0; background: transparent; color: var(--faint);
  cursor: pointer; padding: 3px 5px; border-radius: 5px;
  flex-shrink: 0; line-height: 1; font-size: 13px;
  transition: transform .1s ease;
}
.icon:hover { background: var(--hover); color: var(--fg); }
.icon:active { transform: scale(.92); }
.icon.delete:hover { color: var(--danger); }
.icon svg { width: 12px; height: 12px; display: block; }

/* ---- the command input: borderless, the row is the affordance ---- */
.ask { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 4px; border-bottom: 1px solid var(--line); }
.ask input {
  flex: 1; border: 0; background: transparent;
  padding: 10px 8px; font-size: 13.5px; color: var(--fg);
  outline: none;
}
.ask input::placeholder { color: var(--faint); }
.ask button {
  border: 1px solid var(--line); border-radius: 5px;
  background: transparent; color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px;
  padding: 3px 6px; cursor: pointer;
  transition: transform .1s ease;
}
.ask button:hover { color: var(--fg); background: var(--hover); }
.ask button:active { transform: scale(.94); }
.ask button:disabled { opacity: .4; cursor: default; }

.quote, .ask, .footer { flex-shrink: 0; }
.thread { padding: 0 12px; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.thread:empty { display: none; }
.turn { padding: 9px 0; border-top: 1px solid var(--line); }
.turn:first-child { border-top: 0; }
.turn.user { color: var(--muted); font-size: 12px; }
.turn.user::before { content: "› "; color: var(--accent); }
.turn.error { color: var(--danger); font-size: 12px; }

.answer p { margin: 0 0 8px; }
.answer p:last-child { margin-bottom: 0; }
.answer ul { margin: 0 0 8px; padding-left: 18px; }
.answer li { margin: 2px 0; }
.answer code {
  background: var(--code-bg); border-radius: 4px;
  padding: 1px 4px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px;
}
.answer pre {
  background: var(--code-bg); border-radius: 6px;
  padding: 8px 10px; overflow-x: auto; margin: 0 0 8px;
}
.answer pre code { background: none; padding: 0; }
.answer strong { font-weight: 600; }

.cursor {
  display: inline-block; width: 6px; height: 13px;
  background: var(--accent); vertical-align: text-bottom;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink { to { visibility: hidden; } }

.footer {
  padding: 7px 12px 8px; display: flex; justify-content: space-between;
  gap: 10px; align-items: baseline;
}
.footer .status {
  flex: 1; min-width: 0;
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 10px; color: var(--faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.footer .actions { display: flex; gap: 12px; flex-shrink: 0; }
.footer a {
  font-size: 11px; color: var(--muted); cursor: pointer;
  text-decoration: none; white-space: nowrap;
}
.footer a:hover { color: var(--accent); }
`;

// -------------------------------------------------------- markdown (subset)

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function renderMarkdown(text) {
  const blocks = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9]*\n/, "");
      blocks.push(`<pre><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    for (const chunk of part.split(/\n{2,}/)) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const lines = trimmed.split("\n");
      if (lines.every((l) => /^\s*[-*+]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^\s*[-*+]\s+/, ""))}</li>`).join("");
        blocks.push(`<ul>${items}</ul>`);
      } else {
        blocks.push(`<p>${inline(lines.join(" "))}</p>`);
      }
    }
  });
  return blocks.join("");
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// ----------------------------------------------------------------- building

const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`;

function buildUI() {
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: static;";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  shadow.append(style);

  const pill = document.createElement("div");
  pill.className = "pill";
  pill.style.display = "none";
  const shortcut = /Mac|iP/.test(navigator.platform) ? "⌘⇧E" : "Ctrl⇧E";
  pill.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <span>Ask</span><kbd>${shortcut}</kbd>`;
  pill.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  pill.addEventListener("click", () => openPanel());

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="quote">
      <div class="quote-body">
        <span class="quote-label">Highlight</span>
        <span class="quote-text"></span>
      </div>
      <button class="icon delete" title="Delete this note">${TRASH_ICON}</button>
      <button class="icon close" title="Close (Esc)">✕</button>
    </div>
    <div class="ask">
      <input type="text" placeholder="Ask anything about this…" />
      <button type="submit" title="Send (Enter)">↵</button>
    </div>
    <div class="thread"></div>
    <div class="footer">
      <span class="status"></span>
      <span class="actions">
        <a class="attach" title="Put this thread in the message box so you can send it yourself">Attach to chat</a>
        <a class="settings">Settings</a>
      </span>
    </div>`;

  shadow.append(pill, panel);
  document.documentElement.append(host);

  const els = {
    quote: panel.querySelector(".quote-text"),
    thread: panel.querySelector(".thread"),
    input: panel.querySelector(".ask input"),
    send: panel.querySelector(".ask button"),
    status: panel.querySelector(".status"),
    delete: panel.querySelector(".icon.delete"),
    attach: panel.querySelector(".attach"),
  };

  panel.querySelector(".icon.close").addEventListener("click", closePanel);
  els.delete.addEventListener("click", deleteActive);
  els.attach.addEventListener("click", attachToChat);
  panel.querySelector(".settings").addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {}),
  );

  els.send.addEventListener("click", () => submitInput());
  els.input.addEventListener("keydown", (e) => {
    // Escape has to be handled here: the input is focused on open, and the
    // stopPropagation below would otherwise keep it from reaching any ancestor.
    if (e.key === "Escape") {
      e.stopPropagation();
      closePanel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      submitInput();
    }
    e.stopPropagation(); // don't let the host page's shortcuts eat typing
  });

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePanel();
    }
  });

  ui = { host, shadow, pill, panel, els };
  return ui;
}

const PANEL_MAX_HEIGHT = 560; // don't let a huge monitor produce a wall of panel
const PANEL_MIN_HEIGHT = 220; // below this the popover is unusable — take over instead

/**
 * Placement rules, in order of importance:
 * 1. Never cover the highlighted text: pick the side of the selection with more
 *    room, and ANCHOR to that side (top when below, bottom when above) so the
 *    panel grows away from the text as answers stream in — never over it.
 * 2. Never lose the bottom of the panel: max-height is capped to the anchored
 *    side's available space, and the thread scrolls internally, so the input and
 *    footer always stay on screen.
 * 3. Only when neither side has usable room (tiny window), pin to the viewport
 *    bottom — the one case where overlapping the text is the lesser evil.
 */
function place(el, rect) {
  const margin = 8;
  const gap = 10;
  el.style.display = "";
  el.style.visibility = "hidden";
  el.style.top = "";
  el.style.bottom = "";
  el.style.maxHeight = "";

  const { width } = el.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  el.style.left = `${Math.round(left)}px`;

  if (!el.classList.contains("panel")) {
    // The pill is small and fixed-size: plain below-then-above flip.
    const { height } = el.getBoundingClientRect();
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - gap);
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = "visible";
    return;
  }

  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;

  if (Math.max(spaceBelow, spaceAbove) < PANEL_MIN_HEIGHT) {
    el.style.bottom = `${margin}px`;
    el.style.maxHeight = `${Math.max(PANEL_MIN_HEIGHT, window.innerHeight - 2 * margin)}px`;
  } else if (spaceBelow >= PANEL_MIN_HEIGHT || spaceBelow >= spaceAbove) {
    el.style.top = `${Math.round(rect.bottom + gap)}px`;
    el.style.maxHeight = `${Math.round(Math.min(spaceBelow, PANEL_MAX_HEIGHT))}px`;
  } else {
    // Bottom-anchored: streamed answers push the panel upward, away from the text.
    el.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
    el.style.maxHeight = `${Math.round(Math.min(spaceAbove, PANEL_MAX_HEIGHT))}px`;
  }
  el.style.visibility = "visible";
}

// ------------------------------------------------------------------ actions

function showPill(selection) {
  const { pill } = ui || buildUI();
  place(pill, selection.rect);
}

function hidePill() {
  if (ui) ui.pill.style.display = "none";
}

function isPanelOpen() {
  return ui && ui.panel.style.display !== "none";
}

function setStatus(text) {
  ui.els.status.textContent = text;
}

function renderThread() {
  ui.els.thread.innerHTML = "";
  for (const turn of thread) {
    const div = document.createElement("div");
    div.className = `turn ${turn.role}`;
    if (turn.role === "assistant") {
      div.classList.add("answer");
      div.innerHTML = renderMarkdown(turn.text);
    } else {
      div.textContent = turn.text;
    }
    ui.els.thread.append(div);
  }
  ui.els.thread.scrollTop = ui.els.thread.scrollHeight;
}

function showPanel(rect) {
  const state = ui || buildUI();
  hidePill();
  state.els.input.value = "";
  state.els.input.placeholder = thread.length ? "Follow up…" : "Ask anything about this…";
  renderThread();
  updateActions();
  place(state.panel, rect);
  state.els.input.focus();

  // Give a local model a head start: it can load while the question is still
  // being chosen. No-op for the hosted API, and skipped in an orphaned tab.
  connect()?.postMessage({ type: "warm" });
}

/** Opens a fresh popover for a newly highlighted passage. */
function openPanel(selection = pending) {
  if (!selection) return;
  pending = selection;
  active = null;
  thread = [];
  const state = ui || buildUI();
  state.els.quote.textContent = selection.text;
  setStatus("Not added to your conversation");
  showPanel(selection.rect);
}

/** Reopens a saved note with the answer already in it. */
function openNote(note) {
  const state = ui || buildUI();
  active = note;
  pending = { text: note.exact, context: note.context, rect: null, range: note.range };
  thread = note.turns.map((t) => ({ ...t }));
  state.els.quote.textContent = note.exact;
  setStatus("Saved · not added to your conversation");

  const rect = note.range?.getClientRects()[0] ??
    note.range?.getBoundingClientRect() ?? { left: 40, top: 40, bottom: 80 };
  showPanel(rect);
}

function closePanel() {
  if (!ui) return;
  if (streaming) port?.postMessage({ type: "cancel" });
  streaming = false;
  ui.panel.style.display = "none";
  ui.els.send.disabled = false;
  thread = [];
  active = null;
}

async function deleteActive() {
  if (!active) {
    closePanel();
    return;
  }
  notes = notes.filter((n) => n.id !== active.id);
  active = null;
  paint();
  closePanel();
  await persist();
}

function submitInput() {
  const value = ui.els.input.value.trim();
  if (value) ask(value);
}

// ------------------------------------------------- attaching back to the chat

/**
 * Composers on the big chat sites, most specific first. ChatGPT and Claude both use
 * a contenteditable rather than a textarea now, so both shapes have to work.
 */
const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  'div.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'form textarea:not([readonly]):not([disabled])',
  'textarea[placeholder]:not([readonly]):not([disabled])',
];

/** `contenteditable="plaintext-only"` is a real composer too, and some hosts only
 *  ever set the attribute. Don't rely on `isContentEditable` alone. */
function isEditable(el) {
  return Boolean(
    el.isContentEditable ||
      /^(true|plaintext-only)$/i.test(el.getAttribute?.("contenteditable") || ""),
  );
}

function isUsable(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (ui && ui.host.contains(el)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findComposer() {
  for (const selector of COMPOSER_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (isUsable(el)) return el;
    }
  }
  return null;
}

/** Renders the side-thread as something worth pasting into the main conversation. */
function formatThread() {
  const lines = ["Side-note I worked through while reading:", "", `> ${collapse(pending?.text)}`, ""];
  for (const turn of thread) {
    lines.push(`${turn.role === "user" ? "Q" : "A"}: ${turn.text}`, "");
  }
  return lines.join("\n");
}

/**
 * React and ProseMirror both ignore direct value/textContent writes — the text
 * appears but the composer's own state never updates, so it sends empty. Go through
 * the native setter or execCommand so real input events fire.
 */
function insertIntoComposer(el, text) {
  el.focus();

  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
    const next = el.value.trim() ? `${el.value.replace(/\s+$/, "")}\n\n${text}` : text;
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      el.selectionStart = el.selectionEnd = el.value.length;
    } catch {
      // Some inputs don't expose a selection; harmless.
    }
    return true;
  }

  if (isEditable(el)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // caret to the end, so we append rather than replace
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const body = el.textContent.trim() ? `\n\n${text}` : text;
    try {
      return document.execCommand("insertText", false, body) !== false;
    } catch {
      return false;
    }
  }

  return false;
}

async function attachToChat() {
  if (!thread.some((t) => t.role === "assistant")) return;
  const text = formatThread();

  const composer = findComposer();
  if (composer && insertIntoComposer(composer, text)) {
    composer.scrollIntoView?.({ block: "nearest" });
    setStatus("Added to the message box. Review it, then send.");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("No message box on this page. Copied instead.");
  } catch {
    setStatus("Couldn't attach it. Copy the answer manually.");
  }
}

/** Attaching only means something once there's an answer to attach. */
function updateActions() {
  if (!ui) return;
  const answered = thread.some((t) => t.role === "assistant");
  ui.els.attach.style.display = answered ? "" : "none";
  ui.els.delete.style.display = active ? "" : "none";
  ui.panel.classList.toggle("saved", Boolean(active)); // inks the quote rail
}

function appendTurn(role, text) {
  const div = document.createElement("div");
  div.className = `turn ${role}`;
  if (role === "assistant") div.classList.add("answer");
  div.textContent = text;
  ui.els.thread.append(div);
  ui.els.thread.scrollTop = ui.els.thread.scrollHeight;
  return div;
}

/** Creates the note on the first answer, then keeps it in step with the thread. */
async function saveThread() {
  if (active) {
    active.turns = thread.map((t) => ({ ...t }));
  } else {
    const { prefix, suffix } = anchorsFor(pending.text, pending.context);
    active = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      exact: pending.text,
      prefix,
      suffix,
      context: pending.context,
      turns: thread.map((t) => ({ ...t })),
      createdAt: Date.now(),
      range: pending.range ?? null,
    };
    notes.push(active);
    paint();
  }
  updateActions();
  await persist();
}

/**
 * After the extension reloads or updates, content scripts already injected into
 * open tabs are orphaned: chrome.runtime.connect throws "context invalidated" and
 * every feature silently dies. That reads as "the reload never finished" — so say
 * what actually happened and how to fix it.
 */
function isOrphaned() {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: "select-explainer" });
  } catch {
    return null;
  }
  port.onDisconnect.addListener(() => {
    port = null;
    // If the worker died mid-answer, the panel would otherwise sit forever on a
    // disabled send button and "Thinking…" — fail loudly and let them retry.
    if (streaming && ui) {
      ui.els.send.disabled = false;
      appendTurn("error", "Lost the connection mid-answer. Ask again.");
      thread.pop(); // drop the unanswered question so a retry starts clean
      setStatus(active ? "Saved · not added to your conversation" : "Not added to your conversation");
      // After any already-scheduled paint, so the cursor can't be re-added.
      requestAnimationFrame(() => ui.els.thread.querySelector(".cursor")?.remove());
    }
    streaming = false;
  });
  return port;
}

function ask(question) {
  if (streaming || !pending) return;

  if (isOrphaned() || !connect()) {
    appendTurn("error", "Select Explainer was updated. Refresh this page to reconnect it.");
    return;
  }

  ui.els.input.value = "";
  ui.els.input.blur();
  appendTurn("user", question);
  thread.push({ role: "user", text: question });

  const answerEl = appendTurn("assistant", "");
  answerEl.innerHTML = '<span class="cursor"></span>';

  let raw = "";
  let frame = null;
  const paintAnswer = () => {
    frame = null;
    answerEl.innerHTML = renderMarkdown(raw) + '<span class="cursor"></span>';
    ui.els.thread.scrollTop = ui.els.thread.scrollHeight;
  };

  streaming = true;
  ui.els.send.disabled = true;
  setStatus("Thinking…");

  const connection = connect();
  const onMessage = (msg) => {
    if (msg.type === "delta") {
      raw += msg.text;
      if (!frame) frame = requestAnimationFrame(paintAnswer);
      return;
    }

    if (frame) cancelAnimationFrame(frame);
    connection.onMessage.removeListener(onMessage);
    streaming = false;
    ui.els.send.disabled = false;
    ui.els.input.placeholder = "Follow up…";
    ui.els.input.focus();

    if (msg.type === "error") {
      answerEl.remove();
      const err = appendTurn("error", msg.message);
      if (msg.needsSetup) {
        const link = document.createElement("a");
        link.textContent = " Open settings";
        link.style.cssText = "color: var(--accent); cursor: pointer;";
        link.addEventListener("click", () =>
          chrome.runtime.sendMessage({ type: "open-options" }).catch(() => {}),
        );
        err.append(link);
      }
      thread.pop(); // drop the unanswered question so a retry starts clean
      setStatus(active ? "Saved · not added to your conversation" : "Not added to your conversation");
      return;
    }

    answerEl.innerHTML = renderMarkdown(raw);
    thread.push({ role: "assistant", text: raw });
    setStatus(`${msg.local ? "local · " : ""}${msg.usage.output} tokens · saved on this page`);
    ui.els.thread.scrollTop = ui.els.thread.scrollHeight;
    updateActions();
    saveThread();
  };

  connection.onMessage.addListener(onMessage);
  connection.postMessage({
    type: "ask",
    payload: {
      selection: pending.text,
      context: pending.context,
      pageTitle: document.title,
      pageUrl: location.href,
      turns: thread,
    },
  });
}

// ----------------------------------------------------------------- wiring

document.addEventListener("mouseup", () => {
  // Let the browser settle the selection before reading it.
  setTimeout(() => {
    if (isPanelOpen()) return;
    const selection = readSelection();
    if (selection) {
      pending = selection;
      showPill(selection);
    } else {
      hidePill();
    }
  }, 10);
});

document.addEventListener("mousedown", (event) => {
  if (ui && event.composedPath().includes(ui.host)) return;
  hidePill();
  if (isPanelOpen() && !noteAtPoint(event.clientX, event.clientY)) closePanel();
});

document.addEventListener("click", (event) => {
  if (ui && event.composedPath().includes(ui.host)) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // the user is selecting, not opening a note
  const note = noteAtPoint(event.clientX, event.clientY);
  if (note) {
    event.preventDefault();
    openNote(note);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hidePill();
    if (isPanelOpen()) closePanel();
  }
});

document.addEventListener(
  "scroll",
  () => {
    if (!isPanelOpen()) hidePill();
  },
  true,
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "open-from-hotkey") return;
  const selection = readSelection() || pending;
  if (selection) openPanel(selection);
});

/**
 * Restore this page's notes. Content often arrives after document_idle on chat
 * apps, so retry until everything anchors.
 */
(async function restore() {
  await loadNotes();
  if (!notes.length) return;
  if (anchorAll() === notes.length) return;
  for (const delay of ANCHOR_RETRIES) {
    setTimeout(() => {
      if (notes.some((n) => !n.range)) anchorAll();
    }, delay);
  }
})();
