/**
 * After the extension reloads, content scripts in already-open tabs are orphaned:
 * chrome.runtime.id disappears and connect() throws. The script must not crash,
 * and asking must explain that a page refresh reconnects it — otherwise a reload
 * just looks like the extension hanging forever.
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

// An orphaned context: no runtime id, and connect throws.
window.chrome = {
  runtime: {
    // id intentionally absent
    onMessage: { addListener: () => {} },
    connect: () => {
      throw new Error("Extension context invalidated.");
    },
    sendMessage: async () => {
      throw new Error("Extension context invalidated.");
    },
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
};

window.Element.prototype.getBoundingClientRect = () => ({
  left: 100, top: 200, right: 400, bottom: 240, width: 300, height: 40,
});

const context = vm.createContext(window);
vm.runInContext(source, context);
const evalIn = (expr) => vm.runInContext(expr, context);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

// Opening the popover fires the warm-up, which must not throw in an orphaned tab.
let threw = null;
try {
  context.openPanel({
    text: "eventual consistency",
    context: "Under eventual consistency, replicas may briefly disagree.",
    rect: { left: 100, top: 200, bottom: 240, right: 400, width: 300, height: 40 },
  });
} catch (e) {
  threw = e;
}
check("opening the popover survives an orphaned context", threw === null, threw?.message);

const shadow = evalIn("ui.shadow");
check("panel still renders", shadow.querySelector(".panel").style.display !== "none");

// Asking must fail loudly and helpfully, not silently.
threw = null;
try {
  context.ask("Explain this.");
} catch (e) {
  threw = e;
}
check("asking survives an orphaned context", threw === null, threw?.message);

const error = shadow.querySelector(".turn.error");
check("an error turn is shown", !!error);
check(
  "it tells the user to refresh the page",
  /refresh this page/i.test(error?.textContent || ""),
  error?.textContent,
);
check("no request was left half-started", evalIn("streaming") === false);
check("the question was not queued into the thread", evalIn("thread.length") === 0, `${evalIn("thread.length")} turns`);

console.log(failures === 0 ? "\norphan: all OK" : `\norphan: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
