/**
 * Pure-logic tests for the content script: the markdown subset (which writes into
 * innerHTML on the host page, so escaping is a security property) and the context
 * windowing helper. No DOM, no network.
 */
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

const noop = () => {};
const sandbox = {
  document: { addEventListener: noop, createElement: () => ({ style: {}, classList: { add: noop } }) },
  window: { innerWidth: 1280, innerHeight: 800 },
  chrome: { runtime: { onMessage: { addListener: noop }, connect: noop, sendMessage: noop } },
  Node: { TEXT_NODE: 3 },
  requestAnimationFrame: noop,
  cancelAnimationFrame: noop,
  console,
};
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(source, context);
const { renderMarkdown, clampAround } = context;

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
    failures++;
  }
}
function checkTruthy(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

console.log("--- markdown ---");
check("paragraph", renderMarkdown("Hello world."), "<p>Hello world.</p>");
check("two paragraphs", renderMarkdown("One.\n\nTwo."), "<p>One.</p><p>Two.</p>");
check("inline code", renderMarkdown("Use `foo()` here."), "<p>Use <code>foo()</code> here.</p>");
check("bold", renderMarkdown("This is **important**."), "<p>This is <strong>important</strong>.</p>");
check("bullet list", renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
check("fenced code with language", renderMarkdown("```js\nconst a = 1;\n```"), "<pre><code>const a = 1;</code></pre>");
check("soft-wrapped paragraph joins lines", renderMarkdown("line one\nline two"), "<p>line one line two</p>");

console.log("\n--- escaping (model output goes into innerHTML on the host page) ---");
check(
  "script tag in prose",
  renderMarkdown("Try <script>alert(1)</script> now."),
  "<p>Try &lt;script&gt;alert(1)&lt;/script&gt; now.</p>",
);
check(
  "img onerror",
  renderMarkdown('<img src=x onerror="alert(1)">'),
  "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
);
check(
  "html inside fenced code",
  renderMarkdown("```\n<script>alert(1)</script>\n```"),
  "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
);
check("html inside inline code", renderMarkdown("Use `<b>` tags."), "<p>Use <code>&lt;b&gt;</code> tags.</p>");
check("ampersand", renderMarkdown("A & B"), "<p>A &amp; B</p>");
checkTruthy(
  "only whitelisted tags are emitted",
  !/<(?!\/?(p|ul|li|code|pre|strong)\b)/.test(
    renderMarkdown("<div onclick=x>hi</div>\n\n- <span>y</span>\n\n```\n<a>\n```"),
  ),
);

console.log("\n--- streaming partials (the renderer runs on every delta) ---");
for (const partial of ["", "He", "Use `foo", "```js\nconst", "- one\n- tw", "**bol"]) {
  let threw = null;
  try {
    renderMarkdown(partial);
  } catch (e) {
    threw = e;
  }
  checkTruthy(`partial ${JSON.stringify(partial)} renders`, threw === null, threw?.message);
}

console.log("\n--- clampAround ---");
const long = "A".repeat(300) + " NEEDLE " + "B".repeat(300);
const clamped = clampAround(long, "NEEDLE", 200);
checkTruthy("keeps the highlight in view", clamped.includes("NEEDLE"), `len=${clamped.length}`);
checkTruthy("respects the limit", clamped.length <= 202, `len=${clamped.length}`);
check("short text passes through", clampAround("  hello   world ", "hello", 100), "hello world");
checkTruthy("missing needle still truncates", clampAround(long, "ZZZ", 50).length <= 51);

console.log(failures === 0 ? "\nunit: all OK" : `\nunit: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
