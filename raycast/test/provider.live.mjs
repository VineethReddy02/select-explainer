/**
 * Drives the Raycast extension's provider module against real providers — the
 * same role live.mjs plays for the Chrome service worker. Each half skips itself
 * when its provider isn't available.
 *
 *   node test/provider.live.mjs   (run from raycast/ after `npx esbuild` bundles it)
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, ".provider.bundle.mjs");
execSync(
  `npx esbuild ${path.join(here, "../src/provider.ts")} --bundle --platform=node --format=esm --outfile=${bundle}`,
  { cwd: path.join(here, ".."), stdio: "pipe" },
);
const { streamAnswer, formatThread, buildMessages } = await import(bundle);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

async function collect(prefs, turns) {
  const started = Date.now();
  let first = null;
  let text = "";
  const it = streamAnswer(prefs, "eventual consistency", "Slack", turns);
  while (true) {
    const r = await it.next();
    if (r.done) return { text, meta: r.value, firstDelta: first };
    if (first === null) first = Date.now() - started;
    text += r.value;
  }
}

const basePrefs = {
  provider: "ollama",
  ollamaUrl: process.env.OLLAMA_TEST_URL || "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_TEST_MODEL || "llama3.2:latest",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: "claude-opus-5",
  effort: "low",
};

// --- message shaping (offline) -------------------------------------------------
const messages = buildMessages("eventual consistency", "Slack", [
  { role: "user", text: "Explain this." },
]);
check("first turn names the source app", /Source: Slack/.test(messages[0].content));
check("first turn quotes the highlight", /eventual consistency/.test(messages[0].content));

const pasted = formatThread("eventual consistency", [
  { role: "user", text: "Explain this." },
  { role: "assistant", text: "Replicas converge." },
]);
check("formatted thread quotes the selection", /> eventual consistency/.test(pasted));
check("formatted thread keeps Q/A order", pasted.indexOf("Q:") < pasted.indexOf("A:"));

// --- ollama --------------------------------------------------------------------
const ollamaUp = await fetch(`${basePrefs.ollamaUrl}/api/version`).then((r) => r.ok).catch(() => false);
if (!ollamaUp) {
  console.log("SKIP  ollama (not running)");
} else {
  const r = await collect(basePrefs, [{ role: "user", text: "Explain this in one sentence." }]);
  check("ollama streams an answer", r.text.trim().length > 0, `${r.firstDelta}ms to first token`);
  check("ollama meta marks it local", r.meta.local === true && r.meta.outputTokens > 0, JSON.stringify(r.meta));

  let threw = null;
  try {
    await collect({ ...basePrefs, ollamaModel: "not-a-model:latest" }, [{ role: "user", text: "hi" }]);
  } catch (e) {
    threw = e;
  }
  check("missing model error names the fix", threw !== null && /ollama pull/.test(threw.message), threw?.message);
}

// --- anthropic -----------------------------------------------------------------
if (!basePrefs.anthropicApiKey) {
  console.log("SKIP  anthropic (no ANTHROPIC_API_KEY)");
} else {
  const r = await collect(
    { ...basePrefs, provider: "anthropic" },
    [{ role: "user", text: "Explain this in one sentence." }],
  );
  check("claude streams an answer", r.text.trim().length > 0, `${r.firstDelta}ms to first token`);
  check("claude meta is not local", r.meta.local === false && r.meta.outputTokens > 0, JSON.stringify(r.meta));

  let threw = null;
  try {
    await collect({ ...basePrefs, provider: "anthropic", anthropicApiKey: "" }, [{ role: "user", text: "hi" }]);
  } catch (e) {
    threw = e;
  }
  check("missing key error points at preferences", threw !== null && /preferences/i.test(threw.message), threw?.message);
}

console.log(failures === 0 ? "\nraycast provider: all OK" : `\nraycast provider: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
