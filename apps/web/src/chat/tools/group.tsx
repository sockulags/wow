import type { ThreadItem } from '@wow/contracts';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConversationItem, type ItemContext } from '../items';
import { openKey, useOpenState } from '../open-state';
import { failedToolCalls } from '../view-model';
import { groupSummary, payloadOf } from './facts';
import { toolParts } from './index';

// A run of tool calls as one row (`chat.groupToolCalls`). While it is open to more calls (its
// turn runs and nothing came after it, or a call still runs) it draws its latest call, with that
// call's time; closed, it says what was done: "Read 2 files, ran 1 command · 1 failed" (spec
// 91). Open, it lists every call. The open state is the conversation's, which find sets too.
export function ToolCallGroup({
  items,
  contextOf,
  closed = false,
}: {
  items: readonly ThreadItem[];
  contextOf: (item: ThreadItem) => ItemContext;
  // Something came after the group in the conversation.
  closed?: boolean;
}) {
  const first = items[0];
  const [open, setOpen] = useOpenState(first && openKey('group', first.id));
  const latest = items.at(-1);
  if (first === undefined || latest === undefined) return null;
  const payloads = items.flatMap((item) => payloadOf(item) ?? []);
  const latestPayload = payloadOf(latest);
  const latestContext = contextOf(latest);
  const failed = failedToolCalls(items);
  // A call its turn left unfinished does not keep the group open.
  const running =
    !latestContext.turnEnded && payloads.some((payload) => payload.status === 'running');
  const done = !running && (closed || latestContext.turnEnded);
  const extra = (
    <>
      <span data-testid="tool-group-count" className="text-muted-foreground">
        {items.length} tool calls
      </span>
      {failed > 0 && (
        <span data-testid="tool-group-failed" className="text-state-failed">
          {failed} failed
        </span>
      )}
    </>
  );
  return (
    <li
      data-testid="item-tool_group"
      data-item-id={first.id}
      data-failed={failed > 0 || undefined}
      data-closed={done || undefined}
      className="[contain-intrinsic-size:auto_2.5rem] [content-visibility:auto]"
    >
      <details
        className={cn(
          'group/tools rounded-md border text-xs',
          failed > 0 ? 'border-state-failed/50' : 'border-border',
        )}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/tools:rotate-90" />
          {done ? (
            <span data-testid="tool-group-summary" className="min-w-0 truncate">
              {groupSummary(payloads)}
              {failed > 0 && (
                <>
                  {' · '}
                  <span data-testid="tool-group-failed" className="text-state-failed">
                    {failed} failed
                  </span>
                </>
              )}
            </span>
          ) : latestPayload ? (
            toolParts(latestPayload, latestContext, extra).line
          ) : (
            <span className="ml-auto">{extra}</span>
          )}
        </summary>
        {open && (
          <ol aria-label="Tool calls" className="flex flex-col gap-1 border-t border-border p-2">
            {items.map((item) => (
              <ConversationItem
                key={item.id}
                item={item}
                approvals={[]}
                questions={[]}
                context={contextOf(item)}
              />
            ))}
          </ol>
        )}
      </details>
    </li>
  );
}
