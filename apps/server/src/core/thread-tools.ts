import {
  sameSessionTools,
  type DomainEvent,
  type InternalCommand,
  type ThreadTools,
} from '@wow/contracts';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

type ToolsReported = Extract<InternalCommand, { type: 'thread.toolsReported' }>;

// What a thread's session can use (thread work spec 38, 39): stored only when the list or its
// liveness differs from the stored row, so a report at every turn's start writes nothing while
// nothing changed. The time stored is the server's. The assistant has no Tools tab (spec 43) and
// its session is never described.
export function decideThreadTools(
  command: ToolsReported,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const thread = read.thread(command.threadId);
  if (!thread) throw new CommandRejected('not_found', `No thread ${command.threadId}`);
  if (thread.kind === 'assistant') {
    throw new CommandRejected('rejected', 'The assistant has no Tools tab');
  }
  const stored = read.threadTools(thread.id);
  let next: ThreadTools;
  if (command.tools === null) {
    // The session is gone; the list it gave stays, without Refresh.
    if (!stored?.live) return [];
    next = { threadId: thread.id, tools: stored.tools, source: stored.source, live: false };
  } else {
    if (stored?.live && sameSessionTools(stored.tools, command.tools)) return [];
    next = {
      threadId: thread.id,
      tools: { ...command.tools, reportedAt: context.now },
      source: command.source,
      live: true,
    };
  }
  return [{ kind: 'thread.toolsReported', aggregate: thread.id, payload: { tools: next } }];
}
