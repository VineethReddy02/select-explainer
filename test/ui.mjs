/**
 * Drives the real content script inside jsdom: open the popover, click a quick
 * action, feed streamed deltas through a fake port, and assert on the DOM — then
 * on the note it leaves behind, reopening it, and deleting it.
 */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

const dom = new JSDOM(
  `<!doctype html><html><body><p>Under eventual consistency, replicas may briefly disagree.</p></body></html>`,
  { pretendToBeVisual: true, url: "https://example.com/notes" },
);
const { window } = dom;

const sent = [];
let portListeners = [];
const fakePort = {
  onMessage: {
    addListener: (fn) => portListeners.push(fn),
    removeListener: (fn) => (portListeners = portListeners.filter((f) => f !== fn)),
  },
  onDisconnect: { addListener: () => {} },
  postMessage: (m) => sent.push(m),
};

const store = {};
window.chrome = {
  runtime: {
    id: "test-extension",
    onMessage: { addListener: () => {} },
    connect: () => fakePort,
    sendMessage: async () => {},
  },
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => Object.assign(store, obj),
    },
  },
};

// jsdom does no layout; give every element a plausible box so positioning runs.
window.Element.prototype.getBoundingClientRect = () => ({
  left: 100, top: 200, right: 400, bottom: 240, width: 300, height: 40,
});

const context = vm.createContext(window);
vm.runInContext(source, context);

/** `let` bindings live in the script's lexical scope, not on the context object. */
const evalIn = (expr) => vm.runInContext(expr, context);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const settle = () => new Promise((r) => setTimeout(r, 0));

// --- open the popover on a highlight -----------------------------------------
context.openPanel({
  text: "eventual consistency",
  context: "Under eventual consistency, replicas may briefly disagree.",
  rect: { left: 100, top: 200, bottom: 240, right: 400, width: 300, height: 40 },
});

const host = window.document.documentElement.lastElementChild;
check("host element appended to the page", host && host.tagName === "DIV");

const asks = () => sent.filter((m) => m.type === "ask");
check("warm-up sent when the popover opens", sent.some((m) => m.type === "warm"));

const shadow = evalIn("ui.shadow"); // the shadow root is closed to the page
const panel = shadow.querySelector(".panel");
check("panel is visible", panel.style.display !== "none");
check("panel is positioned", !!panel.style.top && !!panel.style.left, `${panel.style.left} / ${panel.style.top}`);
check("quote shows the highlight", shadow.querySelector(".quote-text").textContent === "eventual consistency");
check("no quick-action clutter — just the input", shadow.querySelector(".menu") === null && !!shadow.querySelector(".ask input"));
check("delete icon hidden before anything is saved", shadow.querySelector(".icon.delete").style.display === "none");

// --- type a question and press Enter ------------------------------------------
{
  const askInput = shadow.querySelector(".ask input");
  askInput.value = "What does this mean?";
  askInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

check("one ask sent to the worker", asks().length === 1);
const payload = asks()[0]?.payload;
check("payload carries the highlight", payload?.selection === "eventual consistency");
check("payload carries surrounding context", /replicas may briefly disagree/.test(payload?.context || ""));
check("payload carries page metadata", payload?.pageUrl === "https://example.com/notes");
check("payload has exactly one user turn", payload?.turns.length === 1 && payload.turns[0].role === "user");
check("user turn rendered in the thread", !!shadow.querySelector(".turn.user"));
check("send button disabled while streaming", shadow.querySelector(".ask button").disabled === true);

// --- stream deltas back -------------------------------------------------------
for (const text of ["Replicas ", "agree **eventually**, not ", "immediately. Use `read_quorum` to force it."]) {
  portListeners.forEach((fn) => fn({ type: "delta", text }));
}
await new Promise((r) => window.requestAnimationFrame(r));

const answer = shadow.querySelector(".turn.assistant");
check("answer renders markdown bold", /<strong>eventually<\/strong>/.test(answer.innerHTML));
check("answer renders inline code", /<code>read_quorum<\/code>/.test(answer.innerHTML));
check("blinking cursor shown mid-stream", !!answer.querySelector(".cursor"));

portListeners.forEach((fn) => fn({ type: "done", model: "claude-opus-5", usage: { input: 400, output: 42 } }));
await settle();

check("cursor removed when done", !answer.querySelector(".cursor"));
check("send button re-enabled", shadow.querySelector(".ask button").disabled === false);
check("status says the note is saved", /saved on this page/i.test(shadow.querySelector(".status").textContent));
check("delete icon appears once saved", shadow.querySelector(".icon.delete").style.display !== "none");

// --- the answer becomes a note ------------------------------------------------
check("one note created", evalIn("notes.length") === 1, `${evalIn("notes.length")} notes`);
check("note records the highlighted text", evalIn("notes[0].exact") === "eventual consistency");
check("note captured anchoring context", evalIn("notes[0].prefix").length > 0, evalIn("JSON.stringify(notes[0].prefix)"));
check("note written to storage", Array.isArray(store["notes:https://example.com/notes"]), Object.keys(store).join(","));
check("stored note has no live Range (not serialisable)", !("range" in (store["notes:https://example.com/notes"]?.[0] ?? {})));

// --- follow-ups stay inside the popover ---------------------------------------
const input = shadow.querySelector(".ask input");
input.value = "Give an example.";
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

check("follow-up sent", asks().length === 2);
check(
  "follow-up includes the full mini-thread",
  asks()[1]?.payload.turns.map((t) => t.role).join(",") === "user,assistant,user",
  asks()[1]?.payload.turns.map((t) => t.role).join(","),
);
check("input cleared after sending", input.value === "");

portListeners.forEach((fn) => fn({ type: "delta", text: "Amazon DynamoDB." }));
await new Promise((r) => window.requestAnimationFrame(r));
portListeners.forEach((fn) => fn({ type: "done", model: "claude-opus-5", usage: { input: 1, output: 3 } }));
await settle();

check("still exactly one note after a follow-up", evalIn("notes.length") === 1);
check("note grew to four turns", evalIn("notes[0].turns.length") === 4, `${evalIn("notes[0].turns.length")} turns`);

// --- Escape closes but keeps the note ----------------------------------------
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

check("Escape closes the panel", panel.style.display === "none");
check("open thread cleared on close", evalIn("thread.length") === 0);
check("note survives closing", evalIn("notes.length") === 1);

// --- reopening a note shows the saved answer, without re-asking ---------------
const asksBeforeReopen = asks().length;
context.openNote(evalIn("notes[0]"));

check("reopened panel is visible", panel.style.display !== "none");
check("reopened panel shows the saved highlight", shadow.querySelector(".quote-text").textContent === "eventual consistency");
check("reopened panel renders all saved turns", shadow.querySelectorAll(".thread .turn").length === 4, `${shadow.querySelectorAll(".thread .turn").length} turns shown`);
check("reopened answer is rendered as markdown", /<strong>eventually<\/strong>/.test(shadow.querySelector(".thread .turn.assistant").innerHTML));
check("reopening does not re-ask", asks().length === asksBeforeReopen);
check("delete icon shown for a saved note", shadow.querySelector(".icon.delete").style.display !== "none");

// --- deleting removes it for good --------------------------------------------
shadow.querySelector(".icon.delete").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await settle();

check("note deleted", evalIn("notes.length") === 0);
check("panel closed after delete", panel.style.display === "none");
check("deletion persisted to storage", (store["notes:https://example.com/notes"] ?? []).length === 0);

// --- placement: growth must move away from the text, bottom never clipped ------
// jsdom window is 1024x768. Selection high on the page → panel below, top-anchored.
context.openPanel({
  text: "top selection",
  context: "top selection in context",
  rect: { left: 100, top: 100, bottom: 120, right: 300, width: 200, height: 20 },
});
check("selection near the top opens the panel below it", panel.style.top !== "" && panel.style.bottom === "",
  `top=${panel.style.top} bottom=${panel.style.bottom}`);
check("below placement clears the selection", parseInt(panel.style.top) >= 120, panel.style.top);
check("panel height capped to available space", parseInt(panel.style.maxHeight) > 0 &&
  120 + 10 + parseInt(panel.style.maxHeight) <= 768, `maxHeight=${panel.style.maxHeight}`);

// Selection near the bottom → panel above, bottom-anchored so it grows upward.
context.openPanel({
  text: "bottom selection",
  context: "bottom selection in context",
  rect: { left: 100, top: 700, bottom: 720, right: 300, width: 200, height: 20 },
});
check("selection near the bottom anchors the panel above it", panel.style.bottom !== "" && panel.style.top === "",
  `top=${panel.style.top} bottom=${panel.style.bottom}`);
check("above placement clears the selection", 768 - parseInt(panel.style.bottom) <= 700, panel.style.bottom);
check("above placement is height-capped too", parseInt(panel.style.maxHeight) > 0 &&
  parseInt(panel.style.maxHeight) <= 700 - 18, `maxHeight=${panel.style.maxHeight}`);

// A selection filling the whole window → last-resort pin, still fully on screen.
context.openPanel({
  text: "huge selection",
  context: "huge selection in context",
  rect: { left: 10, top: 60, bottom: 738, right: 900, width: 890, height: 678 },
});
check("tiny remaining space pins the panel to the viewport bottom", panel.style.bottom === "8px",
  `bottom=${panel.style.bottom}`);
check("pinned panel still fits the viewport", parseInt(panel.style.maxHeight) <= 768 - 16,
  `maxHeight=${panel.style.maxHeight}`);

console.log(failures === 0 ? "\nui: all OK" : `\nui: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
