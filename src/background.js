import Anthropic from "@anthropic-ai/sdk";

const DEFAULTS = {
  provider: "ollama",
  model: "claude-opus-5",
  effort: "low",
  maxTokens: 4000,
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2:latest",
};

// Feature gates for the hosted models. These differ per model and sending an
// unsupported parameter is a 400, not a silent ignore.
const MODELS = {
  "claude-opus-5": { effort: true, fallbacks: true },
  "claude-sonnet-5": { effort: true, fallbacks: false },
  "claude-haiku-4-5": { effort: false, fallbacks: false },
};

const SYSTEM = `You answer a single focused question about a passage the user highlighted while reading.

You are shown the highlighted text and the surrounding passage it came from. The
surrounding passage is context only — answer about the highlight.

Style:
- Answer immediately. No preamble, no restating the question, no "Great question".
- Two to four sentences for most questions. Use a short list only when the answer is genuinely a list.
- Plain language. Define a term the first time you use it.
- Markdown is rendered: use backticks for code and identifiers, ** for emphasis.
- If the highlight is ambiguous or the passage doesn't say, say so in one line rather than guessing.

This exchange is a disposable side-note, not part of the user's main conversation.
Do not suggest follow-up questions or offer to continue.`;

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS).concat("apiKey"));
  return { ...DEFAULTS, ...stored };
}

function buildUserContent({ selection, context, pageTitle, pageUrl, question }) {
  const parts = [];
  if (pageTitle || pageUrl) {
    parts.push(`Source: ${pageTitle || "(untitled)"}${pageUrl ? ` — ${pageUrl}` : ""}`);
  }
  if (context && context !== selection) {
    parts.push(`Surrounding passage:\n"""\n${context}\n"""`);
  }
  parts.push(`Highlighted text:\n"""\n${selection}\n"""`);
  parts.push(`Question: ${question}`);
  return parts.join("\n\n");
}

/**
 * The first turn carries the highlight and its context; follow-ups inside the same
 * popover are plain questions appended to that mini-thread.
 */
function buildMessages({ selection, context, pageTitle, pageUrl, turns }) {
  return turns.map((turn, i) =>
    turn.role === "user"
      ? {
          role: "user",
          content:
            i === 0
              ? buildUserContent({ selection, context, pageTitle, pageUrl, question: turn.text })
              : turn.text,
        }
      : { role: "assistant", content: turn.text },
  );
}

// ---------------------------------------------------------------- anthropic

let client = null;
let clientKey = null;

function getClient(apiKey) {
  if (client && clientKey === apiKey) return client;
  clientKey = apiKey;
  client = new Anthropic({
    apiKey,
    // The service worker is a browser context; the API also requires the
    // matching opt-in header for direct browser calls.
    dangerouslyAllowBrowser: true,
    defaultHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
    maxRetries: 1,
  });
  return client;
}

async function streamAnthropic(port, messages, settings, signal) {
  if (!settings.apiKey) {
    port.postMessage({
      type: "error",
      message: "No API key set. Open the extension options to add one.",
      needsSetup: true,
    });
    return;
  }

  const caps = MODELS[settings.model] ?? { effort: false, fallbacks: false };
  const params = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: SYSTEM,
    messages,
  };
  if (caps.effort) params.output_config = { effort: settings.effort };

  const anthropic = getClient(settings.apiKey);
  const stream = caps.fallbacks
    ? anthropic.beta.messages.stream(
        { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
        { signal },
      )
    : anthropic.messages.stream(params, { signal });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      port.postMessage({ type: "delta", text: event.delta.text });
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    port.postMessage({
      type: "error",
      message: `Declined to answer${final.stop_details?.category ? ` (${final.stop_details.category})` : ""}.`,
    });
    return;
  }

  port.postMessage({
    type: "done",
    model: final.model,
    local: false,
    usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
  });
}

// ------------------------------------------------------------------- ollama

/**
 * Ollama rejects a request whose Origin it doesn't recognise, and Chrome stamps
 * `chrome-extension://<id>` on ours. The bundled declarativeNetRequest rule strips
 * that header so this works with no setup — but if the rule didn't apply, the
 * server answers 403 and the user needs the one-time config below.
 */
export const OLLAMA_ORIGIN_HELP =
  'Ollama refused the request (403). Run: launchctl setenv OLLAMA_ORIGINS "chrome-extension://*" then restart Ollama.';

/**
 * Ollama evicts an idle model after 5 minutes, and reloading a 3B model from disk
 * costs ~18s — painful for exactly this sporadic-lookup pattern. Warm requests
 * answer in well under a second, so hold the model in memory between lookups.
 */
const KEEP_ALIVE = "30m";

function ollamaError(status, body, model) {
  if (status === 403) return { message: OLLAMA_ORIGIN_HELP, needsSetup: true };
  if (status === 404) {
    return {
      message: `Ollama doesn't have "${model}". Run: ollama pull ${model.replace(/:latest$/, "")}`,
      needsSetup: true,
    };
  }
  return { message: `Ollama error ${status}: ${body.slice(0, 200)}` };
}

/**
 * Fired when the popover opens, so the model loads while the user is still
 * reading the highlight or typing. Best-effort: failures surface on the real ask.
 */
async function warmOllama() {
  const settings = await getSettings();
  if (settings.provider !== "ollama") return;
  const base = settings.ollamaUrl.replace(/\/+$/, "");
  await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.ollamaModel, messages: [], keep_alive: KEEP_ALIVE }),
  }).catch(() => {});
}

async function streamOllama(port, messages, settings, signal) {
  const base = settings.ollamaUrl.replace(/\/+$/, "");

  let response;
  try {
    response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: settings.ollamaModel,
        stream: true,
        keep_alive: KEEP_ALIVE,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    port.postMessage({
      type: "error",
      message: `Can't reach Ollama at ${base}. Start it with: ollama serve — or switch to the Claude API in settings.`,
      needsSetup: true,
    });
    return;
  }

  if (!response.ok) {
    port.postMessage({
      type: "error",
      ...ollamaError(response.status, await response.text(), settings.ollamaModel),
    });
    return;
  }

  // Ollama streams newline-delimited JSON, one object per token.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = { input: 0, output: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a partial line; the next chunk completes it
      }
      if (event.error) {
        port.postMessage({ type: "error", message: `Ollama: ${event.error}` });
        return;
      }
      const text = event.message?.content;
      if (text) port.postMessage({ type: "delta", text });
      if (event.done) {
        usage = { input: event.prompt_eval_count ?? 0, output: event.eval_count ?? 0 };
      }
    }
  }

  port.postMessage({ type: "done", model: settings.ollamaModel, local: true, usage });
}

// -------------------------------------------------------------------- routing

async function runAsk(port, payload, signal) {
  const settings = await getSettings();
  const messages = buildMessages(payload);
  if (settings.provider === "ollama") {
    await streamOllama(port, messages, settings, signal);
  } else {
    await streamAnthropic(port, messages, settings, signal);
  }
}

function describeError(error) {
  if (error?.name === "AbortError") return null; // user cancelled — say nothing
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: "API key rejected. Check it in the extension options.", needsSetup: true };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { message: "Rate limited. Try again in a moment." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { message: `Request rejected: ${error.message}` };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { message: "Couldn't reach the API. Check your connection." };
  }
  if (error instanceof Anthropic.APIError) {
    return { message: `API error ${error.status}: ${error.message}` };
  }
  return { message: error?.message || "Something went wrong." };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "select-explainer") return;

  let controller = null;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "cancel") {
      controller?.abort();
      return;
    }
    if (msg.type === "warm") {
      warmOllama();
      return;
    }
    if (msg.type !== "ask") return;

    controller?.abort();
    controller = new AbortController();
    try {
      await runAsk(port, msg.payload, controller.signal);
    } catch (error) {
      const described = describeError(error);
      if (described) port.postMessage({ type: "error", ...described });
    }
  });

  port.onDisconnect.addListener(() => controller?.abort());
});

/** Used by the options page to list installed models and diagnose setup problems. */
async function probeOllama(url) {
  const base = (url || DEFAULTS.ollamaUrl).replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/api/tags`);
    if (response.status === 403) return { ok: false, reason: "origin", message: OLLAMA_ORIGIN_HELP };
    if (!response.ok) return { ok: false, reason: "http", message: `Ollama returned ${response.status}.` };
    const data = await response.json();
    return {
      ok: true,
      models: (data.models ?? []).map((m) => m.name).filter((n) => !/embed/i.test(n)),
    };
  } catch {
    return {
      ok: false,
      reason: "unreachable",
      message: `Can't reach Ollama at ${base}. Start it with: ollama serve`,
    };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg?.type === "probe-ollama") {
    probeOllama(msg.url).then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "ask-about-selection" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "open-from-hotkey" }).catch(() => {
    // No content script on this page (chrome:// pages, the web store) — nothing to do.
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
