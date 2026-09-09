/**
 * Provider logic shared in spirit with the Chrome extension's service worker —
 * same system prompt, same per-model gates, same Ollama behavior — kept free of
 * Raycast imports so it can be exercised with plain Node against real providers.
 */
import Anthropic from "@anthropic-ai/sdk";

export type Turn = { role: "user" | "assistant"; text: string };

export interface ProviderPrefs {
  provider: "ollama" | "anthropic";
  ollamaUrl: string;
  ollamaModel: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  effort: "low" | "medium" | "high";
}

export interface AnswerMeta {
  model: string;
  local: boolean;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM = `You answer a single focused question about a passage the user highlighted while reading.

You are shown the highlighted text and, when known, the app it came from. Answer
about the highlight.

Style:
- Answer immediately. No preamble, no restating the question, no "Great question".
- Two to four sentences for most questions. Use a short list only when the answer is genuinely a list.
- Plain language. Define a term the first time you use it.
- Markdown is rendered: use backticks for code and identifiers, ** for emphasis.
- If the highlight is ambiguous, say so in one line rather than guessing.

This exchange is a disposable side-note, not part of the user's main conversation.
Do not suggest follow-up questions or offer to continue.`;

// Sending an unsupported parameter is a 400, not a silent ignore.
const MODELS: Record<string, { effort: boolean; fallbacks: boolean }> = {
  "claude-opus-5": { effort: true, fallbacks: true },
  "claude-sonnet-5": { effort: true, fallbacks: false },
  "claude-haiku-4-5": { effort: false, fallbacks: false },
};

/** Ollama evicts idle models after 5 minutes; reloading a 3B model costs ~18s. */
const KEEP_ALIVE = "30m";

export function buildMessages(selection: string, source: string | undefined, turns: Turn[]) {
  return turns.map((turn, i) => {
    if (turn.role !== "user") return { role: "assistant" as const, content: turn.text };
    if (i > 0) return { role: "user" as const, content: turn.text };
    const parts = [];
    if (source) parts.push(`Source: ${source}`);
    parts.push(`Highlighted text:\n"""\n${selection}\n"""`);
    parts.push(`Question: ${turn.text}`);
    return { role: "user" as const, content: parts.join("\n\n") };
  });
}

/** Renders the side-thread as something worth pasting into a chat or doc. */
export function formatThread(selection: string, turns: Turn[]): string {
  const lines = [
    "Side-note I worked through while reading:",
    "",
    `> ${selection.replace(/\s+/g, " ").trim()}`,
    "",
  ];
  for (const turn of turns) lines.push(`${turn.role === "user" ? "Q" : "A"}: ${turn.text}`, "");
  return lines.join("\n");
}

async function* streamAnthropic(
  prefs: ProviderPrefs,
  messages: ReturnType<typeof buildMessages>,
): AsyncGenerator<string, AnswerMeta> {
  if (!prefs.anthropicApiKey) {
    throw new Error("The Claude API provider needs an API key — add one in Settings.");
  }
  const caps = MODELS[prefs.anthropicModel] ?? { effort: false, fallbacks: false };
  const client = new Anthropic({ apiKey: prefs.anthropicApiKey, maxRetries: 1 });

  const params = {
    model: prefs.anthropicModel,
    max_tokens: 4000,
    system: SYSTEM,
    messages,
    ...(caps.effort ? { output_config: { effort: prefs.effort } } : {}),
  };

  const stream = caps.fallbacks
    ? client.beta.messages.stream({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
    : client.messages.stream(params);

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error("Declined to answer.");
  return {
    model: final.model,
    local: false,
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
  };
}

async function* streamOllama(
  prefs: ProviderPrefs,
  messages: ReturnType<typeof buildMessages>,
): AsyncGenerator<string, AnswerMeta> {
  const base = prefs.ollamaUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: prefs.ollamaModel,
        stream: true,
        keep_alive: KEEP_ALIVE,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      }),
    });
  } catch {
    throw new Error(`Can't reach Ollama at ${base}. Start it with: ollama serve`);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Ollama doesn't have "${prefs.ollamaModel}". Run: ollama pull ${prefs.ollamaModel.replace(/:latest$/, "")}`,
      );
    }
    throw new Error(`Ollama error ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let meta: AnswerMeta = { model: prefs.ollamaModel, local: true, inputTokens: 0, outputTokens: 0 };

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
        continue;
      }
      if (event.error) throw new Error(`Ollama: ${event.error}`);
      if (event.message?.content) yield event.message.content;
      if (event.done) {
        meta = {
          model: prefs.ollamaModel,
          local: true,
          inputTokens: event.prompt_eval_count ?? 0,
          outputTokens: event.eval_count ?? 0,
        };
      }
    }
  }
  return meta;
}

export function streamAnswer(
  prefs: ProviderPrefs,
  selection: string,
  source: string | undefined,
  turns: Turn[],
): AsyncGenerator<string, AnswerMeta> {
  const messages = buildMessages(selection, source, turns);
  return prefs.provider === "ollama"
    ? streamOllama(prefs, messages)
    : streamAnthropic(prefs, messages);
}

/** Fire-and-forget: loads the local model while the user is still reading. */
export function warmOllama(prefs: ProviderPrefs): void {
  if (prefs.provider !== "ollama") return;
  const base = prefs.ollamaUrl.replace(/\/+$/, "");
  fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: prefs.ollamaModel, messages: [], keep_alive: KEEP_ALIVE }),
  }).catch(() => {});
}
