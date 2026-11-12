import {
  providerKindLabels,
  TerminalSession,
  type Project,
  type ProviderInstance,
  type Thread,
} from '@wow/contracts';
import type { Connection } from '@wow/client-runtime';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useLayout, useRuntime } from '@/app/runtime';
import type { AppCommand } from '@/app/commands';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDateFormat } from '@/lib/format';
import { notify } from '@/lib/feedback';
import { errorMessage, requestModels, useDispatch, useTopic } from './data';
import { threadDefaults } from './new-thread';
import { lastUsedThread } from './view-model';

// "Open session from Claude Code / Codex…" (agent workbench spec 72): the sessions the
// configured instances keep in their own files, per folder, newest first. A pick opens the wow
// thread that already resumes it, or makes one that does, in the session's folder and project.
// A session whose folder is gone is listed greyed with the reason and cannot be picked.

export const openSessionTitle = 'Open session from Claude Code / Codex…';

export function sessionCommands(): AppCommand[] {
  return [
    {
      id: 'chat.openSession',
      title: openSessionTitle,
      group: 'Chat',
      keywords: ['session', 'terminal', 'resume', 'claude code', 'codex', 'continue'],
      run: ({ layout }) => layout.setState({ sessionDialog: true }),
    },
  ];
}

export interface FolderSessions {
  readonly cwd: string;
  readonly project: Project | undefined;
  readonly sessions: readonly TerminalSession[];
}

// Folders in the order of their newest session; sessions newest first within each.
export function sessionsByFolder(
  sessions: readonly TerminalSession[],
  projects: readonly Project[],
): FolderSessions[] {
  const folders = new Map<string, TerminalSession[]>();
  for (const session of sessions) {
    const list = folders.get(session.cwd) ?? [];
    list.push(session);
    folders.set(session.cwd, list);
  }
  return [...folders].map(([cwd, list]) => ({
    cwd,
    project: projects.find((project) => project.id === list[0]?.projectId),
    sessions: list,
  }));
}

export const sessionTitle = (session: Pick<TerminalSession, 'firstPrompt'>): string =>
  session.firstPrompt ?? 'No prompt';

type SessionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly sessions: readonly TerminalSession[] }
  | { readonly status: 'error'; readonly message: string };

// Asked each time the dialog opens: the CLIs write their files while wow is not looking.
function useTerminalSessions(open: boolean): SessionsState {
  const { connection } = useRuntime();
  const [state, setState] = useState<SessionsState>({ status: 'loading' });
  useEffect(() => {
    if (!open) return undefined;
    if (!connection) {
      setState({ status: 'error', message: 'Not connected to the wow server' });
      return undefined;
    }
    let live = true;
    setState({ status: 'loading' });
    connection.request('provider.listSessions', {}).then(
      (result) => {
        const parsed = TerminalSession.array().parse(
          (result as { readonly sessions: unknown }).sessions,
        );
        if (live) setState({ status: 'done', sessions: parsed });
      },
      (error: unknown) => live && setState({ status: 'error', message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [open, connection]);
  return state;
}

// The thread a session opens as: the instance's usual start, as a new thread in that project
// would have it, with the session to resume.
export async function openSession(
  session: TerminalSession,
  deps: {
    readonly connection: Connection;
    readonly instances: readonly ProviderInstance[];
    readonly projects: readonly Project[];
    readonly threads: readonly Thread[];
    readonly send: ReturnType<typeof useDispatch>;
  },
): Promise<string> {
  if (session.threadId) return session.threadId;
  const instance = deps.instances.find((entry) => entry.id === session.providerInstanceId);
  if (!instance) throw new Error(`No provider instance ${session.providerInstanceName}`);
  const models = await requestModels(deps.connection, instance.id).catch(() => []);
  const project = deps.projects.find((entry) => entry.id === session.projectId);
  const settings = threadDefaults(instance, models, lastUsedThread(deps.threads), project);
  const threadId = globalThis.crypto.randomUUID();
  await deps.send({
    type: 'thread.create',
    threadId,
    providerInstanceId: instance.id,
    ...(project ? { projectId: project.id } : {}),
    cwd: session.cwd,
    title: session.firstPrompt ?? '',
    ...settings,
    resumeSessionId: session.id,
  });
  return threadId;
}

export function TerminalSessionsDialog() {
  const { layout, connection } = useRuntime();
  const open = useLayout((state) => state.sessionDialog);
  const state = useTerminalSessions(open);
  const projects = useTopic('projects') ?? [];
  const instances = useTopic('providerInstances') ?? [];
  const threads = useTopic('threads') ?? [];
  const send = useDispatch();
  const navigate = useNavigate();
  const { when } = useDateFormat();
  const close = () => layout.setState({ sessionDialog: false });
  const pick = (session: TerminalSession) => {
    if (!connection || session.unavailable) return;
    close();
    openSession(session, { connection, instances, projects, threads, send }).then(
      (threadId) => void navigate({ to: '/chat/$threadId', params: { threadId } }),
      (error: unknown) =>
        notify.error('The session was not opened', { description: errorMessage(error) }),
    );
  };
  const folders = state.status === 'done' ? sessionsByFolder(state.sessions, projects) : [];
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Open session"
      description="Sessions Claude Code and Codex keep in their own files, per folder"
      showCloseButton={false}
      className="top-[12vh] translate-y-0 sm:max-w-2xl"
    >
      <CommandInput aria-label="Session" placeholder={openSessionTitle} />
      <CommandList label="Sessions" className="max-h-[60vh] [&_[cmdk-item]]:py-2">
        {state.status === 'loading' && (
          <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
            Reading the sessions…
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="px-3 py-4 text-sm text-destructive">
            {state.message}
          </p>
        )}
        {state.status === 'done' && (
          <CommandEmpty>No session of Claude Code or Codex found.</CommandEmpty>
        )}
        {folders.map((folder) => (
          <CommandGroup
            key={folder.cwd}
            heading={folder.project ? `${folder.project.name} · ${folder.cwd}` : folder.cwd}
          >
            {folder.sessions.map((session) => (
              <CommandItem
                key={`${session.providerInstanceId}:${session.id}`}
                value={`${session.providerInstanceId}:${session.id} ${sessionTitle(session)} ${folder.cwd} ${folder.project?.name ?? ''}`}
                disabled={session.unavailable !== null}
                data-testid="terminal-session"
                onSelect={() => pick(session)}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="w-full truncate">{sessionTitle(session)}</span>
                <span className="text-xs text-muted-foreground">
                  {[
                    `${providerKindLabels[session.kind]} · ${session.providerInstanceName}`,
                    session.lastUsedAt ? when(session.lastUsedAt) : undefined,
                    session.threadId ? 'Open in wow' : undefined,
                    session.unavailable ?? undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
