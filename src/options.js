const DEFAULTS = {
  provider: "ollama",
  apiKey: "",
  model: "claude-opus-5",
  effort: "low",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.2:latest",
};

const el = (id) => document.getElementById(id);
const fields = {
  apiKey: el("apiKey"),
  model: el("model"),
  effort: el("effort"),
  ollamaUrl: el("ollamaUrl"),
  ollamaModel: el("ollamaModel"),
};

const providerInputs = [...document.querySelectorAll('input[name="provider"]')];
const currentProvider = () => providerInputs.find((i) => i.checked)?.value ?? "ollama";

function applyProvider() {
  const ollama = currentProvider() === "ollama";
  el("anthropic-card").hidden = ollama;
  el("ollama-card").hidden = !ollama;
  if (ollama && !el("ollamaModel").options.length) testOllama();
}

providerInputs.forEach((input) => input.addEventListener("change", applyProvider));

function setStatus(text, kind) {
  const status = el("ollamaStatus");
  status.textContent = text;
  status.className = `status ${kind || ""}`;
}

/** Fills the model dropdown, preserving the saved choice even if it isn't installed. */
function fillModels(models, selected) {
  const select = fields.ollamaModel;
  select.innerHTML = "";
  const options = models.length ? models : selected ? [selected] : [];
  for (const name of options) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  }
  if (selected && !options.includes(selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = `${selected} (not installed)`;
    select.append(option);
  }
  if (selected) select.value = selected;
}

async function testOllama() {
  const url = fields.ollamaUrl.value.trim() || DEFAULTS.ollamaUrl;
  const wanted = fields.ollamaModel.value || DEFAULTS.ollamaModel;
  setStatus("Checking…");
  el("originHelp").hidden = true;

  const result = await chrome.runtime.sendMessage({ type: "probe-ollama", url });

  if (result?.ok) {
    fillModels(result.models, wanted);
    setStatus(
      result.models.length
        ? `Connected. ${result.models.length} model${result.models.length === 1 ? "" : "s"} available.`
        : "Connected, but no chat models are installed. Try: ollama pull llama3.2",
      result.models.length ? "ok" : "bad",
    );
    return;
  }

  fillModels([], wanted);
  setStatus(result?.message || "Couldn't reach Ollama.", "bad");
  if (result?.reason === "origin") el("originHelp").hidden = false;
}

el("test").addEventListener("click", testOllama);

chrome.storage.local.get(Object.keys(DEFAULTS)).then((stored) => {
  const settings = { ...DEFAULTS, ...stored };
  fields.apiKey.value = settings.apiKey;
  fields.model.value = settings.model;
  fields.effort.value = settings.effort;
  fields.ollamaUrl.value = settings.ollamaUrl;
  fillModels([], settings.ollamaModel);
  providerInputs.forEach((input) => (input.checked = input.value === settings.provider));
  applyProvider();
});

el("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    provider: currentProvider(),
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value,
    effort: fields.effort.value,
    ollamaUrl: fields.ollamaUrl.value.trim() || DEFAULTS.ollamaUrl,
    ollamaModel: fields.ollamaModel.value || DEFAULTS.ollamaModel,
  });
  const saved = el("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 1600);
});
