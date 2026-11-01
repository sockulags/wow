import type { ProviderInstance, Thread } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { threadTitle } from './model';

export interface ChatCommandData {
  readonly threads: readonly Thread[];
  readonly instances: readonly ProviderInstance[];
  // The thread open in the chat view, if any, and whether a turn of it is running.
  readonly openThread: Thread | undefined;
  readonly running: boolean;
}

// Palette commands for the chat (spec 22): every thread, new thread, switch provider and stop.
export function chatCommands({
  threads,
  instances,
  openThread,
  running,
}: ChatCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'chat.newThread',
      title: 'New thread',
      group: 'Chat',
      keywords: ['chat', 'agent', 'start'],
      keybinding: 'keybindings.newThread',
      run: ({ navigate, draft }) => {
        // A new thread from an open one keeps its project and folder.
        if (openThread) {
          draft.setState({
            providerInstanceId: openThread.providerInstanceId,
            projectId: openThread.projectId ?? undefined,
            cwd: openThread.projectId === null ? openThread.cwd : undefined,
          });
        }
        void navigate({ to: '/chat/new' });
      },
    },
  ];

  // A thread stays on its provider, so switching starts a new thread on the other instance in
  // the same project and folder.
  for (const instance of instances) {
    if (openThread?.providerInstanceId === instance.id) continue;
    commands.push({
      id: `chat.switchProvider.${instance.id}`,
      title: `Switch provider to ${instance.name} (${instance.kind})`,
      value: `Switch provider to ${instance.name} ${instance.kind} ${instance.id}`,
      group: 'Chat',
      keywords: ['provider', 'claude', 'codex', instance.kind],
      run: ({ navigate, draft }) => {
        draft.setState({
          providerInstanceId: instance.id,
          ...(openThread
            ? {
                projectId: openThread.projectId ?? undefined,
                cwd: openThread.projectId === null ? openThread.cwd : undefined,
              }
            : {}),
        });
        void navigate({ to: '/chat/new' });
      },
    });
  }

  if (openThread && running) {
    const threadId = openThread.id;
    commands.push({
      id: 'chat.stop',
      title: 'Stop turn',
      group: 'Chat',
      keywords: ['interrupt', 'cancel', 'abort'],
      keybinding: 'keybindings.stopTurn',
      run: ({ connection }) => {
        if (connection) void dispatch(connection, { type: 'thread.interrupt', threadId });
      },
    });
  }

  for (const thread of threads) {
    commands.push({
      id: `thread.${thread.id}`,
      title: threadTitle(thread),
      value: `${threadTitle(thread)} ${thread.id}`,
      group: 'Threads',
      keywords: ['thread', thread.state.replace('_', ' '), thread.model],
      run: ({ navigate }) =>
        void navigate({ to: '/chat/$threadId', params: { threadId: thread.id } }),
    });
  }
  return commands;
}
