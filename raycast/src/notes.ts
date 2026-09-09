import { LocalStorage } from "@raycast/api";
import { Turn } from "./provider";

/**
 * Saved side-threads — the Raycast analog of the browser extension's notes.
 * Nothing here can paint a highlight into another app's window, so persistence
 * hangs off the text itself: every answered thread is stored, and re-selecting
 * the same text offers to continue its thread instead of starting cold.
 */
export type Note = {
  id: string;
  selection: string;
  source?: string;
  turns: Turn[];
  createdAt: number;
  updatedAt: number;
};

const STORE_KEY = "notes.v1";

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export async function loadNotes(): Promise<Note[]> {
  const raw = await LocalStorage.getItem<string>(STORE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function upsertNote(note: Note): Promise<void> {
  const notes = await loadNotes();
  const at = notes.findIndex((n) => n.id === note.id);
  if (at === -1) notes.push(note);
  else notes[at] = note;
  await LocalStorage.setItem(STORE_KEY, JSON.stringify(notes));
}

export async function deleteNote(id: string): Promise<void> {
  const notes = (await loadNotes()).filter((n) => n.id !== id);
  await LocalStorage.setItem(STORE_KEY, JSON.stringify(notes));
}

/**
 * Same-text matching mirrors the browser extension's `exact` anchor: collapse
 * whitespace and compare. The most recently touched note wins when the same
 * passage was asked about more than once.
 */
export function matchNote(notes: Note[], selection: string): Note | undefined {
  const target = collapse(selection);
  if (!target) return undefined;
  return notes
    .filter((n) => collapse(n.selection) === target)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function newNoteId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
