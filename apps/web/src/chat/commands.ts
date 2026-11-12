import {
  providerChatOptions,
  type Project,
  type ProviderInstance,
  type Thread,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import type { ActiveSkillComposer } from './composer-store';
import { canMarkDone } from './model';
import { threadListCommands, type ThreadCommandData } from './thread-commands';
import { providerLabel } from './view-model';

export interface ChatCommandData {
  readonly threads: readonly Thread[];
  readonly instances: readonly ProviderInstance[];
  // The thread open in the chat view, if any, and whether a turn of it is running.
  readonly openThread: Thread | undefined;
  readonly running: boolean;
  // The chat view is open: its contextual commands (switch provider) only exist there.
  readonly inChat?: boolean;
  readonly projects?: readonly Project[];
  // The thread list's project chip and the palette's message-text hits.
  readonly threadList?: Pick<ThreadCommandData, 'projectId' | 'found'>;
  // The open thread's own composer, while it takes text (`threadSkillComposer`).
  readonly openComposer?: ActiveSkillComposer | undefined;
}

// Palette commands for the chat (spec 22): every thread, new thread, switch provider, stop, mark
// done or reopen. The answers to the approval on screen are the approval card's (approval-card.tsx).
export function chatCommands({
  threads,
  instances,
  openThread,
  running,
  inChat = openThread !== undefined,
  projects = [],
  threadList,
  openComposer,
}: ChatCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'chat.newThread',
      title: 'New thread',
      group: 'Chat',
      keywords: ['chat', 'agent', 'start'],
      keybinding: 'keybindings.newThread',
      run: ({ navigate, draft }) => {
        // A new thread from an open one keeps its provider, project and folder.
        if (openThread) {
          draft.setState({
            providerInstanceId: openThread.providerInstanceId,
            projectId: openThread.projectId ?? undefined,
            cwd: openThread.projectId === null ? openThread.cwd : undefined,
          });
        }
        draft.setState({ settings: undefined });
        void navigate({ to: '/chat/new' });
      },
    },
  ];

  // A thread stays on its provider, so switching starts a new thread on the other instance in
  // the same project and folder.
  if (inChat) {
    for (const instance of instances) {
      if (openThread?.providerInstanceId === instance.id) continue;
      const label = providerLabel(instance, instances);
      commands.push({
        id: `chat.switchProvider.${instance.id}`,
        title: `Switch provider to ${label}`,
        value: `Switch provider to ${label} ${instance.kind}`,
        group: 'Chat',
        keywords: ['provider', 'claude', 'codex', instance.kind],
        run: ({ navigate, draft }) => {
          draft.setState({
            providerInstanceId: instance.id,
            settings: undefined,
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
  }

  if (openThread) {
    const thread = openThread;
    const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);
    // `/clear` (agent workbench spec 59): a new thread as this one is, the old one stays.
    commands.push({
      id: 'chat.clear',
      title: 'Clear: new thread with the same settings',
      group: 'Chat',
      keywords: ['clear', 'new', 'fresh', 'reset', 'thread'],
      run: ({ navigate, draft }) => {
        draft.setState({
          providerInstanceId: thread.providerInstanceId,
          projectId: thread.projectId ?? undefined,
          cwd: thread.cwd,
          settings: {
            providerInstanceId: thread.providerInstanceId,
            model: thread.model,
            effort: thread.effort,
            permissionMode: thread.permissionMode,
          },
        });
        void navigate({ to: '/chat/new' });
      },
    });
    const compactPrompt = instance ? providerChatOptions[instance.kind].compactPrompt : null;
    if (compactPrompt !== null && !running) {
      commands.push({
        id: 'chat.compact',
        title: 'Compact the conversation',
        group: 'Chat',
        keywords: ['compact', 'context', 'summary', 'summarize'],
        run: ({ connection }) => {
          if (connection) {
            void dispatch(connection, {
              type: 'thread.sendMessage',
              threadId: thread.id,
              text: compactPrompt,
            }).catch(() => undefined);
          }
        },
      });
    }
    const queued = thread.queued;
    if (queued) {
      // Only with a box to put the text in: taking it off the queue without one would lose it.
      if (openComposer) {
        commands.push({
          id: 'chat.editQueued',
          title: 'Edit queued message',
          group: 'Chat',
          keywords: ['queue', 'queued', 'edit', 'message'],
          run: ({ connection }) => {
            if (!connection) return;
            dispatch(connection, { type: 'thread.cancelQueued', threadId: thread.id }).then(
              () =>
                openComposer.putBack(
                  queued.text,
                  queued.skills ?? [],
                  queued.images ?? [],
                  queued.files ?? [],
                ),
              () => undefined,
            );
          },
        });
      }
      commands.push({
        id: 'chat.cancelQueued',
        title: 'Cancel queued message',
        group: 'Chat',
        keywords: ['queue', 'queued', 'cancel', 'remove', 'message'],
        run: ({ connection }) => {
          if (connection) {
            void dispatch(connection, {
              type: 'thread.cancelQueued',
              threadId: thread.id,
            }).catch(() => undefined);
          }
        },
      });
    }
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

  if (openThread && openThread.state === 'done') {
    const threadId = openThread.id;
    commands.push({
      id: 'chat.reopen',
      title: 'Reopen thread',
      group: 'Chat',
      keywords: ['done', 'undo', 'idle'],
      run: ({ connection }) => {
        if (connection)
          void dispatch(connection, { type: 'thread.setDone', threadId, done: false });
      },
    });
  } else if (openThread && canMarkDone(openThread)) {
    const threadId = openThread.id;
    commands.push({
      id: 'chat.markDone',
      title: 'Mark thread done',
      group: 'Chat',
      keywords: ['done', 'finish', 'complete'],
      run: ({ connection }) => {
        if (connection) void dispatch(connection, { type: 'thread.setDone', threadId, done: true });
      },
    });
  }

  commands.push(
    ...threadListCommands({
      threads,
      projects,
      openThread,
      inChat: inChat || openThread !== undefined,
      projectId: threadList?.projectId,
      found: threadList?.found,
    }),
  );
  return commands;
}
