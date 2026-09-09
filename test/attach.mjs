/**
 * Tests attaching a side-thread back into the main conversation.
 *
 * The deliberate constraint: we never call the chat app's own API. Attaching means
 * writing into the page's composer and leaving the send to the user. The fragile
 * part is that React and ProseMirror ignore direct value writes, so these check the
 * events actually fire.
 */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

function boot(bodyHtml, { url = "https://chatgpt.com/c/abc" } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const copied = [];
  window.chrome = {
    runtime: {
    id: "test-extension",
      onMessage: { addListener: () => {} },
      connect: () => ({
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      }),
      sendMessage: async () => {},
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };

  // Everything is on-screen; jsdom does no layout.
  window.Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 300, bottom: 40, width: 300, height: 40,
  });

  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (t) => copied.push(t) },
    configurable: true,
  });

  // jsdom has no execCommand; record what a real browser would have been asked to do.
  const execCalls = [];
  window.document.execCommand = (cmd, _ui, value) => {
    execCalls.push({ cmd, value });
    const target = window.document.activeElement;
    if (target && target.isContentEditable) target.textContent += value;
    return true;
  };

  const context = vm.createContext(window);
  vm.runInContext(source, context);
  return { window, context, copied, execCalls, evalIn: (e) => vm.runInContext(e, context) };
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const THREAD = [
  { role: "user", text: "Explain this." },
  { role: "assistant", text: "Replicas converge once writes stop." },
  { role: "user", text: "What's the opposite?" },
  { role: "assistant", text: "Strong consistency." },
];

const PENDING = { text: "eventual consistency", context: "…", rect: null, range: null };

/** `pending` and `thread` are lexical bindings in the script, not context properties. */
const seed = (evalIn) => {
  evalIn(`pending = ${JSON.stringify(PENDING)}`);
  evalIn("thread.length = 0");
  for (const t of THREAD) evalIn(`thread.push(${JSON.stringify(t)})`);
};

// --- formatting ---------------------------------------------------------------
{
  const { context, evalIn } = boot(`<textarea id="c"></textarea>`);
  seed(evalIn);
  const text = context.formatThread();

  check("quotes the highlighted passage", text.includes("> eventual consistency"), JSON.stringify(text.split("\n")[2]));
  check("includes every question", (text.match(/^Q: /gm) || []).length === 2);
  check("includes every answer", (text.match(/^A: /gm) || []).length === 2);
  check("keeps question and answer order", text.indexOf("Q: Explain this.") < text.indexOf("A: Replicas converge"));
  check("labels it as a side-note", /side-note/i.test(text), text.split("\n")[0]);
}

// --- ChatGPT-style contenteditable composer -----------------------------------
{
  const { context, evalIn, execCalls } = boot(
    `<div id="prompt-textarea" contenteditable="true" role="textbox"></div>`,
  );
  seed(evalIn);
  const composer = context.document.getElementById("prompt-textarea");
  check("finds the ChatGPT composer", context.findComposer() === composer);

  const ok = context.insertIntoComposer(composer, "HELLO");
  check("insertion reports success", ok === true);
  check("went through execCommand, not a direct write", execCalls.length === 1, JSON.stringify(execCalls[0]?.cmd));
  check("inserted as text", execCalls[0]?.cmd === "insertText" && execCalls[0]?.value === "HELLO");
}

// --- appends rather than replacing existing draft ------------------------------
{
  const { context, evalIn, execCalls } = boot(
    `<div id="prompt-textarea" contenteditable="true" role="textbox">my half-written question</div>`,
  );
  seed(evalIn);
  const composer = context.document.getElementById("prompt-textarea");
  context.insertIntoComposer(composer, "APPENDED");

  check("existing draft is not destroyed", composer.textContent.includes("my half-written question"));
  check("new text is appended after a blank line", execCalls[0]?.value === "\n\nAPPENDED", JSON.stringify(execCalls[0]?.value));
}

// --- Claude-style ProseMirror --------------------------------------------------
{
  const { context } = boot(
    `<div class="ProseMirror" contenteditable="true" role="textbox"></div>`,
    { url: "https://claude.ai/chat/xyz" },
  );
  const found = context.findComposer();
  check("finds a ProseMirror composer", found?.classList.contains("ProseMirror"));
}

// --- React-controlled textarea -------------------------------------------------
{
  const { context, evalIn } = boot(`<form><textarea placeholder="Message"></textarea></form>`);
  seed(evalIn);
  const composer = context.findComposer();
  check("finds a textarea composer", composer?.tagName === "TEXTAREA");

  let inputEvents = 0;
  composer.addEventListener("input", () => inputEvents++);
  context.insertIntoComposer(composer, "TEXTAREA BODY");

  check("textarea value set", composer.value === "TEXTAREA BODY", JSON.stringify(composer.value));
  check("fires an input event so React sees it", inputEvents === 1, `${inputEvents} events`);
  check("caret left at the end", composer.selectionStart === composer.value.length);
}

// --- textarea with an existing draft -------------------------------------------
{
  const { context, evalIn } = boot(`<form><textarea placeholder="Message">draft</textarea></form>`);
  seed(evalIn);
  const composer = context.findComposer();
  composer.value = "draft";
  context.insertIntoComposer(composer, "MORE");
  check("textarea draft preserved and appended to", composer.value === "draft\n\nMORE", JSON.stringify(composer.value));
}

// --- our own popover is never mistaken for a composer --------------------------
{
  const { context, evalIn } = boot(`<p>no composer here</p>`, { url: "https://example.com/article" });
  seed(evalIn);
  context.openPanel({ text: "eventual consistency", context: "…", rect: { left: 0, top: 0, bottom: 40 } });
  check("popover's own input is not treated as the page composer", context.findComposer() === null);
}

// --- no composer falls back to the clipboard -----------------------------------
{
  const { context, evalIn, copied } = boot(`<p>just an article</p>`, { url: "https://example.com/article" });
  seed(evalIn);
  context.openPanel({ text: "eventual consistency", context: "…", rect: { left: 0, top: 0, bottom: 40 } });
  evalIn("thread.length = 0");
  for (const t of THREAD) evalIn(`thread.push(${JSON.stringify(t)})`);

  await context.attachToChat();
  check("copied to the clipboard instead", copied.length === 1);
  check("clipboard got the formatted thread", /Q: Explain this\./.test(copied[0] || ""));
  const status = evalIn("ui.shadow").querySelector(".status").textContent;
  check("status explains what happened", /copied/i.test(status), status);
}

// --- attaching into a real composer reports honestly ---------------------------
{
  const { context, evalIn } = boot(`<div id="prompt-textarea" contenteditable="true" role="textbox"></div>`);
  seed(evalIn);
  context.openPanel({ text: "eventual consistency", context: "…", rect: { left: 0, top: 0, bottom: 40 } });
  evalIn("thread.length = 0");
  for (const t of THREAD) evalIn(`thread.push(${JSON.stringify(t)})`);

  await context.attachToChat();
  const status = evalIn("ui.shadow").querySelector(".status").textContent;
  check("status says the user still has to send it", /review it, then send/i.test(status), status);
  check("nothing was sent on the user's behalf", !/sent\b/i.test(status), status);
}

// --- the button only appears once there's an answer ----------------------------
{
  const { context, evalIn } = boot(`<div id="prompt-textarea" contenteditable="true" role="textbox"></div>`);
  context.openPanel({ text: "eventual consistency", context: "…", rect: { left: 0, top: 0, bottom: 40 } });
  const shadow = evalIn("ui.shadow");
  check("attach hidden on a fresh popover", shadow.querySelector(".attach").style.display === "none");

  evalIn(`thread.push({role:"user",text:"Explain this."})`);
  context.updateActions();
  check("still hidden with only a question asked", shadow.querySelector(".attach").style.display === "none");

  evalIn(`thread.push({role:"assistant",text:"An answer."})`);
  context.updateActions();
  check("shown once an answer exists", shadow.querySelector(".attach").style.display !== "none");
}

console.log(failures === 0 ? "\nattach: all OK" : `\nattach: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
