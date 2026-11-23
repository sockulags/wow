import { UsageItemPayload } from '@wow/contracts';
import { and, eq, gte, lt } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { threadItems, threads, turns } from '../db/schema.js';

// The usage view's figures (chat overview spec 39 to 41): every turn that ended in the range,
// summed per day (in the user's zone), project, provider instance and model, from the usage row
// the turn stored. A cost the provider did not report is counted as unknown, never as zero.

export interface UsageSummaryRow {
  readonly day: string;
  readonly projectId: string | null;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly assistant: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  unknownCost: number;
  noUsage: number;
}

const dayIn = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));

export function usageSummary(
  db: Db,
  { from, to, timeZone }: { readonly from: string; readonly to: string; readonly timeZone: string },
): { rows: UsageSummaryRow[] } {
  const ended = db
    .select({
      turnId: turns.id,
      endedAt: turns.endedAt,
      projectId: threads.projectId,
      providerInstanceId: threads.providerInstanceId,
      threadModel: threads.model,
      kind: threads.kind,
    })
    .from(turns)
    .innerJoin(threads, eq(turns.threadId, threads.id))
    .where(and(gte(turns.endedAt, from), lt(turns.endedAt, to)))
    .all();
  const usage = new Map<string, UsageItemPayload>();
  for (const turn of ended) {
    const row = db
      .select({ payload: threadItems.payload })
      .from(threadItems)
      .where(and(eq(threadItems.turnId, turn.turnId), eq(threadItems.kind, 'usage')))
      .get();
    const parsed = UsageItemPayload.safeParse(row?.payload);
    if (parsed.success) usage.set(turn.turnId, parsed.data);
  }
  const rows = new Map<string, UsageSummaryRow>();
  for (const turn of ended) {
    if (turn.endedAt === null) continue;
    const used = usage.get(turn.turnId);
    const hasTokens = used?.inputTokens !== undefined || used?.outputTokens !== undefined;
    const model = used?.model ?? turn.threadModel;
    const day = dayIn(turn.endedAt, timeZone);
    const assistant = turn.kind === 'assistant';
    const key = [day, turn.projectId ?? '', turn.providerInstanceId, model, assistant].join('\n');
    const sum =
      rows.get(key) ??
      ({
        day,
        projectId: turn.projectId,
        providerInstanceId: turn.providerInstanceId,
        model,
        assistant,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
        unknownCost: 0,
        noUsage: 0,
      } satisfies UsageSummaryRow);
    sum.turns += 1;
    if (!hasTokens) {
      sum.noUsage += 1;
    } else {
      sum.inputTokens += used?.inputTokens ?? 0;
      sum.outputTokens += used?.outputTokens ?? 0;
      sum.cachedInputTokens += used?.cachedInputTokens ?? 0;
      if (used?.costUsd === undefined) sum.unknownCost += 1;
      else sum.costUsd += used.costUsd;
    }
    rows.set(key, sum);
  }
  return {
    rows: [...rows.values()].toSorted(
      (a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model),
    ),
  };
}
