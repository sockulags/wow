import { UsageItemPayload, type ChangeCount, type ThreadItem } from '@wow/contracts';
import { groupSummary, payloadOf, type ToolPayload } from './tools/facts';

// What a turn did, at the start of its usage row (chat overview spec 1 to 3): what it changed in
// the folder, as the server measured it from the turn's snapshots, and what it ran and how much
// of that failed, from the turn's own tool rows. A subagent's own calls count as its one call.

export interface TurnSummary {
  // "Changed 3 files +40 −2", or absent when there is nothing to say.
  readonly changes: string | undefined;
  // The turn changed files that can be listed, so the part opens its Changes.
  readonly opensChanges: boolean;
  // "Read 2 files, ran 1 command · 1 failed".
  readonly ran: string | undefined;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// A turn that could not be measured (no two snapshots) says nothing about its changes.
export function changesText(changes: ChangeCount | null | undefined): string | undefined {
  if (changes === undefined || changes === null || changes.files === 0) return undefined;
  return `Changed ${plural(changes.files, 'file', 'files')} +${changes.added} −${changes.removed}`;
}

function ranText(calls: readonly ToolPayload[]): string | undefined {
  if (calls.length === 0) return undefined;
  const failed = calls.filter((call) => call.status === 'error').length;
  return [groupSummary(calls), ...(failed === 0 ? [] : [`${failed} failed`])].join(' · ');
}

// Each usage row's summary, by the row's id; a turn with nothing to say has none.
export function turnSummaries(items: readonly ThreadItem[]): Map<string, TurnSummary> {
  const calls = new Map<string, ToolPayload[]>();
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const payload = payloadOf(item);
    if (!payload || payload.parentItemId !== undefined) continue;
    const list = calls.get(item.turnId) ?? [];
    list.push(payload);
    calls.set(item.turnId, list);
  }
  const summaries = new Map<string, TurnSummary>();
  for (const item of items) {
    if (item.kind !== 'usage') continue;
    const parsed = UsageItemPayload.safeParse(item.payload);
    if (!parsed.success) continue;
    const changes = changesText(parsed.data.changes);
    const ran = ranText(calls.get(item.turnId) ?? []);
    if (changes === undefined && ran === undefined) continue;
    summaries.set(item.id, {
      changes,
      opensChanges: (parsed.data.changes?.files ?? 0) > 0,
      ran,
    });
  }
  return summaries;
}

export const summaryText = (summary: TurnSummary): string =>
  [summary.changes, summary.ran].filter((part) => part !== undefined).join(' · ');
