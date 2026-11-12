import {
  BookOpenIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  InfoIcon,
  MessagesSquareIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { DETAILS_TAB, useRuntime, type PanelTab, type PanelTabs } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { cn } from '@/lib/utils';
import { pageTitle, runPageRead } from '@/workflows/pages-tab';
import { closeTab, fileLanguage, selectTab, tabName } from './viewer';

// The panel's tab strip (agent workbench spec 11): the panel's own body first ("Details", or a
// run's "Conversation"), then one tab per open file or page, each with an icon and a short name.
// The keys (close, next, previous, back) are the panel's, see context-panel.tsx.

const pictures = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const prose = new Set(['md', 'markdown', 'txt']);

function tabIcon(tab: PanelTab): LucideIcon {
  if (tab.kind === 'page') return BookOpenIcon;
  const kind = tab.file.read?.kind;
  const extension = fileLanguage(tab.file.path);
  if (kind === 'image' || (extension !== undefined && pictures.has(extension))) return ImageIcon;
  if (kind === 'markdown' || (extension !== undefined && prose.has(extension))) {
    return FileTextIcon;
  }
  return extension === undefined ? FileIcon : FileCodeIcon;
}

export const tabElementId = (route: string, id: string): string =>
  `panel-tab-${encodeURIComponent(`${route}\n${id}`)}`;

function Tab({
  route,
  id,
  name,
  title,
  icon: Icon,
  selected,
  onClose,
}: {
  readonly route: string;
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly selected: boolean;
  readonly onClose?: (() => void) | undefined;
}) {
  const { layout } = useRuntime();
  return (
    <div
      className={cn(
        'group/tab flex h-8 max-w-44 shrink-0 items-center rounded-t-md border-b-2 text-xs',
        selected
          ? 'border-primary bg-accent/60 text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        id={tabElementId(route, id)}
        aria-selected={selected}
        title={title}
        tabIndex={selected ? 0 : -1}
        data-testid="panel-tab"
        className="flex h-full min-w-0 items-center gap-1.5 rounded-t-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => selectTab(layout, route, id)}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${name}`}
          tabIndex={-1}
          className="mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm opacity-60 outline-none hover:bg-accent hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClose}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}

export function PanelTabStrip({
  route,
  tabs,
  baseLabel,
}: {
  readonly route: string;
  readonly tabs: PanelTabs;
  // "Details", or "Conversation" in a run view (spec 14).
  readonly baseLabel: string;
}) {
  const { layout } = useRuntime();
  const pageReads = useTopic('pageReads') ?? [];
  const nameOf = (tab: PanelTab): string => {
    if (tab.kind === 'file') return tabName(tab);
    const link = runPageRead(pageReads, tab.page.runId)?.pages.find(
      (entry) => entry.ref === tab.page.ref,
    );
    return link ? pageTitle(link) : tabName(tab);
  };
  return (
    <div
      role="tablist"
      aria-label="Panel tabs"
      className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border px-2 pt-1"
    >
      <Tab
        route={route}
        id={DETAILS_TAB}
        name={baseLabel}
        title={baseLabel}
        icon={baseLabel === 'Conversation' ? MessagesSquareIcon : InfoIcon}
        selected={tabs.selected === DETAILS_TAB}
      />
      {tabs.tabs.map((tab) => (
        <Tab
          key={tab.id}
          route={route}
          id={tab.id}
          name={nameOf(tab)}
          title={tab.kind === 'file' ? tab.file.path : nameOf(tab)}
          icon={tabIcon(tab)}
          selected={tabs.selected === tab.id}
          onClose={() => closeTab(layout, route, tab.id)}
        />
      ))}
    </div>
  );
}
