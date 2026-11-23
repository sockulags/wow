import { GateCardItemPayload, HelperStartedItemPayload, type Thread } from '@wow/contracts';

// Helper threads in lists (agent orchestration spec 11, 12): a helper sits right after its main
// thread, one step in, when both are in the same list; otherwise it stays where it was and says
// whose helper it is.

export interface Nested<T> {
  readonly entry: T;
  // 1 for a helper shown under its main thread.
  readonly depth: 0 | 1;
  // The main thread's title, for a helper shown on its own.
  readonly helperOf: string | undefined;
}

export function nestHelpers<T>(
  entries: readonly T[],
  threadOf: (entry: T) => Thread,
  allThreads: readonly Thread[],
): Nested<T>[] {
  const listed = new Set(entries.map((entry) => threadOf(entry).id));
  const titles = new Map(allThreads.map((thread) => [thread.id, thread.title]));
  const under = new Map<string, T[]>();
  for (const entry of entries) {
    const parent = threadOf(entry).parentThreadId;
    if (parent && listed.has(parent)) under.set(parent, [...(under.get(parent) ?? []), entry]);
  }
  const out: Nested<T>[] = [];
  for (const entry of entries) {
    const thread = threadOf(entry);
    if (thread.parentThreadId && listed.has(thread.parentThreadId)) continue;
    out.push({
      entry,
      depth: 0,
      helperOf: thread.parentThreadId ? titles.get(thread.parentThreadId) : undefined,
    });
    for (const helper of under.get(thread.id) ?? []) {
      out.push({ entry: helper, depth: 1, helperOf: undefined });
    }
  }
  return out;
}

// "Helper · Codex · Review the timer change": the row's words, for the row, Ctrl+F and export.
export const helperRowText = (payload: HelperStartedItemPayload): string =>
  `Helper · ${payload.instanceName} · ${payload.title}${payload.isolation === 'copy' ? ' · own working copy' : ''}`;

export const helperPayload = (payload: unknown): HelperStartedItemPayload | undefined =>
  HelperStartedItemPayload.safeParse(payload).data;

const providerName = { claude: 'Claude Code', codex: 'Codex' } as const;

// "Review the timer · Codex · Helper of Plan the change": who asks in a gate card (orchestrator
// threads spec 14), for the card, its line, Ctrl+F and export.
export const gateCardWho = (payload: GateCardItemPayload): string =>
  [
    payload.title || 'A helper',
    providerName[payload.providerKind],
    ...(payload.parentTitle === undefined ? [] : [`Helper of ${payload.parentTitle}`]),
  ].join(' · ');

export const gateRowText = (payload: GateCardItemPayload): string =>
  `${gateCardWho(payload)} asks you ${payload.kind === 'approval' ? 'for an approval' : 'a question'}`;

export const gatePayload = (payload: unknown): GateCardItemPayload | undefined =>
  GateCardItemPayload.safeParse(payload).data;
