import { z } from 'zod';
import { providerChatOptions, type ProviderKind } from './provider.js';

// Helper threads (agent orchestration spec 1 to 9): a chat thread's agent starts another thread,
// on any connected Claude Code or Codex instance, through wow's helper tools. A helper is an
// ordinary chat thread with a parent; its approvals stay the user's.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// Where a helper works (spec 5): the main thread's own folder, as Claude Code's subagents share
// theirs, or a working copy of its own.
export const HelperIsolation = z.enum(['folder', 'copy']);
export type HelperIsolation = z.infer<typeof HelperIsolation>;

// The `helper_started` row in the main thread's conversation (spec 10), where the agent started it.
export const HelperStartedItemPayload = z.object({
  helperThreadId: Id,
  title: z.string().min(1),
  instanceName: z.string().min(1),
  providerKind: z.enum(['claude', 'codex']),
  isolation: HelperIsolation,
  at: Timestamp,
});
export type HelperStartedItemPayload = z.infer<typeof HelperStartedItemPayload>;

// The `gate_card` row in a main thread (orchestrator threads spec 14): an approval or a question
// for the user from a helper anywhere in its tree. The request itself stays in the helper's
// thread (`itemId` there); the card draws it and answers it by its id.
export const GateCardItemPayload = z.object({
  fromThreadId: Id,
  kind: z.enum(['approval', 'question']),
  requestId: Id,
  itemId: Id,
  title: z.string(),
  instanceName: z.string().min(1),
  providerKind: z.enum(['claude', 'codex']),
  depth: z.number().int().min(1),
  // The thread that started the helper, when that is not the main thread.
  parentTitle: z.string().optional(),
  at: Timestamp,
});
export type GateCardItemPayload = z.infer<typeof GateCardItemPayload>;

// How much a permission mode lets an agent do without asking, comparable across providers:
// 0 reads only, 1 asks before acting, 2 edits files in its folder, 3 decides for itself, 4 has no
// sandbox and never asks. A mode not listed counts as asking.
const modeReach: Readonly<Record<ProviderKind, Readonly<Record<string, number>>>> = {
  claude: { plan: 0, default: 1, dontAsk: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 },
  codex: { 'read-only': 0, untrusted: 1, auto: 2, 'full-access': 4 },
};

// The helper's mode (spec 6): the main thread's own on the same provider, else the widest mode of
// the helper's provider that reaches no further than the main thread's, first in the provider's
// list on a tie.
export function helperPermissionMode(
  from: { readonly kind: ProviderKind; readonly mode: string },
  to: ProviderKind,
): string {
  if (from.kind === to) return from.mode;
  const reach = modeReach[from.kind][from.mode] ?? 1;
  let best: { id: string; reach: number } | undefined;
  for (const option of providerChatOptions[to].permissionModes) {
    const own = modeReach[to][option.id] ?? 1;
    if (own <= reach && (best === undefined || own > best.reach)) {
      best = { id: option.id, reach: own };
    }
  }
  return best?.id ?? providerChatOptions[to].assistantPermissionMode;
}

// A thread's place in its tree (orchestrator threads spec 4): a main thread is at depth 0 and a
// helper one below the thread that started it. Derived from the parent links, never stored; a
// chain that loops stops where it would repeat.
export function helperDepth(
  threadId: string,
  parentOf: (threadId: string) => string | null | undefined,
): number {
  const seen = new Set([threadId]);
  let depth = 0;
  for (let parent = parentOf(threadId); parent; parent = parentOf(parent)) {
    if (seen.has(parent)) break;
    seen.add(parent);
    depth += 1;
  }
  return depth;
}

// Every helper under a thread at any depth, nearest first, each with its depth below the thread.
export function helperTree<T extends { readonly id: string }>(
  threadId: string,
  childrenOf: (threadId: string) => readonly T[],
): { readonly thread: T; readonly depth: number }[] {
  const found: { thread: T; depth: number }[] = [];
  const seen = new Set([threadId]);
  let level = [threadId];
  for (let depth = 1; level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of level) {
      for (const child of childrenOf(id)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push({ thread: child, depth });
        next.push(child.id);
      }
    }
    level = next;
  }
  return found;
}
