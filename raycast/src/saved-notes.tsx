import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  confirmAlert,
  Icon,
  List,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { formatThread } from "./provider";
import Answer, { threadMarkdown } from "./answer";
import { collapse, deleteNote, loadNotes, Note } from "./notes";

/**
 * The archive of every answered side-thread — the stand-in for the browser
 * extension's painted highlights, which no app outside the browser allows.
 * Search by the highlighted text or anything asked or answered; continuing a
 * thread picks it up with full context.
 */
export default function SavedNotes() {
  const [notes, setNotes] = useState<Note[] | null>(null);

  async function refresh() {
    setNotes((await loadNotes()).sort((a, b) => b.updatedAt - a.updatedAt));
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <List
      isLoading={notes === null}
      isShowingDetail={Boolean(notes?.length)}
      searchBarPlaceholder="Search highlights, questions, and answers…"
    >
      <List.EmptyView
        icon={Icon.Bookmark}
        title="No saved notes yet"
        description="Every thread you ask through Ask About Selection is saved here automatically."
      />
      {(notes ?? []).map((note) => {
        const title = collapse(note.selection).slice(0, 80);
        const answers = note.turns.filter((t) => t.role === "assistant").length;
        // Raycast's search filters on these; include the thread so a remembered
        // question or answer finds the note even when the highlight is forgotten.
        const keywords = note.turns.map((t) => t.text).concat(note.source ?? "");
        return (
          <List.Item
            key={note.id}
            icon={Icon.Bookmark}
            title={title}
            keywords={keywords}
            accessories={[{ date: new Date(note.updatedAt), tooltip: "Last activity" }]}
            detail={
              <List.Item.Detail
                markdown={threadMarkdown(note.selection, note.turns)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="App" text={note.source ?? "Unknown"} />
                    <List.Item.Detail.Metadata.Label
                      title="Thread"
                      text={`${answers} ${answers === 1 ? "answer" : "answers"}`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="Created"
                      text={new Date(note.createdAt).toLocaleString()}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="Updated"
                      text={new Date(note.updatedAt).toLocaleString()}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.Push
                  title="Continue Thread"
                  icon={Icon.Bubble}
                  target={
                    <Answer selection={note.selection} source={note.source} note={note} onSaved={refresh} />
                  }
                />
                <Action
                  title="Paste Thread into Frontmost App"
                  icon={Icon.Document}
                  onAction={() => Clipboard.paste(formatThread(note.selection, note.turns))}
                />
                <Action.CopyToClipboard
                  title="Copy Last Answer"
                  content={note.turns.filter((t) => t.role === "assistant").at(-1)?.text ?? ""}
                />
                <Action
                  title="Delete Note"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={async () => {
                    const confirmed = await confirmAlert({
                      title: "Delete this note?",
                      message: "The thread is removed for good — asking about this text again starts fresh.",
                      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
                    });
                    if (confirmed) {
                      await deleteNote(note.id);
                      await refresh();
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
