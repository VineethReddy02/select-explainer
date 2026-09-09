import { Action, ActionPanel, Form, LocalStorage, showToast, Toast, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ProviderPrefs, warmOllama } from "./provider";

/**
 * Settings live in LocalStorage instead of manifest preferences, because the
 * native preferences pane can do neither of the things that matter here: fields
 * can't show or hide based on the chosen provider, and values read with
 * getPreferenceValues() at mount go stale when Raycast resumes a preserved
 * view — the source of "I changed it and nothing happened". Commands re-read
 * these settings on every question, so a save applies immediately.
 */
export const DEFAULTS: ProviderPrefs = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2:latest",
  anthropicApiKey: undefined,
  anthropicModel: "claude-opus-5",
  effort: "low",
};

const STORE_KEY = "settings.v1";

export async function loadSettings(): Promise<ProviderPrefs> {
  const raw = await LocalStorage.getItem<string>(STORE_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveSettings(next: ProviderPrefs): Promise<void> {
  await LocalStorage.setItem(STORE_KEY, JSON.stringify(next));
}

const CLAUDE_MODELS = [
  { title: "Claude Opus 5 — best answers", value: "claude-opus-5" },
  { title: "Claude Sonnet 5 — balanced", value: "claude-sonnet-5" },
  { title: "Claude Haiku 4.5 — fastest", value: "claude-haiku-4-5" },
];

export default function Settings() {
  const { pop } = useNavigation();
  const [loaded, setLoaded] = useState<ProviderPrefs | null>(null);
  const [provider, setProvider] = useState<ProviderPrefs["provider"]>("ollama");
  const [ollamaUrl, setOllamaUrl] = useState(DEFAULTS.ollamaUrl);
  // Installed models fetched from the Ollama server; null = unreachable, so a
  // plain text field is shown instead of an empty dropdown.
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);
  const fetchSeq = useRef(0);

  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setLoaded(s);
      setProvider(s.provider);
      setOllamaUrl(s.ollamaUrl);
    })();
  }, []);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const base = ollamaUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
        const data = (await res.json()) as { models?: { name: string }[] };
        const names = (data.models ?? []).map((m) => m.name);
        if (seq === fetchSeq.current) setOllamaModels(names.length ? names : null);
      } catch {
        if (seq === fetchSeq.current) setOllamaModels(null);
      }
    }, 400); // debounce while the URL is being typed
    return () => clearTimeout(timer);
  }, [ollamaUrl]);

  if (!loaded) return <Form isLoading />;

  async function handleSubmit(values: {
    ollamaUrl?: string;
    ollamaModel?: string;
    anthropicApiKey?: string;
    anthropicModel?: string;
    effort?: string;
  }) {
    const next = { ...loaded, ...values, provider } as ProviderPrefs;
    if (next.provider === "anthropic" && !next.anthropicApiKey?.trim()) {
      await showToast({ style: Toast.Style.Failure, title: "Claude API needs an API key" });
      return;
    }
    await saveSettings(next);
    warmOllama(next); // start loading the local model now, not at question time
    await showToast({ style: Toast.Style.Success, title: "Settings saved", message: "Applies to your next question" });
    pop();
  }

  // The saved model may no longer be installed on the server — keep it pickable
  // rather than silently snapping the dropdown to something else.
  const modelChoices =
    ollamaModels && !ollamaModels.includes(loaded.ollamaModel)
      ? [loaded.ollamaModel, ...ollamaModels]
      : ollamaModels;

  return (
    <Form
      navigationTitle="Select Explainer Settings"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Settings" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="provider"
        title="Provider"
        value={provider}
        onChange={(v) => setProvider(v as ProviderPrefs["provider"])}
        info="Where answers come from. Changes apply from your next question."
      >
        <Form.Dropdown.Item title="Ollama — free, private, local" value="ollama" />
        <Form.Dropdown.Item title="Claude API — best answers, needs a key" value="anthropic" />
      </Form.Dropdown>

      {provider === "ollama" && (
        <>
          <Form.TextField
            id="ollamaUrl"
            title="Ollama Server"
            value={ollamaUrl}
            onChange={setOllamaUrl}
            placeholder={DEFAULTS.ollamaUrl}
          />
          {modelChoices ? (
            <Form.Dropdown
              id="ollamaModel"
              title="Model"
              defaultValue={loaded.ollamaModel}
              info="Models installed on the Ollama server above."
            >
              {modelChoices.map((name) => (
                <Form.Dropdown.Item key={name} title={name} value={name} />
              ))}
            </Form.Dropdown>
          ) : (
            <Form.TextField
              id="ollamaModel"
              title="Model"
              defaultValue={loaded.ollamaModel}
              placeholder={DEFAULTS.ollamaModel}
              info="Couldn't reach the server to list installed models — start Ollama, or type a model name."
            />
          )}
        </>
      )}

      {provider === "anthropic" && (
        <>
          <Form.PasswordField
            id="anthropicApiKey"
            title="API Key"
            defaultValue={loaded.anthropicApiKey}
            placeholder="sk-ant-…"
            info="From console.anthropic.com. Stored only on this Mac."
          />
          <Form.Dropdown id="anthropicModel" title="Model" defaultValue={loaded.anthropicModel}>
            {CLAUDE_MODELS.map((m) => (
              <Form.Dropdown.Item key={m.value} title={m.title} value={m.value} />
            ))}
          </Form.Dropdown>
          <Form.Dropdown
            id="effort"
            title="Effort"
            defaultValue={loaded.effort}
            info="Low is snappiest and right for quick lookups. Haiku ignores this."
          >
            <Form.Dropdown.Item title="Low" value="low" />
            <Form.Dropdown.Item title="Medium" value="medium" />
            <Form.Dropdown.Item title="High" value="high" />
          </Form.Dropdown>
        </>
      )}
    </Form>
  );
}
