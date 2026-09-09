/**
 * Tests re-finding a saved note's text in the page after a reload.
 *
 * This is the load-bearing part of persistence: the stored note only has the quote
 * and a bit of surrounding text, and it has to land on the right occurrence even
 * when the phrase repeats, the markup splits it, or the whitespace differs.
 */
import { JSDOM } from "jsdom";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

const html = `<!doctype html><html><body>
  <p id="warm">The cache is warm.
     Latency is low here.</p>
  <p id="cold">The cache is cold. Latency is high here.</p>
  <p id="split">Under event<em>ual</em> <b>consistency</b>, replicas disagree.</p>
  <script>var ignored = "Latency";</script>
</body></html>`;

const dom = new JSDOM(html, { url: "https://example.com/a" });
const { window } = dom;

window.chrome = {
  runtime: { onMessage: { addListener: () => {} }, connect: () => ({}), sendMessage: async () => {} },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};

const context = vm.createContext(window);
vm.runInContext(source, context);
const { findRange, anchorsFor } = context;

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const paragraphOf = (range) => range?.startContainer?.parentElement?.closest("p")?.id;

// --- disambiguating a repeated phrase ----------------------------------------
const inWarm = findRange({ exact: "Latency", prefix: "The cache is warm.", suffix: "is low here." });
check("repeated phrase resolves via prefix (first occurrence)", paragraphOf(inWarm) === "warm", paragraphOf(inWarm));
check("range text matches the quote", inWarm?.toString().trim() === "Latency", JSON.stringify(inWarm?.toString()));

const inCold = findRange({ exact: "Latency", prefix: "The cache is cold.", suffix: "is high here." });
check("repeated phrase resolves via prefix (second occurrence)", paragraphOf(inCold) === "cold", paragraphOf(inCold));

// --- whitespace differences ---------------------------------------------------
// The saved quote is whitespace-collapsed; the DOM has a newline and indentation.
const acrossNewline = findRange({ exact: "warm. Latency is low", prefix: "The cache is", suffix: "here." });
check("matches across a newline and indentation", paragraphOf(acrossNewline) === "warm", paragraphOf(acrossNewline));
check(
  "range covers the whole quote",
  acrossNewline?.toString().replace(/\s+/g, " ").trim() === "warm. Latency is low",
  JSON.stringify(acrossNewline?.toString()),
);

// --- text broken up by inline markup ------------------------------------------
const split = findRange({ exact: "eventual consistency", prefix: "Under", suffix: ", replicas disagree." });
check("matches text split across inline elements", paragraphOf(split) === "split", paragraphOf(split));
check(
  "spans from the first fragment to the last",
  split?.toString().replace(/\s+/g, " ").trim() === "eventual consistency",
  JSON.stringify(split?.toString()),
);

// --- falls back to the quote alone when anchors have moved --------------------
const noAnchors = findRange({ exact: "replicas disagree", prefix: "totally different text", suffix: "gone too" });
check("falls back to the quote when anchors no longer match", paragraphOf(noAnchors) === "split", paragraphOf(noAnchors));

// --- genuinely absent text ----------------------------------------------------
check("returns null for text that isn't on the page", findRange({ exact: "nowhere to be found", prefix: "", suffix: "" }) === null);
check("returns null for an empty quote", findRange({ exact: "", prefix: "", suffix: "" }) === null);

// --- script contents are not searchable ---------------------------------------
const scripted = findRange({ exact: "var ignored", prefix: "", suffix: "" });
check("ignores text inside <script>", scripted === null);

// --- anchor extraction --------------------------------------------------------
const anchors = anchorsFor("Latency", "The cache is cold. Latency is high here.");
check("prefix captured from context", anchors.prefix.trim() === "The cache is cold.", JSON.stringify(anchors.prefix));
check("suffix captured from context", anchors.suffix.trim() === "is high here.", JSON.stringify(anchors.suffix));

const missing = anchorsFor("not in context", "some unrelated passage");
check("missing quote yields empty anchors", missing.prefix === "" && missing.suffix === "");

// --- a note anchored, then round-tripped through anchors ----------------------
const roundTrip = findRange({ exact: "Latency", ...anchorsFor("Latency", "The cache is cold. Latency is high here.") });
check("anchors derived from context find the right occurrence", paragraphOf(roundTrip) === "cold", paragraphOf(roundTrip));

console.log(failures === 0 ? "\nanchor: all OK" : `\nanchor: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
