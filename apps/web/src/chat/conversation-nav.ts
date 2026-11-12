import { createStore } from 'zustand';
import type { AppCommand } from '@/app/commands';

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
}

export const conversationStore = createStore<ConversationState>(() => ({
  threadId: undefined,
  handle: undefined,
  scrolledUp: false,
  focusedMessage: undefined,
  reasoning: {},
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
  state: Pick<ConversationState, 'threadId' | 'handle' | 'scrolledUp' | 'focusedMessage'> & {
    readonly reasoningOpen: boolean;
  },
  openByDefault: boolean,
): AppCommand[] {
  const { handle, threadId } = state;
  if (!handle || threadId === undefined) return [];
  return [
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
