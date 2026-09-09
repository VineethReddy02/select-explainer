import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatThread, streamAnswer, Turn } from "./provider";
import { Note, newNoteId, upsertNote } from "./notes";
import Settings, { loadSettings } from "./settings";

export const QUICK_ACTIONS: { title: string; question: string }[] = [
  { title: "Explain This", question: "Explain this." },
  { title: "Explain Simpler", question: "Explain this in the simplest terms you can, as if to someone new to the topic." },
  { title: "Give an Example", question: "Give a concrete example of this." },
  { title: "Why?", question: "Why is this the case?" },
];

/** Quote-plus-turns markdown, shared with the Saved Notes preview. */
export function threadMarkdown(selection: string, turns: Turn[]): string {
  const quote = `> ${selection.slice(0, 400).replace(/\n+/g, " ")}${selection.length > 400 ? "…" : ""}`;
  const body = turns.map((t) => (t.role === "user" ? `**› ${t.text}**` : t.text)).join("\n\n");
  return `${quote}\n\n${body}`;
}

/**
 * The streamed answer view. Opened two ways: with `initialQuestion` for a fresh
 * ask, or with a saved `note` to continue its thread (no request until the user
 * asks something). Every completed answer is persisted — a fresh ask becomes a
 * new note, a continued one updates in place.
 */
export default function Answer(props: {
  selection: string;
  source: string | undefined;
  initialQuestion?: string;
  note?: Note;
  onSaved?: () => void;
}) {
  const { selection, source } = props;
  const { push } = useNavigation();
  const [turns, setTurns] = useState<Turn[]>(props.note?.turns ?? []);
  const [partial, setPartial] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [meta, setMeta] = useState<{ model: string; local: boolean; outputTokens: number } | null>(null);
  const started = useRef(false);
  const noteRef = useRef<Note | undefined>(props.note);

  async function persistThread(finalTurns: Turn[]) {
    const now = Date.now();
    const existing = noteRef.current;
    noteRef.current = existing
      ? { ...existing, turns: finalTurns, updatedAt: now }
      : { id: newNoteId(), selection, source, turns: finalTurns, createdAt: now, updatedAt: now };
    try {
      await upsertNote(noteRef.current);
      props.onSaved?.();
    } catch {
      // Storage failing must never take the visible answer down with it.
    }
  }

  async function ask(question: string, prior: Turn[]) {
    const nextTurns = [...prior, { role: "user" as const, text: question }];
    setTurns(nextTurns);
    setPartial("");
    setStreaming(true);
    try {
      // Settings are read per question, never captured at mount — a provider
      // change in Settings applies to the very next ask, even mid-thread and
      // even when Raycast resumed this view from preserved state.
      const prefs = await loadSettings();
      const it = streamAnswer(prefs, selection, source, nextTurns);
      let answer = "";
      while (true) {
        const r = await it.next();
        if (r.done) {
          setMeta({ model: r.value.model, local: r.value.local, outputTokens: r.value.outputTokens });
          break;
        }
        answer += r.value;
        setPartial(answer);
      }
      const finalTurns: Turn[] = [...nextTurns, { role: "assistant", text: answer }];
      setTurns(finalTurns);
      setPartial("");
      await persistThread(finalTurns);
    } catch (error) {
      setTurns(prior); // drop the unanswered question so a retry starts clean
      const message = error instanceof Error ? error.message : String(error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Couldn't answer",
        message,
        // A missing key is fixed in Settings — put the door right on the error.
        ...(/api key/i.test(message)
          ? { primaryAction: { title: "Open Settings", onAction: () => push(<Settings />) } }
          : {}),
      });
    } finally {
      setStreaming(false);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (props.initialQuestion) ask(props.initialQuestion, props.note?.turns ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tail = streaming ? `\n\n${partial}${partial ? " ▌" : "\n\n*Thinking…*"}` : "";

  const answered = turns.some((t) => t.role === "assistant");
  const questions = turns.filter((t) => t.role === "user").length;
  const hint = !streaming && answered ? "\n\n---\n\n*↵ ask a follow-up — it continues this thread*" : "";
  const markdown = `${threadMarkdown(selection, turns)}${tail}${hint}`;

  // Streaming re-renders this view on every token, and Raycast closes an open
  // Actions panel whenever it's handed a new actions element — so the panel is
  // rebuilt only when its contents actually change (streaming toggles or the
  // thread grows), never per token.
  const actions = useMemo(
    () => (
      <ActionPanel>
        {!streaming && (
          <Action.Push
            title="Ask Follow-Up"
            target={<FollowUp turns={turns} onSubmit={(question) => ask(question, turns)} />}
          />
        )}
        {answered && (
          <>
            <Action
              title="Paste Thread into Frontmost App"
              onAction={() => Clipboard.paste(formatThread(selection, turns))}
            />
            <Action.CopyToClipboard
              title="Copy Last Answer"
              content={turns.filter((t) => t.role === "assistant").at(-1)?.text ?? ""}
            />
          </>
        )}
        {!streaming &&
          QUICK_ACTIONS.map((qa) => (
            <Action key={qa.title} title={qa.title} onAction={() => ask(qa.question, turns)} />
          ))}
        <Action.Push
          title="Open Settings"
          icon={Icon.Gear}
          target={<Settings />}
          shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
        />
      </ActionPanel>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streaming, turns],
  );

  return (
    <Detail
      isLoading={streaming}
      navigationTitle={questions > 1 ? `Thread · ${questions} questions` : undefined}
      markdown={markdown}
      metadata={
        meta ? (
          <Detail.Metadata>
            <Detail.Metadata.Label title="App" text={source ?? "Unknown"} />
            <Detail.Metadata.Label title="Model" text={`${meta.model}${meta.local ? " (local)" : ""}`} />
            <Detail.Metadata.Label
              title="Thread"
              text={`${questions} ${questions === 1 ? "question" : "questions"} · context kept`}
            />
            <Detail.Metadata.Label title="Tokens" text={String(meta.outputTokens)} />
            <Detail.Metadata.Label title="Saved" text="On this Mac · see Saved Notes" />
            <Detail.Metadata.Label title="Privacy" text="Not added to any conversation" />
          </Detail.Metadata>
        ) : undefined
      }
      actions={actions}
    />
  );
}

/**
 * The form used to be a bare text field on a blank page, which read as a brand
 * new question rather than a continuation — so it now carries the thread: the
 * question count, the tail of the answer being followed up on, and says
 * outright that the whole thread is sent along.
 */
function FollowUp(props: { turns: Turn[]; onSubmit: (question: string) => void }) {
  const { pop } = useNavigation();
  const lastAnswer = props.turns.filter((t) => t.role === "assistant").at(-1)?.text ?? "";
  const excerpt = lastAnswer.replace(/\s+/g, " ").trim();
  const questions = props.turns.filter((t) => t.role === "user").length;
  return (
    <Form
      navigationTitle="Ask Follow-Up"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Ask in This Thread"
            onSubmit={(values: { question: string }) => {
              const q = values.question.trim();
              if (!q) return;
              pop();
              props.onSubmit(q);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="Continuing" text={`…${excerpt.slice(-280)}`} />
      <Form.TextArea id="question" title="Follow-Up" placeholder="What about this…?" autoFocus />
      <Form.Description
        text={`Sent with the highlight and all ${questions} previous ${questions === 1 ? "exchange" : "exchanges"} — the model sees the whole thread.`}
      />
    </Form>
  );
}
