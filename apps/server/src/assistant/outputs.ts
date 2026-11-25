import {
  OutlookProfile,
  TextItemPayload,
  assistantThreadId,
  freeSlots,
  resolveCalendarPrefs,
  type WorkHours,
} from '@wow/contracts';
import { and, asc, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { CommandRejected } from '../core/orchestrator.js';
import { readCalendarRange } from '../core/series.js';
import * as t from '../db/schema.js';
import type { Reader, ReaderDeps } from './readers.js';

// What agents produced (chief of staff spec 1 to 3): a chat thread's latest messages and what
// it waits for. These are the only readers that return what an agent wrote. Each still builds
// its answer field by field, cuts long text at `assistant.readMaxBytes`, and reads no file.
// The tool layer passes every answer through `assistant.secretPatterns`.

const reader = <S extends z.ZodType>(definition: Reader<S>) => definition;

export interface Cut {
  readonly text: string;
  readonly cut: boolean;
}

export const cutText = (text: string, max: number): Cut =>
  text.length <= max ? { text, cut: false } : { text: text.slice(0, max), cut: true };

const excluded = (deps: ReaderDeps, projectId: string | null): boolean =>
  projectId !== null && deps.settings.get('assistant.excludedProjects').includes(projectId);

const excludedReason = (name: string) =>
  `${name} is in a project the assistant may not read (Settings → Assistant, "Projects the assistant does not read").`;

const busyOf = (deps: ReaderDeps, from: Date, to: Date) => {
  const range = { from: from.toISOString(), to: to.toISOString() };
  const meetings = deps.db
    .select()
    .from(t.calendarItems)
    .where(
      and(
        eq(t.calendarItems.source, 'outlook'),
        lt(t.calendarItems.start, range.to),
        gt(t.calendarItems.end, range.from),
        ne(t.calendarItems.state, 'cancelled'),
      ),
    )
    .all()
    .filter((meeting) => !meeting.allDay)
    .map((meeting) => ({
      title: meeting.title || 'Untitled',
      start: Date.parse(meeting.start),
      end: Date.parse(meeting.end),
    }));
  const cards = readCalendarRange(
    deps.db,
    range,
    deps.settings.get('calendar.maxOccurrences'),
  ).occurrences.map((occurrence) => ({
    title: 'card',
    start: Date.parse(occurrence.start),
    end: Date.parse(occurrence.end),
  }));
  return [...meetings, ...cards].toSorted((a, b) => a.start - b.start);
};

// The calendar's zone and work hours with "outlook" resolved, as the calendar view shows them.
export function calendarPrefs(deps: Pick<ReaderDeps, 'db' | 'settings'>): {
  zone: string;
  workHours: WorkHours;
} {
  const profile = OutlookProfile.safeParse(deps.db.select().from(t.outlookStatus).get()?.profile);
  const prefs = resolveCalendarPrefs(
    {
      zone: deps.settings.get('calendar.zone'),
      firstDayOfWeek: deps.settings.get('calendar.firstDayOfWeek'),
      workHours: deps.settings.get('calendar.workHours'),
    },
    profile.success ? profile.data : null,
  );
  return { zone: prefs.zone, workHours: prefs.workHours };
}

export const outputReaders = {
  read_thread: reader({
    description:
      "One chat or step thread: its title, state, provider, model and project, its latest agent messages (newest last), the approval or question it waits for with what was asked, and the tokens and cost of its turns. Not the assistant's own conversation. Threads in a project the person excluded are refused.",
    input: z.object({ threadId: z.string().min(1) }).strict(),
    read: (({ threadId }, deps) => {
      if (threadId === assistantThreadId) {
        throw new CommandRejected('rejected', 'That is this conversation.');
      }
      const thread = deps.db.select().from(t.threads).where(eq(t.threads.id, threadId)).get();
      if (!thread || thread.kind !== 'chat') {
        throw new CommandRejected('not_found', `There is no thread ${threadId}.`);
      }
      if (excluded(deps, thread.projectId)) {
        throw new CommandRejected('rejected', excludedReason('This thread'));
      }
      const max = deps.settings.get('assistant.readMaxBytes');
      const texts = deps.db
        .select()
        .from(t.threadItems)
        .where(and(eq(t.threadItems.threadId, threadId), eq(t.threadItems.kind, 'assistant_text')))
        .orderBy(desc(t.threadItems.index))
        .limit(deps.settings.get('assistant.readMaxMessages'))
        .all()
        .flatMap((item) => {
          const payload = TextItemPayload.safeParse(item.payload);
          if (!payload.success || payload.data.parentItemId !== undefined) return [];
          return [
            { itemId: item.id, streaming: item.streaming, ...cutText(payload.data.text, max) },
          ];
        })
        .toReversed();
      const approval = deps.db
        .select()
        .from(t.approvals)
        .where(and(eq(t.approvals.threadId, threadId), isNull(t.approvals.decision)))
        .get();
      const question = deps.db
        .select()
        .from(t.questions)
        .where(and(eq(t.questions.threadId, threadId), isNull(t.questions.answer)))
        .get();
      const turns = deps.db
        .select()
        .from(t.turns)
        .where(eq(t.turns.threadId, threadId))
        .orderBy(asc(t.turns.index))
        .all();
      const usage = turns.reduce(
        (sum, turn) => ({
          inputTokens: sum.inputTokens + (turn.usage?.inputTokens ?? 0),
          outputTokens: sum.outputTokens + (turn.usage?.outputTokens ?? 0),
          costUsd:
            turn.usage?.costUsd === undefined
              ? sum.costUsd
              : (sum.costUsd ?? 0) + turn.usage.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: null as number | null },
      );
      return {
        id: thread.id,
        title: thread.title,
        state: thread.state,
        projectId: thread.projectId,
        providerInstanceId: thread.providerInstanceId,
        model: thread.model,
        effort: thread.effort,
        permissionMode: thread.permissionMode,
        updatedAt: thread.updatedAt,
        messages: texts,
        waitingApproval: approval
          ? { id: approval.id, kind: approval.kind, request: approval.request }
          : null,
        waitingQuestion: question ? { id: question.id, request: question.request } : null,
        turns: turns.length,
        usage,
      };
    }) satisfies Reader['read'],
  }),
  read_free_slots: reader({
    description:
      "Free time on the calendar: gaps inside the person's work hours that no Outlook meeting or card fills, at least `minutes` long, from `from` (default now) for `days` days (default 7), earliest first. Each gap says where it starts and ends; plan a card inside one.",
    input: z
      .object({
        minutes: z
          .number()
          .int()
          .min(5)
          .max(24 * 60),
        from: z.iso.datetime({ offset: true }).optional(),
        days: z.number().int().min(1).max(31).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    read: ({ minutes, from, days, limit }, deps) => {
      const start = from ? new Date(from) : deps.clock();
      const end = new Date(start.getTime() + (days ?? 7) * 24 * 60 * 60_000);
      const { zone, workHours } = calendarPrefs(deps);
      return {
        zone,
        workHours,
        slots: freeSlots({
          from: start,
          to: end,
          zone,
          workHours,
          busy: busyOf(deps, start, end),
          minutes,
          snapMinutes: deps.settings.get('calendar.snapMinutes'),
          limit: limit ?? 10,
        }),
      };
    },
  }),
};
