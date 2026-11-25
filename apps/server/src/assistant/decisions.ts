import {
  ApprovalItemPayload,
  QuestionItemPayload,
  type Decision,
  type DecisionKind,
} from '@wow/contracts';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';

// The decision queue (chief of staff spec 16 to 19): everything that waits for the user, built
// on the server from the stored rows and sent in its order, so every view, the tray and the
// next-that-needs-you key agree. A row's id stays the same while it waits; its brief is kept by
// that id.

type Row = Omit<Decision, 'brief' | 'briefPending'>;

const base = {
  threadId: null,
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
  limit: 1,
  proposal: 2,
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

function missedCardRows(db: Db, dismissed: ReadonlySet<string>): Row[] {
  const projects = new Map(
    db
      .select()
      .from(t.projects)
      .all()
      .map((row) => [row.id, row.name]),
  );
  return db
    .select()
    .from(t.calendarItems)
    .where(and(eq(t.calendarItems.source, 'local'), eq(t.calendarItems.state, 'missed')))
    .all()
    .filter((card) => !dismissed.has(`missedCard:${card.id}`))
    .map((card) => ({
      ...base,
      id: `missedCard:${card.id}`,
      kind: 'missedCard' as const,
      at: card.start,
      title: `${card.title} did not start`,
      where: card.projectId ? (projects.get(card.projectId) ?? null) : null,
      path: `/calendar?item=${encodeURIComponent(card.id)}`,
      cardId: card.id,
      fixed: ['wow was not running at its time; Run now starts it.'],
    }));
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
      path: '/chat/assistant',
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
  return [...threadRows(db), ...missedCardRows(db, dismissed), ...proposalRows(db)].toSorted(
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
  'assistantProposals',
  'calendarItems',
  'decisions',
] as const);
