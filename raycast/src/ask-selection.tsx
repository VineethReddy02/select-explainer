import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  getFrontmostApplication,
  getSelectedText,
  Icon,
  List,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { warmOllama } from "./provider";
import Answer, { QUICK_ACTIONS } from "./answer";
import { loadNotes, matchNote, Note } from "./notes";
import Settings, { loadSettings } from "./settings";

const exec = promisify(execFile);

/**
 * Electron apps like Slack hide their selection from the Accessibility API, so
 * getSelectedText() throws even with text visibly highlighted. Plan B: copy it.
 *
 * The catch: by the time this code runs, Raycast is the frontmost app, so a bare
 * simulated ⌘C would go to Raycast's own window and copy nothing. The keystroke
 * only means something with the source app focused — so focus flips back to it
 * for a beat, ⌘C fires there, and Raycast is reactivated (the open view survives
 * being hidden; Raycast keeps navigation state).
 *
 * A random sentinel goes on the clipboard first, and only a change *away from
 * the sentinel* counts as the selection — stale clipboard content can never be
 * mistaken for it. The previous clipboard text is restored afterwards.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CopyResult = { text: string | null; error?: string };

async function copySelectionViaKeystroke(sourceApp: string | undefined): Promise<CopyResult> {
  if (!sourceApp) return { text: null, error: "The source app is unknown." };
  const previous = await Clipboard.readText().catch(() => undefined);
  const sentinel = `__select_explainer_${Math.random().toString(36).slice(2)}__`;
  await Clipboard.copy(sentinel);
  try {
    // `open -a` goes through LaunchServices — no Automation permission needed for
    // either focus change. Only the keystroke itself touches System Events.
    await exec("open", ["-a", sourceApp]);
    await sleep(400);
    await exec("osascript", ["-e", 'tell application "System Events" to keystroke "c" using command down']);
    await sleep(120);
    await exec("open", ["-a", "Raycast"]);
    for (let i = 0; i < 15; i++) {
      await sleep(70);
      const now = await Clipboard.readText().catch(() => undefined);
      if (now && now !== sentinel) return { text: now };
    }
    return { text: null }; // clipboard never changed: nothing is selected
  } catch (error) {
    // Surface the real failure — a swallowed permission error looks identical to
    // an empty selection and is undebuggable from a screenshot.
    const raw = error instanceof Error ? error.message : String(error);
    let friendly = raw.split("\n").at(-1) || raw;
    if (/1002|not allowed to send keystrokes|assistive/i.test(raw)) {
      // Error 1002 is the Accessibility permission (not Automation): the
      // responsible process needs to be in the Accessibility list.
      friendly =
        "macOS blocked the copy keystroke (error 1002 — Accessibility).\n\n" +
        "Open **System Settings → Privacy & Security → Accessibility** and switch **Raycast** on (add it with + if it isn't listed). " +
        "If it still fails after that, also add **/usr/bin/osascript** (press ⌘⇧G in the file picker to type the path).\n\n" +
        "This is one-time; it's also what lets the fast, flicker-free selection reading work in other apps.";
    } else if (/1743|not authori[sz]ed/i.test(raw)) {
      friendly =
        "macOS blocked the script (Automation): allow Raycast under System Settings → Privacy & Security → Automation → Raycast → System Events.";
    }
    return { text: null, error: friendly };
  } finally {
    if (previous !== undefined) await Clipboard.copy(previous).catch(() => {});
  }
}

/**
 * The command opens as a question picker: the search bar is the question input,
 * quick actions filter as you type, and typed free text becomes the first item.
 * Nothing is asked until the user chooses — the answer view is pushed on top.
 */
export default function AskSelection() {
  const [selection, setSelection] = useState<string | null>(null);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState<Note | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const started = useRef(false);
  const selectionRef = useRef<string | null>(null);
  selectionRef.current = selection;
  // Raycast dismisses an open Actions panel when the view under it re-renders,
  // so the refresh poll must stay silent while the user is mid-interaction:
  // typing a question, or already off in the answer view.
  const askedRef = useRef(false);
  const queryRef = useRef("");
  const { push } = useNavigation();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      loadSettings().then(warmOllama);
      const app = await getFrontmostApplication().catch(() => undefined);
      setSource(app?.name);

      let text = "";
      let copyError: string | undefined;
      try {
        text = (await getSelectedText()).trim();
      } catch {
        // Thrown or empty both mean the same thing here — fall through.
      }
      if (!text) {
        // Apps hide their selection from the Accessibility API two ways: Slack
        // throws, terminals often "succeed" with an empty string. Either way,
        // capture the real selection with a simulated ⌘C in the source app.
        const result = await copySelectionViaKeystroke(app?.name);
        text = (result.text ?? "").trim();
        copyError = result.error;
      }

      if (!text) {
        // The refresh poll below may have picked up a selection while the copy
        // fallback was still in flight — don't clobber it with an error.
        if (!selectionRef.current) {
          setFatal(
            copyError
              ? `Couldn't read the selection from ${app?.name ?? "the app"}:\n\n**${copyError}**`
              : "Nothing is selected. Highlight some text in any app, then run this command.",
          );
        }
        return;
      }
      setSelection(text.slice(0, 4000));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-invoking the hotkey while this view is preserved resumes it as-is —
  // Raycast keeps navigation state when its window closes, so the capture
  // effect above never re-runs and a newly highlighted text wouldn't show up
  // (the old workaround was escaping to force a fresh mount). Poll the live
  // selection instead: getSelectedText() is cheap and reads from the app
  // behind the Raycast window, so a changed highlight replaces the stale one
  // (and clears a stale "nothing selected" screen) within a beat of reopening.
  useEffect(() => {
    const id = setInterval(async () => {
      if (askedRef.current || queryRef.current.trim()) return;
      let text = "";
      try {
        text = (await getSelectedText()).trim();
      } catch {
        return; // app hides its selection from the Accessibility API — keep what we have
      }
      if (!text) return;
      const next = text.slice(0, 4000);
      if (next === selectionRef.current) return;
      const app = await getFrontmostApplication().catch(() => undefined);
      setSource(app?.name);
      setFatal(null);
      setSelection(next);
    }, 750);
    return () => clearInterval(id);
  }, []);

  // The re-selection payoff of persistence: whenever the captured text changes,
  // check whether it was asked about before, and offer that thread first.
  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    loadNotes().then((notes) => {
      if (!cancelled) setSaved(matchNote(notes, selection) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [selection]);

  if (fatal) {
    return <Detail markdown={`## Select Explainer\n\n${fatal}`} />;
  }

  const q = query.trim();
  const matching = QUICK_ACTIONS.filter(
    (a) => !q || a.title.toLowerCase().includes(q.toLowerCase()) || a.question.toLowerCase().includes(q.toLowerCase()),
  );
  const quoteTitle = selection
    ? `“${selection.slice(0, 80).replace(/\s+/g, " ")}${selection.length > 80 ? "…" : ""}”`
    : "";

  const settingsAction = (
    <Action.Push
      title="Open Settings"
      icon={Icon.Gear}
      target={<Settings />}
      shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
    />
  );

  const askAction = (question: string) => (
    <ActionPanel>
      <Action
        title="Ask"
        onAction={() => {
          if (!selection) return;
          askedRef.current = true;
          push(<Answer selection={selection} source={source} initialQuestion={question} />);
        }}
      />
      {settingsAction}
    </ActionPanel>
  );

  const savedAnswers = saved?.turns.filter((t) => t.role === "assistant").length ?? 0;

  return (
    <List
      isLoading={!selection}
      filtering={false}
      onSearchTextChange={(text) => {
        queryRef.current = text;
        setQuery(text);
      }}
      searchBarPlaceholder="Ask anything about the highlighted text…"
    >
      {selection && q.length > 0 && (
        <List.Item icon={Icon.QuestionMarkCircle} title={`Ask: “${q}”`} actions={askAction(q)} />
      )}
      {selection && saved && (
        <List.Item
          icon={Icon.Bookmark}
          title="Continue saved thread"
          subtitle={`${savedAnswers} ${savedAnswers === 1 ? "answer" : "answers"} · ${new Date(saved.updatedAt).toLocaleDateString()}`}
          accessories={[{ text: saved.source }]}
          actions={
            <ActionPanel>
              <Action
                title="Open Thread"
                onAction={() => {
                  askedRef.current = true;
                  push(<Answer selection={saved.selection} source={saved.source ?? source} note={saved} />);
                }}
              />
              {settingsAction}
            </ActionPanel>
          }
        />
      )}
      {selection && (
        <List.Section title={quoteTitle}>
          {matching.map((a) => (
            <List.Item
              key={a.title}
              icon={Icon.LightBulb}
              title={a.title}
              subtitle={a.question}
              actions={askAction(a.question)}
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
