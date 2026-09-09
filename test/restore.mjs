/**
 * Simulates a page reload: storage already holds notes for this URL, the content
 * script starts fresh, and the highlights have to come back and stay clickable.
 */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

const URL_ = "https://example.com/doc";
const KEY = "notes:https://example.com/doc";

const dom = new JSDOM(
  `<!doctype html><html><body>
     <p id="one">The cache is cold. Latency is high here.</p>
     <p id="two">Under eventual consistency, replicas disagree.</p>
   </body></html>`,
  { url: URL_, pretendToBeVisual: true },
);
const { window } = dom;

// Notes as they would have been written on a previous visit.
const store = {
  [KEY]: [
    {
      id: "n1",
      exact: "Latency",
      prefix: "The cache is cold.",
      suffix: "is high here.",
      context: "The cache is cold. Latency is high here.",
      turns: [
        { role: "user", text: "Explain this." },
        { role: "assistant", text: "How long a request takes." },
      ],
      createdAt: 1,
    },
    {
      id: "n2",
      exact: "text that no longer exists on this page",
      prefix: "",
      suffix: "",
      context: "",
      turns: [{ role: "user", text: "Explain this." }, { role: "assistant", text: "Gone." }],
      createdAt: 2,
    },
  ],
};

const sent = [];
window.chrome = {
  runtime: {
    id: "test-extension",
    onMessage: { addListener: () => {} },
    connect: () => ({
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {} },
      postMessage: (m) => sent.push(m),
    }),
    sendMessage: async () => {},
  },
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => Object.assign(store, obj),
    },
  },
};

// jsdom has no layout. Give each anchored range a distinct box so the hit test
// for "did the user click a highlight" can be exercised.
const RECTS = {
  Latency: { left: 10, top: 10, right: 100, bottom: 30 },
};
window.Range.prototype.getClientRects = function () {
  const key = this.toString().replace(/\s+/g, " ").trim();
  return RECTS[key] ? [RECTS[key]] : [];
};
window.Element.prototype.getBoundingClientRect = () => ({
  left: 10, top: 10, right: 100, bottom: 30, width: 90, height: 20,
});

const context = vm.createContext(window);
vm.runInContext(source, context);
const evalIn = (expr) => vm.runInContext(expr, context);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// The restore runs asynchronously on startup.
await new Promise((r) => setTimeout(r, 10));

check("notes loaded from storage", evalIn("notes.length") === 2, `${evalIn("notes.length")} notes`);
check("the note whose text is present got anchored", !!evalIn("notes[0].range"));
check(
  "it anchored to the right text",
  evalIn("notes[0].range && notes[0].range.toString()") === "Latency",
  JSON.stringify(evalIn("notes[0].range && notes[0].range.toString()")),
);
check("saved answer came back with it", evalIn("notes[0].turns.length") === 2);
check("a note whose text vanished is kept but unanchored", evalIn("notes[1].range") === null);
check("vanished note is not deleted", evalIn("notes[1].id") === "n2");

// --- hit testing --------------------------------------------------------------
check("point inside the highlight finds the note", evalIn("noteAtPoint(50, 20)?.id") === "n1");
check("point outside finds nothing", evalIn("noteAtPoint(500, 500)") === null);
check("unanchored note is never hit", evalIn("noteAtPoint(50, 20)?.id") !== "n2");

// --- clicking a highlight reopens the saved answer ----------------------------
window.document.dispatchEvent(
  new window.MouseEvent("click", { bubbles: true, clientX: 50, clientY: 20 }),
);
await new Promise((r) => setTimeout(r, 0));

const shadow = evalIn("ui && ui.shadow");
check("clicking the highlight opened a panel", !!shadow && shadow.querySelector(".panel").style.display !== "none");
check("it shows the saved quote", shadow?.querySelector(".quote-text").textContent === "Latency");
check("it shows the saved turns", shadow?.querySelectorAll(".thread .turn").length === 2, `${shadow?.querySelectorAll(".thread .turn").length} turns`);
check("clicking a highlight does not re-ask", !sent.some((m) => m.type === "ask"));
check("the reopened note is the active one", evalIn("active && active.id") === "n1");

// --- clicking empty space closes without deleting -----------------------------
window.document.dispatchEvent(
  new window.MouseEvent("mousedown", { bubbles: true, clientX: 500, clientY: 500 }),
);
check("clicking away closes the panel", shadow.querySelector(".panel").style.display === "none");
check("both notes still present", evalIn("notes.length") === 2);

console.log(failures === 0 ? "\nrestore: all OK" : `\nrestore: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
