import type { HelperStartedItemPayload } from '@wow/contracts';
import { useRouter } from '@tanstack/react-router';
import { ExternalLinkIcon, PanelRightOpenIcon, SquareIcon, UsersIcon } from 'lucide-react';
import { useRuntime } from '@/app/runtime';
import { Button } from '@/components/ui/button';
import { routerPanelRoute } from '@/panel/model';
import { openThreadTab } from '@/panel/viewer';
import { useDateFormat } from '@/lib/format';
import { useDispatch, useTopic } from '../data';
import { helperRowText } from '../helpers';
import { WorkingIndicator } from '../items';
import { runningToolLabel } from '../view-model';

// A helper the agent started (agent orchestration spec 10), where it started it: "Helper · Codex
// · Review the timer change", then what the helper does now, waits for, or last said, read live
// from the server's topics. Its title opens it in the side panel; Open thread goes to it; Stop
// stops its running turn.
export function HelperRow({ payload }: { readonly payload: HelperStartedItemPayload }) {
  const { settings, layout } = useRuntime();
  // A conversation drawn with no router (a test, a preview) still shows the row.
  const router: ReturnType<typeof useRouter> | undefined = useRouter({ warn: false });
  const threadPath = `/chat/${encodeURIComponent(payload.helperThreadId)}`;
  const send = useDispatch();
  const { relative } = useDateFormat();
  const helper = useTopic('threads')?.find((thread) => thread.id === payload.helperThreadId);
  const activity = useTopic('threadActivity')?.find(
    (row) => row.threadId === payload.helperThreadId,
  );
  const working = helper?.state === 'working';
  const openInPanel = () =>
    openThreadTab(
      { settings, layout },
      {
        threadId: payload.helperThreadId,
        title: helper?.title ?? payload.title,
        from: routerPanelRoute(router),
      },
    );
  return (
    <div
      data-testid="helper-row"
      className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={openInPanel}
        >
          {helperRowText(payload)}
        </button>
        <Button size="icon-xs" variant="ghost" aria-label="Open in panel" onClick={openInPanel}>
          <PanelRightOpenIcon />
        </Button>
        <Button asChild size="icon-xs" variant="ghost" aria-label="Open thread">
          <a
            href={threadPath}
            onClick={(event) => {
              if (!router) return;
              event.preventDefault();
              void router.navigate({
                to: '/chat/$threadId',
                params: { threadId: payload.helperThreadId },
              });
            }}
          >
            <ExternalLinkIcon />
          </a>
        </Button>
        {working && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void send({ type: 'thread.interrupt', threadId: payload.helperThreadId })
            }
          >
            <SquareIcon />
            Stop
          </Button>
        )}
      </div>
      <div data-testid="helper-row-line" className="min-w-0 pl-5.5">
        {!helper ? (
          <span className="text-muted-foreground">The helper is gone.</span>
        ) : working && activity ? (
          <WorkingIndicator
            startedAt={activity.startedAt ?? undefined}
            facts={{
              tool:
                activity.runningTool === null
                  ? undefined
                  : runningToolLabel(activity.runningTool, helper.cwd),
              toolCalls: activity.toolCalls,
              tokens: undefined,
            }}
          />
        ) : helper.state === 'needs_you' ? (
          <span className="text-state-needs-you-text">Waits for you</span>
        ) : helper.state === 'failed' ? (
          <span className="text-state-failed">Failed</span>
        ) : (
          <span className="truncate text-muted-foreground">
            {activity?.lastText ?? 'Done'}
            {activity?.endedAt ? ` · ${relative(activity.endedAt)}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}
