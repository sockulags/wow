import { createStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { notify } from '@/lib/feedback';

// The keys of the open thread's conversation (agent workbench spec 73, 74, 88): move between
// messages, copy the one that has the keyboard, go back to the newest output, and open or close
// all reasoning. The conversation on screen registers what it can do; the palette and the keys
// act on it.

export interface ConversationHandle {
  previousMessage(): void;
  nextMessage(): void;
  toEnd(): void;
  copyFocused(): unknown;
}

// Edit and Fork on the conversation on screen (agent workbench spec 62, 71, 74): which messages
// they can act on, or why the provider offers neither.
export interface GoBackActions {
  // Why neither is offered here (Codex); the palette commands say it.
  readonly refusal?: string | undefined;
  // The item id of the last message, when Edit can replace it.
  readonly editable?: string | undefined;
  // The item ids of the messages a fork can start from, oldest first.
  readonly forkable: readonly string[];
  edit(): void;
  fork(itemId: string): void;
  // Offered while a go-back the provider refused keeps the thread going back.
  readonly goOn?: { readonly title: string; readonly detail: string; run(): void } | undefined;
}

interface ConversationState {
  readonly threadId: string | undefined;
  readonly handle: ConversationHandle | undefined;
  // The reader scrolled up while output came: "New output" shows, End returns.
  readonly scrolledUp: boolean;
  // The message that has the keyboard, which C copies.
  readonly focusedMessage: string | undefined;
  // Per thread, whether Ctrl+O opened or closed all reasoning; absent, the setting decides. The
  // count tells every row to take the new state even when it was opened by hand.
  readonly reasoning: Readonly<Record<string, { readonly open: boolean; readonly count: number }>>;
  readonly goBack: GoBackActions | undefined;
}

export const conversationStore = createStore<ConversationState>(() => ({
  threadId: undefined,
  handle: undefined,
  scrolledUp: false,
  focusedMessage: undefined,
  reasoning: {},
  goBack: undefined,
}));

export function showConversation(threadId: string, handle: ConversationHandle): () => void {
  conversationStore.setState({ threadId, handle, scrolledUp: false, focusedMessage: undefined });
  return () =>
    conversationStore.setState((state) =>
      state.handle === handle
        ? { threadId: undefined, handle: undefined, scrolledUp: false, focusedMessage: undefined }
        : state,
    );
}

// The conversation on screen says what Edit and Fork can do; it says again when that changes.
export function showGoBack(threadId: string, actions: GoBackActions): () => void {
  conversationStore.setState((state) =>
    state.threadId === threadId ? { goBack: actions } : state,
  );
  return () =>
    conversationStore.setState((state) =>
      state.goBack === actions ? { goBack: undefined } : state,
    );
}

// The palette's Edit and Fork (spec 62, 63, 71, 74): E and F act on the message that has the
// keyboard, so E on any other message does nothing; where the provider cannot go back, the
// commands are listed and say why.
function goBackCommands(
  actions: GoBackActions | undefined,
  focused: string | undefined,
): AppCommand[] {
  if (!actions) return [];
  const { refusal } = actions;
  if (refusal !== undefined) {
    return [
      {
        id: 'chat.editLast',
        title: 'Edit last message',
        detail: refusal,
        group: 'Chat',
        keywords: ['edit', 'change', 'resend', 'message'],
        run: () => notify.info(refusal),
      },
      {
        id: 'chat.fork',
        title: 'Fork from here',
        detail: refusal,
        group: 'Chat',
        keywords: ['fork', 'branch', 'copy', 'thread'],
        run: () => notify.info(refusal),
      },
    ];
  }
  const commands: AppCommand[] = [];
  if (actions.editable !== undefined) {
    commands.push({
      id: focused === actions.editable ? 'chat.editFocused' : 'chat.editLast',
      title: focused === actions.editable ? 'Edit this message' : 'Edit last message',
      group: 'Chat',
      keywords: ['edit', 'change', 'resend', 'message'],
      ...(focused === actions.editable ? { keybinding: 'keybindings.editMessage' as const } : {}),
      run: () => actions.edit(),
    });
  }
  const from =
    focused !== undefined && actions.forkable.includes(focused) ? focused : actions.forkable.at(-1);
  if (from !== undefined) {
    commands.push({
      id: 'chat.fork',
      title: from === focused ? 'Fork from this message' : 'Fork from the last message',
      group: 'Chat',
      keywords: ['fork', 'branch', 'copy', 'thread', 'here'],
      ...(from === focused ? { keybinding: 'keybindings.forkMessage' as const } : {}),
      run: () => actions.fork(from),
    });
  }
  const { goOn } = actions;
  if (goOn) {
    commands.push({
      id: 'chat.dropGoBack',
      title: goOn.title,
      detail: goOn.detail,
      group: 'Chat',
      keywords: ['go back', 'edit', 'fork', 'failed', 'resume', 'conversation'],
      run: () => goOn.run(),
    });
  }
  return commands;
}

export function toggleReasoning(threadId: string, openByDefault: boolean): void {
  conversationStore.setState((state) => {
    const before = state.reasoning[threadId];
    const open = !(before?.open ?? openByDefault);
    return {
      reasoning: { ...state.reasoning, [threadId]: { open, count: (before?.count ?? 0) + 1 } },
    };
  });
}

export function conversationCommands(
  state: Pick<
    ConversationState,
    'threadId' | 'handle' | 'scrolledUp' | 'focusedMessage' | 'goBack'
  > & {
    readonly reasoningOpen: boolean;
  },
  openByDefault: boolean,
): AppCommand[] {
  const { handle, threadId } = state;
  if (!handle || threadId === undefined) return [];
  return [
    ...goBackCommands(state.goBack, state.focusedMessage),
    {
      id: 'chat.previousMessage',
      title: 'Previous message',
      group: 'Chat',
      keywords: ['move', 'up', 'focus', 'conversation'],
      keybinding: 'keybindings.previousMessage',
      run: () => handle.previousMessage(),
    },
    {
      id: 'chat.nextMessage',
      title: 'Next message',
      group: 'Chat',
      keywords: ['move', 'down', 'focus', 'conversation'],
      keybinding: 'keybindings.nextMessage',
      run: () => handle.nextMessage(),
    },
    {
      id: 'chat.toggleReasoning',
      title: state.reasoningOpen ? 'Close all reasoning' : 'Open all reasoning',
      group: 'Chat',
      keywords: ['thinking', 'reasoning', 'expand', 'collapse'],
      keybinding: 'keybindings.toggleReasoning',
      run: () => toggleReasoning(threadId, openByDefault),
    },
    ...(state.scrolledUp
      ? [
          {
            id: 'chat.toNewest',
            title: 'Go to the newest output',
            group: 'Chat' as const,
            keywords: ['scroll', 'bottom', 'end', 'follow'],
            keybinding: 'keybindings.conversationEnd' as const,
            atTextEnd: true,
            run: () => handle.toEnd(),
          },
        ]
      : []),
    ...(state.focusedMessage !== undefined
      ? [
          {
            id: 'chat.copyFocusedMessage',
            title: 'Copy the focused message',
            group: 'Chat' as const,
            keywords: ['copy', 'clipboard'],
            keybinding: 'keybindings.copyMessage' as const,
            run: () => void handle.copyFocused(),
          },
        ]
      : []),
  ];
}
