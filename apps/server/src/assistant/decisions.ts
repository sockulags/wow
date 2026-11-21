import {
  ApprovalItemPayload,
  QuestionItemPayload,
  type Decision,
  type DecisionKind,
} from '@wow/contracts';
import { eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';

// The decision queue (chief of staff spec 16 to 19): everything that waits for the user, built
// on the server from the stored rows and sent in its order, so every view, the tray and the
// next-that-needs-you key agree. A row's id stays the same while it waits; its brief is kept by
// that id.

type Row = Omit<Decision, 'brief' | 'briefPending'>;

const base = {
  threadId: null,
  runId: null,
  proposalId: null,
  approvalId: null,
  questionId: null,
  cardId: null,
  holdsTurn: false,
  cardStart: null,
} as const;

// What comes first: what holds a running turn, then gates and limits, then proposals, then
// failures (spec 17).
const tier: Readonly<Record<DecisionKind, number>> = {
  approval: 0,
  question: 0,
  gate: 1,
  limit: 1,
  proposal: 2,
  failedRun: 3,
  missedCard: 3,
};

export function decisionOrder(a: Row, b: Row): number {
  const holds = Number(b.holdsTurn) - Number(a.holdsTurn);
  if (holds !== 0) return holds;
  if (tier[a.kind] !== tier[b.kind]) return tier[a.kind] - tier[b.kind];
  const soon = (row: Row) => (row.cardStart === null ? Infinity : Date.parse(row.cardStart));
  if (soon(a) !== soon(b)) return soon(a) - soon(b);
  return Date.parse(a.at) - Date.parse(b.at);
}

function threadRows(db: Db): Row[] {
  const threads = new Map(
    db
      .select()
      .from(t.threads)
      .where(ne(t.threads.kind, 'assistant'))
      .all()
      .map((thread) => [thread.id, thread]),
  );
  const projects = new Map(
    db
      .select()
      .from(t.projects)
      .all()
      .map((row) => [row.id, row.name]),
  );
  const running = new Map(
    db
      .select()
      .from(t.turns)
      .where(eq(t.turns.state, 'running'))
      .all()
      .map((turn) => [turn.threadId, turn.id]),
  );
  const itemOf = (id: string) =>
    db.select().from(t.threadItems).where(eq(t.threadItems.id, id)).get();
  const where = (threadId: string) => {
    const thread = threads.get(threadId);
    if (!thread) return null;
    const project = thread.projectId ? projects.get(thread.projectId) : undefined;
    return project ? `${thread.title} · ${project}` : thread.title;
  };
  const rows: Row[] = [];
  for (const approval of db.select().from(t.approvals).where(isNull(t.approvals.decision)).all()) {
    const thread = threads.get(approval.threadId);
    const item = itemOf(approval.itemId);
    const turnId = running.get(approval.threadId);
    if (!thread || !item || item.turnId !== turnId) continue;
    // A step's approval belongs to its run; the run is not waiting at a gate for it.
    const payload = ApprovalItemPayload.safeParse(item.payload);
    rows.push({
      ...base,
      id: `approval:${approval.id}`,
      kind: 'approval',
      at: thread.stateSince ?? thread.updatedAt,
      title: payload.success ? payload.data.summary : `Approval in ${thread.title}`,
      where: where(thread.id),
      path: `/chat/${thread.id}`,
      threadId: thread.id,
      runId: thread.runId,
      approvalId: approval.id,
      holdsTurn: true,
      fixed: [
        `The agent asks to ${approval.kind === 'command' ? 'run a command' : approval.kind === 'fileChange' ? 'change files' : approval.kind === 'plan' ? 'start on its plan' : 'use a tool'}.`,
      ],
    });
  }
  for (const question of db.select().from(t.questions).where(isNull(t.questions.answer)).all()) {
    const thread = threads.get(question.threadId);
    const item = itemOf(question.itemId);
    const turnId = running.get(question.threadId);
    if (!thread || !item || item.turnId !== turnId) continue;
    const payload = QuestionItemPayload.safeParse(item.payload);
    rows.push({
      ...base,
      id: `question:${question.id}`,
      kind: 'question',
      at: thread.stateSince ?? thread.updatedAt,
      title: payload.success ? payload.data.question : `Question in ${thread.title}`,
      where: where(thread.id),
      path: `/chat/${thread.id}`,
      threadId: thread.id,
      runId: thread.runId,
      questionId: question.id,
      holdsTurn: true,
      fixed:
        payload.success && payload.data.options.length > 0
          ? [`Choices: ${payload.data.options.map((option) => option.label).join(', ')}`]
          : [],
    });
  }
  return rows;
}

function runRows(db: Db, dismissed: ReadonlySet<string>): Row[] {
  const workflows = new Map(
    db
      .select()
      .from(t.workflows)
      .all()
      .map((row) => [row.id, row]),
  );
  const projects = new Map(
    db
      .select()
      .from(t.projects)
      .all()
      .map((row) => [row.id, row.name]),
  );
  const cards = new Map(
    db
      .select()
      .from(t.calendarItems)
      .where(eq(t.calendarItems.source, 'local'))
      .all()
      .map((card) => [card.id, card]),
  );
  const rows: Row[] = [];
  for (const run of db
    .select()
    .from(t.workflowRuns)
    .where(inArray(t.workflowRuns.state, ['waiting', 'failed']))
    .all()) {
    const workflow = workflows.get(run.workflowId);
    const project = projects.get(run.projectId);
    const where = [workflow?.name, project].filter(Boolean).join(' · ') || null;
    const card = run.calendarItemId ? cards.get(run.calendarItemId) : undefined;
    const step = run.steps[run.currentStep] ?? run.steps.at(-1);
    const skill = workflow?.steps.find((candidate) => candidate.id === step?.stepId)?.skillName;
    if (run.state === 'failed') {
      const id = `failedRun:${run.id}`;
      if (dismissed.has(id)) continue;
      const failed = run.steps.find((entry) => entry.state === 'failed');
      rows.push({
        ...base,
        id,
        kind: 'failedRun',
        at: run.endedAt ?? run.startedAt,
        title: `${workflow?.name ?? 'A run'} failed${failed ? ` at ${workflow?.steps.find((candidate) => candidate.id === failed.stepId)?.skillName ?? failed.stepId}` : ''}`,
        where,
        path: `/workflows/runs/${run.id}`,
        runId: run.id,
        cardId: run.calendarItemId,
        fixed: failed?.error ? [failed.error] : [],
      });
      continue;
    }
    // A gate that waits for the pull request's checks waits for the host, not for the user.
    if (step?.gate?.state === 'waitingForChecks') continue;
    const atLimit = step?.gate?.state === 'waitingAtLimit';
    rows.push({
      ...base,
      id: `${atLimit ? 'limit' : 'gate'}:${run.id}:${step?.stepId ?? ''}`,
      kind: atLimit ? 'limit' : 'gate',
      at: step?.endedAt ?? run.startedAt,
      title: atLimit
        ? (step?.gate?.detail ?? `${skill ?? 'A step'} reached its limit`)
        : `${skill ?? 'A step'} waits for your review`,
      where,
      path: `/workflows/runs/${run.id}`,
      runId: run.id,
      cardId: run.calendarItemId,
      cardStart: card?.start ?? null,
      fixed: [
        ...(step?.facts?.verdict && step.facts.verdict !== 'none'
          ? [`Verdict: ${step.facts.verdict}`]
          : []),
        ...(step?.facts?.checks ? [`Checks: ${step.facts.checks}`] : []),
        ...(step && step.artifactsFound.length > 0
          ? [`Artifacts: ${step.artifactsFound.join(', ')}`]
          : []),
      ],
    });
  }
  for (const card of cards.values()) {
    if (card.state !== 'missed') continue;
    const id = `missedCard:${card.id}`;
    if (dismissed.has(id)) continue;
    rows.push({
      ...base,
      id,
      kind: 'missedCard',
      at: card.start,
      title: `${card.title} did not start`,
      where: card.projectId ? (projects.get(card.projectId) ?? null) : null,
      path: `/calendar?item=${encodeURIComponent(card.id)}`,
      cardId: card.id,
      fixed: ['wow was not running at its time; Run now starts it.'],
    });
  }
  return rows;
}

function proposalRows(db: Db): Row[] {
  return db
    .select()
    .from(t.assistantProposals)
    .where(eq(t.assistantProposals.state, 'pending'))
    .all()
    .map((proposal) => ({
      ...base,
      id: `proposal:${proposal.id}`,
      kind: 'proposal' as const,
      at: proposal.at,
      title: proposal.title,
      where: 'The assistant',
      path: '/assistant',
      proposalId: proposal.id,
      fixed: proposal.lines.map((line) =>
        [
          line.what,
          line.from === null ? null : `from ${line.from}`,
          line.to === null ? null : `to ${line.to}`,
        ]
          .filter(Boolean)
          .join(' '),
      ),
    }));
}

// Every waiting decision without its brief, in order.
export function decisionRowsWithoutBriefs(db: Db): Row[] {
  const dismissed = new Set(
    db
      .select({ id: t.decisionDismissals.decisionId })
      .from(t.decisionDismissals)
      .all()
      .map((row) => row.id),
  );
  return [...threadRows(db), ...runRows(db, dismissed), ...proposalRows(db)].toSorted(
    decisionOrder,
  );
}

export function decisionRows(db: Db): Decision[] {
  const briefs = new Map(
    db
      .select()
      .from(t.decisionBriefs)
      .all()
      .map((row) => [row.decisionId, row]),
  );
  return decisionRowsWithoutBriefs(db).map((row) => {
    const brief = briefs.get(row.id);
    return {
      ...row,
      brief:
        brief?.text && brief.recommendation && brief.writtenAt
          ? { text: brief.text, recommendation: brief.recommendation, at: brief.writtenAt }
          : null,
      briefPending: brief !== undefined && brief.text === null,
    };
  });
}

// The topics a decision is read from; a change to any of them changes the queue.
export const decisionSources = new Set([
  'threads',
  'turns',
  'approvals',
  'questions',
  'workflowRuns',
  'assistantProposals',
  'calendarItems',
  'decisions',
] as const);
