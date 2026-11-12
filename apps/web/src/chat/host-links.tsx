import {
  HostLookupResult,
  bareHostRefs,
  hostItemKey,
  hostItemReadId,
  noHostLinkRules,
  recogniseHostLink,
  recogniseHostRef,
  type HostItemData,
  type HostItemRead,
  type HostItemRef,
  type HostLinkRules,
} from '@wow/contracts';
import {
  BookOpenIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  TicketIcon,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useContext, useEffect, type KeyboardEvent, type MouseEvent } from 'react';
import { createStore, useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { safeHref } from '@/components/markdown';
import { cn } from '@/lib/utils';
import { changeRequestStateLabel } from '@/plans/model';
import { useTopic } from './data';

// Links and references to the user's own hosts in a chat (agent workbench spec 20 to 26). What
// is a chip is decided against the thread's rules, which the server answers (`hosts.lookup`
// without a ref): only sites wow has settings and a token for, and the project's repository and
// Jira key. A chip shows what the server last read and stored for the thread; reading happens
// only when its tab opens or on Refresh now (panel/host-tab.tsx), never here.

export interface HostLinks {
  readonly threadId: string;
  readonly rules: HostLinkRules;
  readonly reads: readonly HostItemRead[];
  open(item: HostItemRef): void;
}

export const HostLinkContext = createContext<HostLinks | undefined>(undefined);
export const useHostLinks = (): HostLinks | undefined => useContext(HostLinkContext);

export { bareHostRefs, hostItemKey as hostItemKeyOf, recogniseHostLink, recogniseHostRef };

// The rules of each thread as the server last answered them; asked again when the settings or
// the projects change (a token stored, a repository set).
const rulesStore = createStore<{ readonly byThread: Readonly<Record<string, HostLinkRules>> }>(
  () => ({ byThread: {} }),
);

export function useHostLinkRules(threadId: string | undefined): HostLinkRules {
  const { connection } = useRuntime();
  const settings = useTopic('settings');
  const projects = useTopic('projects');
  const rules = useStore(rulesStore, (state) =>
    threadId === undefined ? undefined : state.byThread[threadId],
  );
  useEffect(() => {
    if (!connection || threadId === undefined) return undefined;
    let current = true;
    connection
      .request('hosts.lookup', { threadId })
      .then((answer) => {
        if (!current) return;
        const { rules: answered } = HostLookupResult.parse(answer);
        rulesStore.setState((state) => ({
          byThread: { ...state.byThread, [threadId]: answered },
        }));
      })
      // Without an answer no link is a chip; links stay plain, as without a token.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, threadId, settings, projects]);
  return rules ?? noHostLinkRules;
}

// The read a thread stored for an item, if any.
export const readOf = (
  reads: readonly HostItemRead[],
  threadId: string,
  item: HostItemRef,
): HostItemRead | undefined => {
  const id = hostItemReadId(threadId, item);
  return reads.find((read) => read.id === id);
};

const kindIcons: Readonly<Record<HostItemRef['kind'], LucideIcon>> = {
  changeRequest: GitPullRequestIcon,
  issue: CircleDotIcon,
  ticket: TicketIcon,
  page: BookOpenIcon,
};

export function hostItemIcon(item: HostItemRef, data?: HostItemData | null): LucideIcon {
  const kind = data?.kind ?? item.kind;
  if (kind === 'changeRequest' && item.host === 'gitlab') return GitMergeIcon;
  return kindIcons[kind];
}

// The item's key as the host writes it: "PR #14", "MR !7", "Issue #3", "DEMO-42", or a page's
// title once read. A bare GitHub `#14` stays "#14" until the read says what it is.
export function hostItemLabel(item: HostItemRef, data?: HostItemData | null): string {
  if (data?.kind === 'page') return data.page.title || pageName(item);
  const kind = data?.kind ?? item.kind;
  switch (kind) {
    case 'changeRequest':
      return item.host === 'gitlab' ? `MR !${item.id}` : `PR #${item.id}`;
    case 'issue':
      return item.host === 'github' && !data ? `#${item.id}` : `Issue #${item.id}`;
    case 'ticket':
      return item.id;
    case 'page':
      return pageName(item);
  }
}

const pageName = (item: HostItemRef): string =>
  item.id.startsWith('title:')
    ? item.id.slice(item.id.indexOf('/') + 1)
    : `Page ${item.id.slice(3)}`;

// What the chip adds once the item was read (spec 20): "Draft · 2 checks failed", "To Do",
// "Closed". A page's title is its label.
export function hostItemState(data: HostItemData | null | undefined): string | undefined {
  if (!data) return undefined;
  switch (data.kind) {
    case 'changeRequest': {
      const request = data.changeRequest;
      const failed = request.checks.filter((check) => check.state === 'failure').length;
      const checks =
        request.checkState === 'failure'
          ? `${failed} ${failed === 1 ? 'check' : 'checks'} failed`
          : request.checkState === 'pending'
            ? 'checks running'
            : request.checkState === 'success'
              ? 'checks passed'
              : undefined;
      return [changeRequestStateLabel(request), checks].filter(Boolean).join(' · ');
    }
    case 'issue':
      return data.issue.state === 'open' ? 'Open' : 'Closed';
    case 'ticket':
      return data.ticket.status || undefined;
    case 'page':
      return undefined;
  }
}

export const hostChipText = (item: HostItemRef, read: HostItemRead | undefined): string =>
  [hostItemLabel(item, read?.data), hostItemState(read?.data)].filter(Boolean).join(' · ');

// Shift+click and Shift+Enter open the item in the browser instead (spec 21). The desktop shell
// sends a new window's web address to the system browser.
export function openInBrowser(item: HostItemRef): void {
  const url = safeHref(item.url);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

export function HostChip({
  item,
  links,
  className,
}: {
  readonly item: HostItemRef;
  readonly links: HostLinks;
  readonly className?: string;
}) {
  const read = readOf(links.reads, links.threadId, item);
  const Icon = hostItemIcon(item, read?.data);
  const text = hostChipText(item, read);
  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    if (event.shiftKey) openInBrowser(item);
    else links.open(item);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !event.shiftKey) return;
    event.preventDefault();
    openInBrowser(item);
  };
  return (
    <button
      type="button"
      data-testid="host-chip"
      data-host={item.host}
      title={`${item.url}\nEnter opens it in the side panel, Shift+Enter in the browser`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-px align-baseline font-medium text-[0.9em] leading-snug outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  );
}

// The host items a text names: its web addresses on the thread's sites and, unless only links
// are wanted (the composer's pasted links), its bare references; once each, in order (spec 19,
// 25).
export function hostItemsIn(
  text: string,
  rules: HostLinkRules,
  { linksOnly = false }: { readonly linksOnly?: boolean } = {},
): HostItemRef[] {
  const found = new Map<string, HostItemRef>();
  const add = (item: HostItemRef) => {
    const key = hostItemKey(item);
    if (!found.has(key)) found.set(key, item);
  };
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const item = recogniseHostLink(match[0].replace(/[.,;:!?]+$/, ''), rules);
    if (item) add(item);
  }
  if (!linksOnly) for (const match of bareHostRefs(text, rules)) add(match.item);
  return [...found.values()];
}
