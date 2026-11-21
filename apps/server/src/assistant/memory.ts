import {
  AssistantNote,
  assistantForgetTool,
  assistantRememberTool,
  notesForInstructions,
  localDate,
  isoDate,
} from '@wow/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calendarPrefs } from './outputs.js';
import { built, type BuiltTool } from './built.js';
import type { Reader } from './readers.js';

// The assistant's notes (chief of staff spec 29, 30). A note is a line in the `assistant.notes`
// setting, so writing one is an ordinary `setting.set` with its change row and Undo, and the
// person edits the list like any setting. The tool only builds the command.

const notesOf = (value: unknown): AssistantNote[] => {
  const parsed = AssistantNote.array().safeParse(value);
  return parsed.success ? parsed.data : [];
};

export const memoryTools: Readonly<Record<string, BuiltTool>> = {
  [assistantRememberTool]: built({
    description:
      'Keeps a note about how the person works, which you read at the start of every answer: text is one sentence in their words, until (YYYY-MM-DD) the last day it applies when they gave one. Only what the person said or confirmed. The conversation shows it with Undo, and Settings → Assistant → Memory lists it.',
    input: z
      .object({
        text: AssistantNote.shape.text,
        until: z.iso.date().optional(),
      })
      .strict(),
    build: ({ text, until }, deps) => {
      const notes = notesOf(deps.settings.get('assistant.notes'));
      if (notes.some((note) => note.text === text && note.until === until)) return null;
      const note: AssistantNote = {
        id: randomUUID(),
        text,
        addedAt: deps.clock().toISOString(),
        by: 'assistant',
        ...(until === undefined ? {} : { until }),
      };
      return {
        type: 'setting.set',
        key: 'assistant.notes',
        scope: 'global',
        value: [...notes, note],
      };
    },
  }),
  [assistantForgetTool]: built({
    description:
      'Removes one of your notes by its id, when the person takes it back. The notes and their ids are in read_notes.',
    input: z.object({ noteId: z.string().min(1) }).strict(),
    build: ({ noteId }, deps) => {
      const notes = notesOf(deps.settings.get('assistant.notes'));
      if (!notes.some((note) => note.id === noteId)) {
        return { refused: `There is no note ${noteId}; read_notes lists them.` };
      }
      return {
        type: 'setting.set',
        key: 'assistant.notes',
        scope: 'global',
        value: notes.filter((note) => note.id !== noteId),
      };
    },
  }),
};

export const memoryReaders = {
  read_notes: {
    description:
      'The notes you keep about how the person works, with their ids, who wrote them and the last day each applies. The ones that still apply are also at the end of your instructions.',
    input: z.object({}).strict(),
    read: (_args, deps) => ({
      today: calendarToday(deps),
      notes: notesOf(deps.settings.get('assistant.notes')),
    }),
  } satisfies Reader<z.ZodObject<Record<string, never>>>,
};

// Today in the calendar's zone, for a note's end date.
export const calendarToday = (
  deps: Parameters<typeof calendarPrefs>[0] & { readonly clock: () => Date },
): string => isoDate(localDate(deps.clock(), calendarPrefs(deps).zone));

// The instruction text with the notes that still apply today appended.
export const instructionsWithNotes = (
  deps: Parameters<typeof calendarToday>[0],
  instructions: string,
): string =>
  instructions +
  notesForInstructions(notesOf(deps.settings.get('assistant.notes')), calendarToday(deps));
