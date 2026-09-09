/**
 * Exercises the built service worker against the real API, the way the content
 * script does: connect a port, send an "ask", collect the stream.
 *
 *   ANTHROPIC_API_KEY=sk-… npm run test:live
 *
 * Requires `npm run build` first — it loads dist/background.js, not src/.
 */

const REAL_KEY = process.env.ANTHROPIC_API_KEY;
const OLLAMA_URL = process.env.OLLAMA_TEST_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_TEST_MODEL || "llama3.2:latest";

let settings = {
  provider: "anthropic",
  apiKey: REAL_KEY,
  model: "claude-opus-5",
  effort: "low",
  ollamaUrl: OLLAMA_URL,
  ollamaModel: OLLAMA_MODEL,
};
const connectListeners = [];

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) =>
        Object.fromEntries(
          keys.filter((k) => settings[k] !== undefined && settings[k] !== null).map((k) => [k, settings[k]]),
        ),
    },
  },
  runtime: {
    onConnect: { addListener: (fn) => connectListeners.push(fn) },
    onMessage: { addListener: () => {} },
    openOptionsPage: () => {},
  },
  commands: { onCommand: { addListener: () => {} } },
  action: { onClicked: { addListener: () => {} } },
  tabs: { sendMessage: async () => {} },
};

await import(new URL("../dist/background.js", import.meta.url));

if (connectListeners.length !== 1) {
  throw new Error(`expected 1 onConnect listener, got ${connectListeners.length}`);
}

function run(payload) {
  const listeners = [];
  const received = [];
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const started = Date.now();
  let firstDelta = null;

  const port = {
    name: "select-explainer",
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => {
      if (msg.type === "delta" && firstDelta === null) firstDelta = Date.now() - started;
      received.push(msg);
      if (msg.type === "done" || msg.type === "error") resolveDone(msg);
    },
  };

  connectListeners[0](port);
  listeners.forEach((fn) => fn({ type: "ask", payload }));

  return Promise.race([
    done,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 90s")), 90_000)),
  ]).then((final) => ({
    final,
    firstDelta,
    text: received.filter((m) => m.type === "delta").map((m) => m.text).join(""),
  }));
}

const base = {
  selection: "eventual consistency",
  context:
    "Most distributed databases trade strict guarantees for availability. Under eventual consistency, replicas may briefly disagree, but converge on the same value once writes stop propagating.",
  pageTitle: "Notes on distributed systems",
  pageUrl: "https://example.com/notes",
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const ask = { ...base, turns: [{ role: "user", text: "Explain this." }] };
let r;

// ---- Claude API ------------------------------------------------------------
if (!REAL_KEY) {
  console.log("SKIP  Claude API tests (ANTHROPIC_API_KEY not set)");
} else {
  // Every offered model, since effort and fallbacks are gated per model and an
  // unsupported parameter is a 400, not a silent ignore.
  for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
    settings = { ...settings, provider: "anthropic", apiKey: REAL_KEY, model };
    r = await run(ask);
    check(
      `${model} streams an answer`,
      r.final.type === "done" && r.text.trim().length > 0,
      r.final.type === "done"
        ? `${r.firstDelta}ms to first token, ${r.final.usage.output} output tokens`
        : r.final.message,
    );
  }

  settings = { ...settings, model: "claude-haiku-4-5" };

  // Error paths — these surface in the popover, so they must be recognisable.
  settings = { ...settings, apiKey: "" };
  r = await run(ask);
  check("missing key prompts setup", r.final.type === "error" && r.final.needsSetup === true, r.final.message);

  settings = { ...settings, apiKey: "sk-ant-api03-obviously-not-a-real-key" };
  r = await run(ask);
  check("bad key prompts setup", r.final.type === "error" && r.final.needsSetup === true, r.final.message);

  // A follow-up inside the popover carries the prior turns.
  settings = { ...settings, apiKey: REAL_KEY };
  r = await run({
    ...base,
    turns: [
      { role: "user", text: "Explain this." },
      { role: "assistant", text: "Replicas converge on the same value once writes stop propagating." },
      { role: "user", text: "What is the opposite of it? Answer in one sentence." },
    ],
  });
  check("follow-up turn streams", r.final.type === "done" && r.text.trim().length > 0);
  check("follow-up answers in context", /strong|linear|immediate/i.test(r.text), r.text.trim().slice(0, 100));
}

// ---- Ollama ----------------------------------------------------------------
const ollamaUp = await fetch(`${OLLAMA_URL}/api/version`).then((r) => r.ok).catch(() => false);

if (!ollamaUp) {
  console.log(`SKIP  Ollama tests (nothing listening at ${OLLAMA_URL})`);
} else {
  settings = { ...settings, provider: "ollama", ollamaUrl: OLLAMA_URL, ollamaModel: OLLAMA_MODEL };

  r = await run(ask);
  check(
    `ollama ${OLLAMA_MODEL} streams an answer`,
    r.final.type === "done" && r.text.trim().length > 0,
    r.final.type === "done"
      ? `${r.firstDelta}ms to first token, ${r.final.usage.output} output tokens`
      : r.final.message,
  );
  check("ollama answer is marked local", r.final.local === true);
  check("ollama reports token usage", (r.final.usage?.output ?? 0) > 0, JSON.stringify(r.final.usage));

  r = await run({
    ...base,
    turns: [
      { role: "user", text: "Explain this." },
      { role: "assistant", text: "Replicas converge on the same value once writes stop propagating." },
      { role: "user", text: "What is the opposite of it? Answer in one sentence." },
    ],
  });
  check("ollama follow-up streams", r.final.type === "done" && r.text.trim().length > 0, r.text.trim().slice(0, 90));

  // A model that isn't pulled should say so, with the command to fix it.
  settings = { ...settings, ollamaModel: "definitely-not-pulled:latest" };
  r = await run(ask);
  check(
    "missing ollama model explains the fix",
    r.final.type === "error" && /ollama pull/.test(r.final.message),
    r.final.message,
  );

  // A dead server should not look like a model problem.
  settings = { ...settings, ollamaUrl: "http://127.0.0.1:1", ollamaModel: OLLAMA_MODEL };
  r = await run(ask);
  check(
    "unreachable ollama explains the fix",
    r.final.type === "error" && /ollama serve/.test(r.final.message),
    r.final.message,
  );
}

console.log(failures === 0 ? "\nlive: all OK" : `\nlive: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
