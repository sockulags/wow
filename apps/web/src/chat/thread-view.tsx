import {
  providerChatOptions,
  TextItemPayload,
  type ProviderInstance,
  type SentImage,
  type SkillRef,
  type Thread,
  type ThreadItem,
} from '@wow/contracts';
import { Link, useRouter } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  GitForkIcon,
  PencilIcon,
  PinIcon,
  RotateCcwIcon,
  SearchXIcon,
  Undo2Icon,
} from 'lucide-react';
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';
import { saveTextFile, useRuntime, useSetting } from '@/app/runtime';
import { normalizeBinding } from '@/app/keybindings';
import { FileLinkContext, type FileLinks } from '@/components/file-links';
import { IconButton, WithTooltip } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDateFormat } from '@/lib/format';
import { rowActionScope } from '@/lib/row-actions';
import { cn } from '@/lib/utils';
import { openInEditor } from '@/panel/editor';
import { routerPanelRoute } from '@/panel/model';
import { fullPathOf, openFile, openHostItem } from '@/panel/viewer';
import { GateBar } from '@/workflows/gate-bar';
import { gateRunForThread } from '@/workflows/model';
import { modelLabel } from './model-label';
import { Composer, type ComposerHandle } from './composer';
import type { QuestionHold } from './question-card';
import { errorMessage, useDispatch, useModels, useTopic } from './data';
import { copyText } from '@/components/copy-button';
import { conversationStore, showConversation, showGoBack } from './conversation-nav';
import { conversationMarkdown, exportFileName } from './conversation-markdown';
import type { FindRequest } from './find-bar';
import type { FindSource } from './find';
import { createOpenStore, OpenStoreContext } from './open-state';
import { forkThread, goBackView, stopGoingBack } from './go-back';
import { notify } from '@/lib/feedback';
import { takeLanded } from './needs-you';
import { HostLinkContext, useHostLinkRules, type HostLinks } from './host-links';
import { PastedLinks } from './pasted-links';
import { BackgroundTasks, backgroundTarget, useBackgroundShown } from './background';
import {
  ChatQuestions,
  ConversationItem,
  QueuedMessageItem,
  StoppedLine,
  WorkingIndicator,
  type ItemContext,
} from './items';
import { TaskPin } from './task-pin';
import { ToolCallGroup } from './tools/group';
import {
  canMarkDone,
  contextPercent,
  formatTokens,
  lastTurn,
  latestContext,
  permissionOptions,
  runLabel,
  threadTitle,
  runningTurn,
  type ContextUsage,
} from './model';
import { ModelBar, useModelBarKeys, type ModelBarHandle, type ModelBarProps } from './model-bar';
import { frontModelBar } from './model-commands';
import { ThreadChangesChip } from './thread-changes';
import { ThreadTitle } from './thread-title';
import {
  finishedReasoning,
  groupQuestions,
  groupToolCalls,
  lastErrorId,
  nestSubagentWork,
  turnEndRows,
  workingFacts,
  lastUserSent,
  pendingApproval,
  pendingQuestion,
  providerLabel,
  recentSkillNames,
  type ConversationEntry,
} from './view-model';

export const threadStateLabels: Readonly<Record<Thread['state'], string>> = {
  idle: 'Idle',
  working: 'Working',
  needs_you: 'Needs you',
  done: 'Done',
  failed: 'Failed',
};

export const stateDotClass: Readonly<Record<Thread['state'], string>> = {
  idle: 'bg-muted-foreground/50',
  working: 'bg-state-working',
  needs_you: 'bg-state-needs-you',
  done: 'bg-state-done',
  failed: 'bg-state-failed',
};

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

function ThreadHeader({
  thread,
  instance,
  instances,
}: {
  thread: Thread;
  instance: ProviderInstance | undefined;
  instances: readonly ProviderInstance[];
}) {
  const send = useDispatch();
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const run = runLabel(thread, runs, workflows);
  const project = projects.find((candidate) => candidate.id === thread.projectId);
  const threads = useTopic('threads') ?? [];
  const origin = thread.forkedFrom
    ? threads.find((candidate) => candidate.id === thread.forkedFrom?.threadId)
    : undefined;
  return (
    <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', stateDotClass[thread.state])}
        />
        <ThreadTitle thread={thread} />
        <span className="sr-only">State:</span>
        <span data-testid="thread-state" className="shrink-0 text-xs text-muted-foreground">
          {threadStateLabels[thread.state]}
        </span>
        {run && thread.runId && (
          <Badge asChild variant="outline" className="min-w-0 text-muted-foreground">
            <Link to="/workflows/runs/$runId" params={{ runId: thread.runId }}>
              <span className="truncate">{run}</span>
            </Link>
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {thread.runId === null && <ThreadChangesChip threadId={thread.id} />}
          <ConversationMenu />
          <IconButton
            label={thread.pinned ? 'Unpin thread' : 'Pin thread'}
            aria-pressed={thread.pinned}
            onClick={() =>
              void send({ type: 'thread.setPinned', threadId: thread.id, pinned: !thread.pinned })
            }
          >
            <PinIcon className={cn(thread.pinned && 'fill-current')} />
          </IconButton>
          {thread.state === 'done' ? (
            <IconButton
              label="Reopen thread"
              onClick={() =>
                void send({ type: 'thread.setDone', threadId: thread.id, done: false })
              }
            >
              <Undo2Icon />
            </IconButton>
          ) : (
            <IconButton
              label="Mark thread done"
              disabled={!canMarkDone(thread)}
              onClick={() => void send({ type: 'thread.setDone', threadId: thread.id, done: true })}
            >
              <CircleCheckIcon />
            </IconButton>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <WithTooltip label={<span className="font-mono">{thread.cwd}</span>}>
          <span
            tabIndex={0}
            data-testid="thread-project"
            className="max-w-48 truncate rounded-sm text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {project?.name ?? baseName(thread.cwd)}
          </span>
        </WithTooltip>
        <span aria-hidden className="text-xs text-muted-foreground">
          ·
        </span>
        <span data-testid="thread-provider" className="text-xs text-muted-foreground">
          {instance ? providerLabel(instance, instances) : thread.providerInstanceId}
        </span>
        {thread.forkedFrom && (
          // A fork names the thread it came from (agent workbench spec 71).
          <span
            data-testid="thread-forked-from"
            className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          >
            <span aria-hidden>·</span>
            <GitForkIcon aria-hidden className="size-3 shrink-0" />
            Forked from{' '}
            <Link
              to="/chat/$threadId"
              params={{ threadId: thread.forkedFrom.threadId }}
              className="max-w-48 truncate underline-offset-2 hover:underline"
            >
              {origin ? threadTitle(origin) : 'a thread no longer here'}
            </Link>
          </span>
        )}
      </div>
    </header>
  );
}

// The header's menu: copy or save the conversation as Markdown (thread work spec 7), through the
// conversation on screen, which the palette commands use too.
function ConversationMenu() {
  const find = useStore(conversationStore, (state) => state.handle?.find);
  if (!find) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="More thread actions">
          <EllipsisIcon />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void find.copyMarkdown()}>
          <CopyIcon />
          Copy conversation as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void find.saveMarkdown()}>
          <DownloadIcon />
          Save conversation…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// From the warning share on (a setting, spec 47) the meter is amber and reads "Context 82 %
// full", with "Compact now" where the provider can compact.
function ContextMeter({
  context,
  warnAt,
  onCompact,
}: {
  context: ContextUsage;
  warnAt: number;
  onCompact: (() => void) | undefined;
}) {
  const percent = contextPercent(context);
  const full = percent >= warnAt;
  return (
    <div
      data-full={full || undefined}
      className={cn(
        'flex items-center gap-2 text-2xs tabular-nums',
        full ? 'text-state-needs-you-text' : 'text-muted-foreground',
      )}
    >
      <div
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1 w-24 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full', full ? 'bg-state-needs-you' : 'bg-ring')}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span data-testid="context-meter">
        {full
          ? `Context ${percent} % full`
          : `${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)} context (${percent}%)`}
      </span>
      {onCompact && (
        <Button size="xs" variant={full ? 'outline' : 'ghost'} onClick={onCompact}>
          {full ? 'Compact now' : 'Compact'}
        </Button>
      )}
    </div>
  );
}

// Follows the stream until the user scrolls up to read; output that arrives meanwhile shows
// "New output", which (or End) goes back down and follows again (spec 73).
function useStickToBottom(dependency: unknown) {
  const container = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [newOutput, setNewOutput] = useState(false);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else setNewOutput(true);
  }, [dependency]);
  const onScroll = () => {
    const element = container.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (pinned.current) setNewOutput(false);
  };
  const toEnd = useCallback(() => {
    const element = container.current;
    pinned.current = true;
    setNewOutput(false);
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  return { container, onScroll, newOutput, toEnd };
}

// What the palette and the keys ask of the conversation on screen, as it is at the time.
interface ConversationActions {
  moveMessage(step: -1 | 1): void;
  toEnd(): void;
  openFind(kind: FindRequest['kind']): void;
  copyMarkdown(): Promise<unknown>;
  saveMarkdown(): Promise<unknown>;
}

// Loaded on first use, with the markdown parser find reads messages through.
const FindBar = lazy(() => import('./find-bar'));

export function ThreadView({ threadId }: { threadId: string }) {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const thread = threads?.find((candidate) => candidate.id === threadId);

  if (threads && !thread) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="Thread not found"
        description="It may have been removed, or the link is from another wow home."
      />
    );
  }
  if (!thread) return null;
  const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadHeader thread={thread} instance={instance} instances={instances} />
      {/* Opening a thread puts the focus where the next message goes (audit A-11). */}
      <ThreadConversation thread={thread} instance={instance} autoFocus />
    </div>
  );
}

// Above the composer while it holds the last message to send again (agent workbench spec 62,
// 63): what sending does, and that files stay as the replaced turn left them.
function EditNotice({ changedFiles, onCancel }: { changedFiles: boolean; onCancel: () => void }) {
  return (
    <div
      data-testid="edit-notice"
      role="status"
      className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
    >
      <PencilIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground">
          Editing your last message. Sending it replaces that message and its answer.
        </span>
        {changedFiles && (
          <span data-testid="edit-files-note">
            Files stay as they are: what that turn changed is not undone.
          </span>
        )}
      </div>
      <Button size="xs" variant="ghost" className="ml-auto" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

// What the Assistant view adds to a conversation without a copy of it: rows after an item and
// at the end, and its own composer text, check and notice. Skills are not offered there.
export interface ConversationExtras {
  after?(item: ThreadItem): ReactNode;
  readonly end?: ReactNode;
  readonly composerRef?: RefObject<ComposerHandle | null>;
  readonly placeholder?: string;
  readonly blockedReason?: string | undefined;
  beforeSend?(text: string): boolean;
  // The same check for what is typed on an agent's question card.
  readonly questionHold?: QuestionHold;
  readonly notice?: ReactNode;
  // Its own composer bar (the assistant's settings), or null for none; left out, the thread's
  // own bar, so extras for another reason never drop it.
  readonly modelBar?: Omit<ModelBarProps, 'ref' | 'returnFocus'> | null;
  // How a tool call reads: undefined as the tool's own row, a text for a row in those words,
  // null for no row of its own (what `after` draws for it already says it, spec 82).
  toolWords?(item: ThreadItem): string | null | undefined;
}

// A thread's conversation, its gate bar and its composer: the chat view's thread and, narrower,
// the context panel's step thread (owner decision F-1), so both answer the same way.
export function ThreadConversation({
  thread,
  instance,
  autoFocus = false,
  compact = false,
  extras,
}: {
  thread: Thread;
  instance: ProviderInstance | undefined;
  autoFocus?: boolean;
  // The context panel: no centered column, tighter padding.
  compact?: boolean;
  extras?: ConversationExtras;
}) {
  const threadId = thread.id;
  const send = useDispatch();
  const turns = useTopic('turns', threadId) ?? [];
  const storedItems = useTopic('threadItems', threadId);
  // Edit and Fork (agent workbench spec 62, 71): a replaced exchange shows only as the earlier
  // version on the message that replaced it.
  const goBack = useMemo(() => goBackView(turns, storedItems ?? []), [turns, storedItems]);
  const items = useMemo(
    () => storedItems?.filter((item) => !goBack.replaced.has(item.turnId)),
    [storedItems, goBack],
  );
  const approvals = useTopic('approvals', threadId) ?? [];
  const questions = useTopic('questions', threadId) ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const showMeter = useSetting('chat.contextMeter');
  const resumePrompt = useSetting('chat.resumePrompt');
  const groupTools = useSetting('chat.groupToolCalls');
  const outputLines = useSetting('chat.toolOutputLines');
  const skillTrigger = useSetting('chat.skillTrigger');
  const warnAt = useSetting('chat.contextWarnPercent');
  const reasoningByDefault = useSetting('chat.reasoningOpen');
  const stopKey = useSetting('keybindings.stopTurn');
  const reasoningToggle = useStore(conversationStore, (state) => state.reasoning[thread.id]);
  const findLimit = useSetting('chat.findMaxMatches');
  const exportReasoning = useSetting('chat.exportReasoning');
  // What find and a click opened (thread work spec 4), for as long as this thread is on screen.
  const openStore = useMemo(() => {
    void threadId;
    return createOpenStore();
  }, [threadId]);
  const { models } = useModels(instance?.id);
  const { when } = useDateFormat();
  const { container, onScroll, newOutput, toEnd } = useStickToBottom(items);
  const list = useRef<HTMLOListElement>(null);
  const ownComposer = useRef<ComposerHandle>(null);
  const composer = extras?.composerRef ?? ownComposer;
  const bar = useRef<ModelBarHandle>(null);
  const barKeys = useModelBarKeys(bar);
  const barId = useId();
  const runtime = useRuntime();
  const { settings, layout, connection } = runtime;
  const editorBinding = useSetting('keybindings.openInEditor');
  // Read when a file opens: the conversation is also drawn without a router (tests, previews).
  const router: ReturnType<typeof useRouter> | undefined = useRouter({ warn: false });
  // Paths in messages, Open on tool rows and file chips open in a panel tab of the view on screen
  // (agent workbench spec 15 to 17, 56); the Assistant view has none.
  const fileLinks = useMemo<FileLinks | undefined>(
    () =>
      extras || thread.kind === 'assistant'
        ? undefined
        : {
            open: (path) =>
              openFile(
                { settings, layout },
                {
                  scope: { threadId: thread.id },
                  path,
                  fullPath: fullPathOf(thread.cwd, path),
                  from: routerPanelRoute(router),
                },
              ),
            openInEditor: (path) =>
              void openInEditor(connection, { scope: { threadId: thread.id }, path }),
            editorKey: editorBinding === '' ? '' : normalizeBinding(editorBinding),
          },
    [
      extras,
      thread.kind,
      thread.id,
      thread.cwd,
      settings,
      layout,
      router,
      connection,
      editorBinding,
    ],
  );

  // Links to the user's hosts in messages are chips that open in a panel tab (agent workbench
  // spec 20 to 25); the Assistant view has none, like file links.
  const linksOn = fileLinks !== undefined;
  const hostRules = useHostLinkRules(linksOn ? thread.id : undefined);
  const hostReads = useTopic('hostItemReads', linksOn ? thread.id : undefined);
  const hostLinks = useMemo<HostLinks | undefined>(
    () =>
      linksOn
        ? {
            threadId: thread.id,
            rules: hostRules,
            reads: hostReads ?? [],
            open: (item) =>
              openHostItem(
                { settings, layout },
                { threadId: thread.id, item, from: routerPanelRoute(router) },
              ),
          }
        : undefined,
    [linksOn, thread.id, hostRules, hostReads, settings, layout, router],
  );

  useEffect(() => {
    // "Next that needs you" put the keyboard on a card here; the composer leaves it there.
    if (takeLanded(`thread:${threadId}`)) return;
    if (autoFocus) composer.current?.focus();
  }, [autoFocus, threadId, composer]);

  // The conversation on screen answers Alt+Up/Down, C and End (spec 73, 74); a step's thread in
  // the side panel leaves them to the view.
  const messageRows = () => [
    ...(list.current?.querySelectorAll<HTMLElement>(':scope > li[data-message]') ?? []),
  ];
  const moveMessage = (step: -1 | 1) => {
    const rows = messageRows();
    const at = rows.findIndex((row) => row.contains(document.activeElement));
    const next = at === -1 ? rows.at(-1) : rows[Math.min(rows.length - 1, Math.max(0, at + step))];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };
  const latestItems = useRef(items);
  latestItems.current = items;
  // Find and the export belong to a chat thread's conversation in the chat view, a step's thread
  // opened there included; not the Assistant view, nor a step's thread in the side panel (spec 9).
  const findable = !extras && !compact && thread.kind !== 'assistant';
  const [find, setFind] = useState<{
    readonly threadId: string;
    readonly open: boolean;
    readonly query: string;
    readonly request: FindRequest;
  }>({ threadId, open: false, query: '', request: { kind: 'focus', count: 0 } });
  const findShown = find.threadId === threadId && find.open;
  const findReturn = useRef<HTMLElement | null>(null);
  const openFind = (kind: FindRequest['kind']) => {
    const active = document.activeElement;
    if (!findShown && active instanceof HTMLElement) findReturn.current = active;
    setFind((state) => ({
      threadId,
      open: true,
      query: state.threadId === threadId ? state.query : '',
      request: { kind, count: state.request.count + 1 },
    }));
  };
  const closeFind = () => {
    setFind((state) => ({ ...state, open: false }));
    const back = findReturn.current;
    findReturn.current = null;
    if (back?.isConnected) back.focus();
    else composer.current?.focus();
  };
  const nav = useRef<ConversationActions | null>(null);
  useEffect(() => {
    if (compact) return undefined;
    return showConversation(threadId, {
      previousMessage: () => nav.current?.moveMessage(-1),
      nextMessage: () => nav.current?.moveMessage(1),
      toEnd: () => nav.current?.toEnd(),
      copyFocused: () => {
        const id = conversationStore.getState().focusedMessage;
        const focused = latestItems.current?.find((item) => item.id === id);
        const parsed = focused ? TextItemPayload.safeParse(focused.payload) : undefined;
        return parsed?.success ? copyText(parsed.data.text) : undefined;
      },
      ...(findable
        ? {
            find: {
              open: () => nav.current?.openFind('focus'),
              next: () => nav.current?.openFind('next'),
              previous: () => nav.current?.openFind('previous'),
              copyMarkdown: () => nav.current?.copyMarkdown(),
              saveMarkdown: () => nav.current?.saveMarkdown(),
            },
          }
        : {}),
    });
  }, [compact, threadId, findable]);
  useEffect(() => {
    if (compact) return;
    conversationStore.setState((state) =>
      state.threadId === threadId ? { scrolledUp: newOutput } : state,
    );
  }, [compact, threadId, newOutput]);
  const trackFocus = (event: React.FocusEvent<HTMLOListElement>) => {
    rowActionScope(event);
    if (compact) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('li[data-message]');
    conversationStore.setState({ focusedMessage: row?.dataset['itemId'] });
  };
  const leaveFocus = (event: React.FocusEvent<HTMLOListElement>) => {
    if (compact || list.current?.contains(event.relatedTarget as Node | null)) return;
    conversationStore.setState({ focusedMessage: undefined });
  };

  const running = runningTurn(turns);
  const last = lastTurn(turns);
  const canResume = !running && (last?.state === 'failed' || last?.state === 'interrupted');
  const compactPrompt = instance ? providerChatOptions[instance.kind].compactPrompt : null;
  const message = (
    text: string,
    skills?: readonly SkillRef[],
    files?: readonly string[],
    images?: readonly SentImage[],
  ) =>
    send({
      type: 'thread.sendMessage',
      threadId,
      text,
      ...(skills ? { skills: [...skills] } : {}),
      ...(files && files.length > 0 ? { files: [...files] } : {}),
      ...(images && images.length > 0
        ? { attachments: images.map(({ id, name }) => (name ? { id, name } : { id })) }
        : {}),
    });
  const stop = () => void send({ type: 'thread.interrupt', threadId });
  // A chat thread in the chat view offers Edit and Fork where its provider can go back; on
  // Codex the palette says why not (spec 63, 71).
  const goBackShown =
    !extras && !compact && thread.kind !== 'assistant' && thread.runId === null && !!instance;
  const goBackRefusal =
    goBackShown && instance
      ? (providerChatOptions[instance.kind].cannotGoBack ?? undefined)
      : undefined;
  const goesBack = goBackShown && goBackRefusal === undefined;
  const [editing, setEditing] = useState<{ threadId: string; turnId: string } | undefined>();
  const edited =
    editing?.threadId === threadId && goBack.editable?.turnId === editing.turnId
      ? goBack.editable
      : undefined;
  const startEdit = () => {
    const lastSent = goBack.editable;
    if (!goesBack || !lastSent) return false;
    setEditing({ threadId, turnId: lastSent.turnId });
    // putBack drops the mention line where the files come back as chips.
    composer.current?.putBack(lastSent.text, lastSent.skills, lastSent.images, lastSent.files);
    return true;
  };
  const cancelEdit = () => {
    setEditing(undefined);
    composer.current?.setText('');
  };
  const editLast = (
    text: string,
    skills?: readonly SkillRef[],
    files?: readonly string[],
    images?: readonly SentImage[],
  ) =>
    edited
      ? send({
          type: 'thread.editLast',
          threadId,
          turnId: edited.turnId,
          text,
          ...(skills ? { skills: [...skills] } : {}),
          ...(files && files.length > 0 ? { files: [...files] } : {}),
          ...(images && images.length > 0
            ? { attachments: images.map(({ id, name }) => (name ? { id, name } : { id })) }
            : {}),
        }).then((receipt) => {
          setEditing(undefined);
          return receipt;
        })
      : message(text, skills, files, images);
  const fork = (turnId: string) =>
    void forkThread(send, thread, turnId).then(
      (forkId) => router?.navigate({ to: '/chat/$threadId', params: { threadId: forkId } }),
      (error: unknown) => notify.error(errorMessage(error)),
    );
  const stuck = goesBack
    ? stopGoingBack(thread, canResume && last?.state === 'failed', send)
    : undefined;
  const goOn = stuck
    ? {
        ...stuck,
        run: () => void stuck.run().catch((error: unknown) => notify.error(errorMessage(error))),
      }
    : undefined;
  const goBackActions = useRef({ startEdit, fork, goOn });
  goBackActions.current = { startEdit, fork, goOn };
  const goOnTitle = goOn?.title;
  const goOnDetail = goOn?.detail;
  const forkableKey = [...goBack.forkable.keys()].join('\n');
  const editableId = goesBack ? goBack.editable?.itemId : undefined;
  useEffect(() => {
    if (!goBackShown) return undefined;
    const forkable = forkableKey === '' ? [] : forkableKey.split('\n');
    return showGoBack(threadId, {
      refusal: goBackRefusal,
      editable: editableId,
      forkable: goBackRefusal === undefined ? forkable : [],
      edit: () => void goBackActions.current.startEdit(),
      fork: (itemId) => {
        const turnId = itemId.replace(/:user$/, '');
        goBackActions.current.fork(turnId);
      },
      ...(goOnTitle !== undefined && goOnDetail !== undefined
        ? {
            goOn: {
              title: goOnTitle,
              detail: goOnDetail,
              run: () => goBackActions.current.goOn?.run(),
            },
          }
        : {}),
    });
  }, [goBackShown, threadId, goBackRefusal, editableId, forkableKey, goOnTitle, goOnDetail]);
  useEffect(() => {
    setEditing(undefined);
  }, [threadId]);
  const cancelQueued = () => send({ type: 'thread.cancelQueued', threadId });
  // Off the queue first, so a message the server sent meanwhile is not put back as unsent.
  const editQueued = async () => {
    const queued = thread.queued;
    if (!queued) return;
    await cancelQueued();
    composer.current?.putBack(
      queued.text,
      queued.skills ?? [],
      queued.images ?? [],
      queued.files ?? [],
    );
  };
  const approval = pendingApproval(approvals);
  const question = pendingQuestion(questions, items ?? [], running);
  const gateRun = gateRunForThread(thread, runs);
  const context = latestContext(items ?? []);
  const retry = lastUserSent(items ?? []);
  const errorId = canResume ? lastErrorId(items ?? []) : undefined;
  // A stopped turn's line carries Resume; the footer keeps it for a stopped turn with no items.
  const stoppedLineResumes =
    last?.state === 'interrupted' && (items ?? []).some((item) => item.turnId === last.id);
  const permissionLabel = instance
    ? (permissionOptions(instance.kind, thread.permissionMode).find(
        (option) => option.id === thread.permissionMode,
      )?.label ?? thread.permissionMode)
    : thread.permissionMode;
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  // A subagent's work is drawn under its call (spec 44), not in the conversation itself.
  const { top, children } = nestSubagentWork(items ?? []);
  const endRows = turnEndRows(top, turns);
  const reasoningDone = finishedReasoning(items ?? []);
  const labelOf = (id: string) => modelLabel(models, id);
  const modeLabel = (id: string) =>
    instance
      ? (permissionOptions(instance.kind, id).find((option) => option.id === id)?.label ?? id)
      : id;
  const reasoningOpen = reasoningToggle?.open ?? reasoningByDefault;
  const words = new Map(
    (items ?? []).flatMap((item) => {
      const said = item.kind === 'tool_call' ? extras?.toolWords?.(item) : undefined;
      return said === undefined ? [] : [[item.id, said] as const];
    }),
  );
  const itemContext = (turnId: string, itemId: string): ItemContext => {
    const turn = turnById.get(turnId);
    const said = words.get(itemId);
    return {
      itemId,
      modelLabel: labelOf,
      modeLabel,
      ...(endRows.has(itemId) && turn?.endedAt ? { endedAt: turn.endedAt } : {}),
      reasoningDone: reasoningDone.has(itemId),
      ...(reasoningToggle || reasoningByDefault ? { reasoningOpen } : {}),
      reasoningKey: reasoningToggle?.count ?? 0,
      children: children.get(itemId),
      childContext: (child) => itemContext(child.turnId, child.id),
      ...(typeof said === 'string' ? { toolWords: said } : {}),
      cwd: thread.cwd,
      permissionLabel,
      turnEnded: turn !== undefined && turn.state !== 'running',
      at: turn?.startedAt,
      awaitingApproval: approval !== undefined,
      ...(approval ? { keyedApproval: { id: approval.id, side: compact } } : {}),
      formatAt: when,
      questionHold: extras?.questionHold,
      outputLines,
      // An edited file opens in a tab of the view on screen, like a path in a message (spec 17,
      // 33); the Assistant view opens none.
      ...(fileLinks ? { openFile: fileLinks.open } : {}),
      ...(goesBack && goBack.editable?.itemId === itemId ? { onEdit: () => void startEdit() } : {}),
      ...(goesBack && goBack.forkable.has(itemId) ? { onFork: () => fork(turnId) } : {}),
      earlier: goBack.earlier.get(turnId),
      recovery:
        itemId === errorId
          ? {
              ...(retry
                ? {
                    // A step's message goes again as the step sent it, its skills' texts
                    // filled in for the run, not as skills picked in a chat.
                    onRetry: () =>
                      void (thread.stepId !== null
                        ? send({ type: 'thread.retry', threadId })
                        : message(
                            retry.text,
                            retry.skills.length > 0 ? retry.skills : undefined,
                            undefined,
                            retry.images.length > 0 ? retry.images : undefined,
                          )),
                  }
                : {}),
              onResume: () => void message(resumePrompt),
              resumePrompt,
              goOn,
            }
          : undefined,
    };
  };

  const afters = new Map(top.map((item) => [item.id, extras?.after?.(item)]));
  const entries: ConversationEntry[] = groupQuestions(
    groupTools
      ? groupToolCalls(
          top,
          (item) => Boolean(afters.get(item.id)),
          (item) => words.get(item.id) === null,
        )
      : top.map((item) => ({ kind: 'item', item })),
  );
  const instanceName = instance?.name ?? thread.providerInstanceId;
  const markdown = () =>
    conversationMarkdown({
      title: threadTitle(thread),
      instanceName,
      model: labelOf(thread.model),
      project: projects.find((candidate) => candidate.id === thread.projectId)?.name,
      folder: thread.cwd,
      branch: thread.branch,
      exportedAt: new Date().toISOString(),
      items: items ?? [],
      turns,
      approvals,
      questions,
      formatAt: (iso) => when(iso),
      modelLabel: labelOf,
      modeLabel,
      reasoning: exportReasoning,
    });
  const copyMarkdown = () =>
    copyText(markdown()).then((copied) => {
      if (copied) notify.success('Conversation copied as Markdown');
      return copied;
    });
  const saveMarkdown = () =>
    saveTextFile(runtime, {
      suggestedName: exportFileName(threadTitle(thread)),
      text: markdown(),
    }).then(
      (saved) => {
        if (saved !== null) notify.success('Conversation saved', { description: saved });
        return saved;
      },
      (error: unknown) =>
        notify.error('The conversation was not saved', {
          description: errorMessage(error),
        }),
    );
  nav.current = { moveMessage, toEnd, openFind, copyMarkdown, saveMarkdown };
  const findSource: FindSource = {
    entries,
    children,
    turns,
    approvals,
    questions,
    cwd: thread.cwd,
    outputLines,
    modelLabel: labelOf,
    modeLabel,
  };

  const backgroundTasks = thread.backgroundTasks ?? [];
  useBackgroundShown(
    threadId,
    !compact && !extras,
    backgroundTasks,
    backgroundTarget(top, running?.id, approvals),
    instance?.kind,
  );

  // While a question waits, the composer answers it with typed text, as its card's "Other" does;
  // while an approval waits, the buttons above answer it and the composer only queues the next
  // message (audit C-04).
  const answerQuestion = question
    ? (
        text: string,
        skills?: readonly SkillRef[],
        _files?: readonly string[],
        images?: readonly SentImage[],
      ) =>
        skills
          ? Promise.reject(
              new Error('An answer takes no skills. Remove the chip, or answer on the card.'),
            )
          : images
            ? Promise.reject(
                new Error('An answer takes no images. Remove them, or answer on the card.'),
              )
            : send({
                type: 'question.answer',
                answers: [{ questionId: question.id, reply: { picked: [], text } }],
              })
    : undefined;
  const placeholder = question
    ? 'Type your answer, or answer on the card above'
    : approval
      ? 'Answer the request above'
      : running
        ? 'Write the next message; it is sent when the turn ends'
        : (extras?.placeholder ?? `Message the agent. Type ${skillTrigger} to pick a skill.`);

  // A chat or step thread picks its model, effort and mode in the bar; the pick applies to the
  // next turn (agent workbench spec 1, 2, 5).
  const barProps: Omit<ModelBarProps, 'ref' | 'returnFocus'> | null | undefined =
    extras?.modelBar !== undefined
      ? extras.modelBar
      : instance && {
          providerInstanceId: instance.id,
          kind: instance.kind,
          value: thread,
          defaults: { model: instance.defaultModel, effort: instance.defaultEffort },
          onChange: (changes) => send({ type: 'thread.configure', threadId, ...changes }),
        };
  const modelBar = barProps && (
    <ModelBar id={barId} ref={bar} {...barProps} returnFocus={() => composer.current?.focus()} />
  );

  const column = compact ? 'w-full px-3' : 'mx-auto w-full max-w-3xl px-4';
  return (
    <FileLinkContext value={fileLinks}>
      <HostLinkContext value={hostLinks}>
        <OpenStoreContext value={openStore}>
          {findable && findShown && (
            <Suspense fallback={null}>
              <FindBar
                source={findSource}
                root={list}
                store={openStore}
                query={find.query}
                onQuery={(query) => setFind((state) => ({ ...state, query }))}
                request={find.request}
                limit={findLimit}
                onClose={closeFind}
              />
            </Suspense>
          )}
          <div
            ref={container}
            onScroll={onScroll}
            className={cn('min-h-0 flex-1 overflow-y-auto', compact ? 'py-3' : 'py-4')}
            data-testid="conversation"
          >
            <div className={column}>
              <ol
                ref={list}
                aria-label="Conversation"
                className="flex flex-col gap-3"
                onFocus={trackFocus}
                onBlur={leaveFocus}
              >
                {entries.map((entry, index) => {
                  const tail = entry.kind === 'item' ? entry.item : entry.items.at(-1);
                  const after = tail && afters.get(tail.id);
                  const next = entries[index + 1];
                  const nextTurn =
                    next?.kind === 'item' ? next.item.turnId : next?.items[0]?.turnId;
                  const turn = tail && turnById.get(tail.turnId);
                  // A stopped turn ends with its line; Resume sits on the last one (spec 89).
                  const stopped =
                    turn?.state === 'interrupted' && nextTurn !== turn.id ? turn : undefined;
                  return (
                    <Fragment key={entry.kind === 'item' ? entry.item.id : entry.id}>
                      {entry.kind === 'item' &&
                      words.get(entry.item.id) === null ? null : entry.kind === 'item' ? (
                        <ConversationItem
                          item={entry.item}
                          approvals={approvals}
                          questions={questions}
                          context={itemContext(entry.item.turnId, entry.item.id)}
                        />
                      ) : entry.kind === 'questions' ? (
                        <li data-testid="item-question" data-item-id={entry.id}>
                          <ChatQuestions
                            items={entry.items}
                            questions={questions}
                            turnEnded={
                              itemContext(entry.items[0]?.turnId ?? '', entry.id).turnEnded
                            }
                            hold={extras?.questionHold}
                          />
                        </li>
                      ) : (
                        <ToolCallGroup
                          items={entry.items}
                          contextOf={(item) => itemContext(item.turnId, item.id)}
                          closed={next !== undefined || after !== undefined}
                        />
                      )}
                      {after && <li>{after}</li>}
                      {stopped && (
                        <li>
                          <StoppedLine
                            turn={stopped}
                            formatAt={when}
                            resume={
                              canResume && stopped.id === last?.id
                                ? {
                                    onResume: () => void message(resumePrompt),
                                    prompt: resumePrompt,
                                  }
                                : undefined
                            }
                          />
                        </li>
                      )}
                    </Fragment>
                  );
                })}
                {extras?.end && <li>{extras.end}</li>}
                {thread.queued && (
                  <QueuedMessageItem
                    queued={thread.queued}
                    onCancel={cancelQueued}
                    onEdit={editQueued}
                  />
                )}
              </ol>
              {running && thread.state === 'working' && (
                <div className="mt-3">
                  <WorkingIndicator
                    startedAt={running.startedAt}
                    facts={workingFacts(items ?? [], running.id, thread.cwd)}
                    stopKey={stopKey}
                  />
                </div>
              )}
              {backgroundTasks.length > 0 && (
                <div className="mt-3">
                  <BackgroundTasks
                    tasks={backgroundTasks}
                    threadId={threadId}
                    kind={instance?.kind}
                    waiting={!running}
                  />
                </div>
              )}
            </div>
          </div>
          {newOutput && (
            <div className="relative">
              <Button
                size="xs"
                variant="secondary"
                className="absolute -top-9 left-1/2 -translate-x-1/2 shadow-md"
                onClick={toEnd}
              >
                <ArrowDownIcon />
                New output
              </Button>
            </div>
          )}
          <div
            className={cn('flex shrink-0 flex-col gap-2', column, compact ? 'pb-3' : 'pb-4')}
            // The palette's model commands go to the bar whose composer had the focus last.
            onFocus={() => frontModelBar(barId)}
          >
            <TaskPin threadId={threadId} items={items ?? []} turns={turns} />
            {gateRun && (
              <GateBar
                run={gateRun}
                workflow={workflows.find((candidate) => candidate.id === gateRun.workflowId)}
                project={projects.find((candidate) => candidate.id === gateRun.projectId)}
                review={false}
              />
            )}
            {hostLinks && <PastedLinks draftKey={threadId} links={hostLinks} />}
            <Composer
              ref={composer}
              providerKind={extras ? undefined : instance?.kind}
              running={running !== undefined && !question}
              placeholder={placeholder}
              blockedReason={extras?.blockedReason}
              onSend={answerQuestion ?? (edited ? editLast : message)}
              onStop={stop}
              notice={
                edited ? (
                  <EditNotice changedFiles={edited.changedFiles} onCancel={cancelEdit} />
                ) : (
                  extras?.notice
                )
              }
              onRecall={goesBack && goBack.editable && !question ? startEdit : undefined}
              bar={modelBar}
              onBarKey={barKeys}
              // The Assistant view keeps no draft (its text may hold a secret) and lists no commands.
              draftKey={extras ? undefined : threadId}
              commandSource={
                extras || compact || !instance
                  ? undefined
                  : { providerInstanceId: instance.id, cwd: thread.cwd, threadId }
              }
              {...(extras?.beforeSend ? { beforeSend: extras.beforeSend } : {})}
              fileSource={fileLinks ? { threadId } : undefined}
              recentSkills={recentSkillNames(items ?? [])}
              // Images go only with chat threads: the Assistant view (spec 61) and a workflow step,
              // wherever it is shown, take none.
              imageTarget={fileLinks && thread.stepId === null ? { threadId } : undefined}
              footer={
                (showMeter && context) || (canResume && !errorId && !stoppedLineResumes) ? (
                  <div className="flex min-h-6 flex-wrap items-center gap-3">
                    {showMeter && context && (
                      <ContextMeter
                        context={context}
                        warnAt={warnAt}
                        onCompact={
                          compactPrompt !== null && !running
                            ? () => void message(compactPrompt)
                            : undefined
                        }
                      />
                    )}
                    {canResume && !errorId && !stoppedLineResumes && (
                      // A stopped turn has no error row to carry Resume, so it sits here.
                      <WithTooltip label={`Sends: ${resumePrompt}`}>
                        <Button
                          size="xs"
                          variant="outline"
                          className="ml-auto"
                          onClick={() => void message(resumePrompt)}
                        >
                          <RotateCcwIcon />
                          Resume
                        </Button>
                      </WithTooltip>
                    )}
                  </div>
                ) : undefined
              }
            />
          </div>
        </OpenStoreContext>
      </HostLinkContext>
    </FileLinkContext>
  );
}
