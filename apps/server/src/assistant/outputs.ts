import {
  OutlookProfile,
  TextItemPayload,
  assistantThreadId,
  freeSlots,
  resolveCalendarPrefs,
  runFolder,
  type WorkHours,
} from '@wow/contracts';
import { and, asc, desc, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { CommandRejected } from '../core/orchestrator.js';
import { readCalendarRange } from '../core/series.js';
import * as t from '../db/schema.js';
import { readViewerFile } from '../files/read.js';
import { changesOptions, readRunDiff } from '../workflows/changes.js';
import type { Reader, ReaderDeps } from './readers.js';

// What agents produced (chief of staff spec 1 to 3): a run's steps with their final messages,
// artifacts and changes, and a chat thread's latest messages and what it waits for. These are
// the only readers that return what an agent wrote. Each still builds its answer field by
// field, cuts long text at `assistant.readMaxBytes`, and reads no file but a step's artifacts.
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

// The diff of a run, file by file, until the line budget is spent.
async function runChanges(
  deps: ReaderDeps,
  folder: string,
  run: typeof t.workflowRuns.$inferSelect,
) {
  const options = changesOptions(deps.settings);
  const listed = await readRunDiff({ folder, run, options });
  if (listed.status !== 'ok') {
    return { status: listed.status, message: listed.message, files: [], omitted: 0 };
  }
  let budget = deps.settings.get('assistant.readMaxDiffLines');
  const files = [];
  for (const file of listed.files) {
    let patch: Cut | null = null;
    if (budget > 0 && file.content === 'text') {
      const one = await readRunDiff({ folder, run, path: file.path, options });
      if (one.patch !== null) {
        const lines = one.patch.split('\n');
        patch = {
          text: lines.slice(0, budget).join('\n'),
          cut: lines.length > budget,
        };
        budget -= Math.min(budget, lines.length);
      }
    }
    files.push({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      added: file.added,
      removed: file.removed,
      changedBy: file.changedBy,
      patch,
    });
  }
  return { status: listed.status, message: null, files, omitted: listed.omitted };
}

async function artifactText(deps: ReaderDeps, roots: string[], path: string) {
  const max = deps.settings.get('assistant.readMaxBytes');
  const read = await readViewerFile({
    roots,
    path,
    maxBytes: max,
    place: "the run's working folder",
  });
  if (read.kind === 'refused') return { path, read: false, reason: read.message };
  if (read.kind === 'image') return { path, read: false, reason: 'It is a picture.' };
  return { path, read: true, ...cutText(read.text, max) };
}

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
  read_run: reader({
    description:
      "One workflow run in full: each step with its state, its final message (what the agent wrote last), its verdict and checks, the artifacts it found with their text, and the run's changes since its base, file by file with the diff up to a limit. Long text is cut and says so. Runs in a project the person excluded are refused.",
    input: z.object({ runId: z.string().min(1) }).strict(),
    read: async ({ runId }, deps) => {
      const run = deps.db.select().from(t.workflowRuns).where(eq(t.workflowRuns.id, runId)).get();
      if (!run) throw new CommandRejected('not_found', `There is no run ${runId}.`);
      if (excluded(deps, run.projectId)) {
        throw new CommandRejected('rejected', excludedReason('This run'));
      }
      const project = deps.db
        .select()
        .from(t.projects)
        .where(eq(t.projects.id, run.projectId))
        .get();
      const workflow = deps.db
        .select()
        .from(t.workflows)
        .where(eq(t.workflows.id, run.workflowId))
        .get();
      const max = deps.settings.get('assistant.readMaxBytes');
      const folder = project ? runFolder(run, project.cwd) : null;
      const steps = [];
      for (const step of run.steps) {
        const definition = workflow?.steps.find((candidate) => candidate.id === step.stepId);
        steps.push({
          stepId: step.stepId,
          skill: definition?.skillName ?? null,
          state: step.state,
          attempt: step.attempt ?? 1,
          threadId: step.threadId ?? null,
          startedAt: step.startedAt ?? null,
          endedAt: step.endedAt ?? null,
          error: step.error ?? null,
          finalMessage: step.finalMessage === undefined ? null : cutText(step.finalMessage, max),
          verdict: step.facts?.verdict ?? null,
          checks: step.facts?.checks ?? null,
          gate: step.gate ? { state: step.gate.state, detail: step.gate.detail ?? null } : null,
          artifacts: folder
            ? await Promise.all(
                step.artifactsFound.map((path) => artifactText(deps, [folder], path)),
              )
            : step.artifactsFound.map((path) => ({
                path,
                read: false,
                reason: 'The project is gone.',
              })),
        });
      }
      return {
        id: run.id,
        workflow: workflow?.name ?? null,
        projectId: run.projectId,
        project: project?.name ?? null,
        state: run.state,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        steps,
        changes: folder
          ? await runChanges(deps, folder, run)
          : { status: 'folderMissing', message: null, files: [], omitted: 0 },
      };
    },
  }),
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
        runId: thread.runId,
        stepId: thread.stepId,
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
