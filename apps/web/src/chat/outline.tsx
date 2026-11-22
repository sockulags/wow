import { TextItemPayload, type ThreadItem, type Turn } from '@wow/contracts';
import { ArrowLeftIcon, BookmarkIcon, ListTreeIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';
import type { AppCommand } from '@/app/commands';
import { useRuntime, type LayoutStore, type ViewerOutline } from '@/app/runtime';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDateFormat } from '@/lib/format';
import { closeTab, closeViewer, openOutline, outlineTabId, panelTabsOf } from '@/panel/viewer';
import { conversationStore } from './conversation-nav';
import { useTopic } from './data';
import { summaryText, turnSummaries } from './turn-summary';

// A chat thread's outline (chat overview spec 21, 22): one row per message of the user with what
// its turn did under it, and the answers the user marked, in order. A row goes to its message in
// the conversation and gives it the keyboard. Read from the thread's items; nothing is kept here.

export interface OutlineRow {
  readonly itemId: string;
  readonly kind: 'message' | 'mark';
  readonly text: string;
  readonly at: string | undefined;
  readonly marked: boolean;
  // What the message's turn did (spec 1).
  readonly summary: string | undefined;
}

const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';

export function outlineRows(items: readonly ThreadItem[], turns: readonly Turn[]): OutlineRow[] {
  const replaced = new Set(
    turns.filter((turn) => (turn.replacedBy ?? null) !== null).map((turn) => turn.id),
  );
  const started = new Map(turns.map((turn) => [turn.id, turn.startedAt]));
  const summaries = turnSummaries(items);
  const usage = new Map(
    items.filter((item) => item.kind === 'usage').map((item) => [item.turnId, item.id]),
  );
  return items.flatMap((item): OutlineRow[] => {
    if (replaced.has(item.turnId)) return [];
    if (item.kind !== 'user' && item.kind !== 'assistant_text') return [];
    const parsed = TextItemPayload.safeParse(item.payload);
    if (!parsed.success) return [];
    const marked = parsed.data.marked === true;
    if (item.kind === 'assistant_text' && !marked) return [];
    const summary = summaries.get(usage.get(item.turnId) ?? '');
    return [
      {
        itemId: item.id,
        kind: item.kind === 'user' ? 'message' : 'mark',
        text: firstLine(parsed.data.text) || (item.kind === 'user' ? '(no text)' : '(empty)'),
        at: started.get(item.turnId),
        marked,
        summary: item.kind === 'user' && summary ? summaryText(summary) : undefined,
      },
    ];
  });
}

export function ThreadOutline({ outline }: { readonly outline: ViewerOutline }) {
  const { threadId, from } = outline;
  const { layout } = useRuntime();
  const { when } = useDateFormat();
  const items = useTopic('threadItems', threadId);
  const turns = useTopic('turns', threadId) ?? [];
  const [filter, setFilter] = useState('');
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = outlineRows(items ?? [], turns).filter((row) =>
    words.every((word) => `${row.text} ${row.summary ?? ''}`.toLowerCase().includes(word)),
  );
  const go = (itemId: string) => {
    const shown = conversationStore.getState();
    if (shown.threadId === threadId) shown.handle?.focusItem?.(itemId);
  };
  return (
    <section
      aria-label="Outline"
      data-testid="thread-outline"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button size="xs" variant="ghost" onClick={() => closeViewer(layout, from)}>
          <ArrowLeftIcon aria-hidden />
          Back to details
        </Button>
      </div>
      <div className="relative shrink-0 px-3 py-2">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Filter the outline"
          placeholder="Filter the outline"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-7 pl-7 text-xs"
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon={ListTreeIcon}
          title={filter === '' ? 'Nothing to list yet' : 'Nothing matches'}
          description={
            filter === ''
              ? 'Your messages and the answers you mark (B) are listed here.'
              : 'The filter looks at your messages, what each turn did and the marked answers.'
          }
        />
      ) : (
        <ol aria-label="Outline rows" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {rows.map((row) => (
            <li key={row.itemId}>
              <button
                type="button"
                data-testid="outline-row"
                data-kind={row.kind}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => go(row.itemId)}
              >
                <span className="flex items-center gap-1.5">
                  {row.marked && (
                    <BookmarkIcon
                      role="img"
                      aria-label="Marked"
                      className="size-3 shrink-0 fill-current text-primary"
                    />
                  )}
                  <span
                    className={
                      row.kind === 'mark'
                        ? 'min-w-0 flex-1 truncate pl-3 text-muted-foreground'
                        : 'min-w-0 flex-1 truncate font-medium'
                    }
                  >
                    {row.text}
                  </span>
                  {row.at && row.kind === 'message' && (
                    <time
                      dateTime={row.at}
                      className="shrink-0 text-2xs text-muted-foreground tabular-nums"
                    >
                      {when(row.at)}
                    </time>
                  )}
                </span>
                {row.summary && (
                  <span className="truncate text-2xs text-muted-foreground">{row.summary}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export const outlineShown = (
  state: Parameters<typeof panelTabsOf>[0],
  from: string,
  threadId: string | undefined,
): boolean =>
  threadId !== undefined && panelTabsOf(state, from).selected === outlineTabId(threadId);

const closeOutline = (layout: LayoutStore, from: string, threadId: string): void =>
  closeTab(layout, from, outlineTabId(threadId));

// "Show outline" and "Hide outline" for the chat thread on screen (spec 21).
export function outlineCommands(
  threadId: string | undefined,
  route: string,
  open: boolean,
): AppCommand[] {
  if (threadId === undefined) return [];
  return [
    {
      id: 'chat.outline',
      title: open ? 'Hide outline' : 'Show outline',
      group: 'Chat',
      keywords: ['outline', 'map', 'messages', 'marks', 'bookmarks', 'table of contents'],
      keybinding: 'keybindings.threadOutline',
      run: (context) => {
        if (open) closeOutline(context.layout, route, threadId);
        else openOutline(context, { threadId, from: route });
      },
    },
  ];
}
