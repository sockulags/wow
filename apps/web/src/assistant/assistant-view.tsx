import {
  SecretRef,
  assistantThreadId,
  heldSecretSentence,
  rpcMethods,
  type ThreadItem,
} from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { KeyRoundIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import type { ComposerHandle } from '@/chat/composer';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ThreadConversation } from '@/chat/thread-view';
import { providerLabel } from '@/chat/view-model';
import { Banner } from '@/components/banner';
import { TopicPlaceholder } from '@/components/states';
import { useTopicState } from '@/app/topic-state';
import { Button } from '@/components/ui/button';
import { ConnectAgentStep } from '@/providers/connect-step';
import { storeSecretSetting } from '@/settings/secret-field';
import {
  ProjectWorkCard,
  SecretFieldCard,
  SecretVariableCard,
  storeSecretVariable,
  useStoredRef,
} from './cards';
import {
  askOf,
  askedFields,
  holdMessage,
  isVariable,
  placeRows,
  withoutSecret,
  type Held,
  type Placed,
} from './model';
import { ChangeRow, ProposalCard } from './rows';

// The Assistant section (app assistant spec 1, 3, 7 to 18): the one assistant conversation,
// reusing the chat view's conversation and composer, with change rows, proposals and the cards
// the assistant's tools ask for inline where they happened.

// What `assistant.open` answered: the sentence that says why no provider can run it, or null.
function useOpenProblem(): {
  readonly problem: string | null;
  readonly asked: boolean;
} {
  const { connection } = useRuntime();
  const instances = useTopic('providerInstances');
  const configured = useSetting('assistant.providerInstanceId');
  const allowCodex = useSetting('assistant.allowCodex');
  const [state, setState] = useState<{ problem: string | null; asked: boolean }>({
    problem: null,
    asked: false,
  });
  // Asked again when what decides it changes on the server: an instance's test, the settings.
  const instancesKey = instances
    ?.map((instance) => `${instance.id}:${instance.kind}:${instance.status}`)
    .join(',');
  useEffect(() => {
    if (!connection || instancesKey === undefined) return undefined;
    let current = true;
    connection.request('assistant.open', {}).then(
      (result) => {
        if (current) {
          const { problem } = rpcMethods['assistant.open'].result.parse(result);
          setState({ problem, asked: true });
        }
      },
      (error: unknown) => current && setState({ problem: errorMessage(error), asked: true }),
    );
    return () => {
      current = false;
    };
  }, [connection, instancesKey, configured, allowCodex]);
  return state;
}

function Rows({ placed, patterns }: { placed: Placed; patterns: readonly string[] }) {
  const send = useDispatch();
  if (placed.changes.length === 0 && placed.proposals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {placed.changes.map((change) => (
        <ChangeRow
          key={change.id}
          change={change}
          onUndo={() => send({ type: 'assistant.undo', changeId: change.id })}
        />
      ))}
      {placed.proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          secretPatterns={patterns}
          onYes={() => send({ type: 'assistant.proposal.accept', proposalId: proposal.id })}
          onNo={(reason) =>
            send({
              type: 'assistant.proposal.decline',
              proposalId: proposal.id,
              ...(reason === undefined ? {} : { reason }),
            })
          }
        />
      ))}
    </div>
  );
}

// The line above the composer while a message is held (spec 17): what looks like a secret,
// "Put it in <field>" and "Send anyway". The message is not sent or stored until one is chosen.
export function HeldLine({
  held,
  onPut,
  onSend,
  onDismiss,
}: {
  held: Held;
  onPut: ((replaces: boolean) => Promise<void>) | undefined;
  onSend(): void;
  onDismiss(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A field that holds a value already has it replaced; the line says so before the press.
  const field = held.field;
  const setting = field && !isVariable(field) ? field : undefined;
  const variable = field && isVariable(field) ? field : undefined;
  const storedSetting = useStoredRef(setting?.key ?? '', setting?.projectId);
  const instance = useTopic('providerInstances')?.find(
    (entry) => entry.id === variable?.providerInstanceId,
  );
  const replaces = SecretRef.safeParse(
    variable ? instance?.env[variable.variable] : storedSetting,
  ).success;
  return (
    <div
      role="status"
      data-testid="held-message"
      className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <KeyRoundIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
        <p className="min-w-0 flex-1">{heldSecretSentence(held.match.kind)}</p>
        {onPut && held.field && (
          <Button
            size="xs"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              onPut(replaces).then(
                () => setBusy(false),
                (reason: unknown) => {
                  setBusy(false);
                  setError(errorMessage(reason));
                },
              );
            }}
          >
            Put it in {held.field.label}
          </Button>
        )}
        <Button size="xs" variant="outline" disabled={busy} onClick={onSend}>
          Send anyway
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Keep editing"
          disabled={busy}
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </div>
      {onPut && held.field && replaces && (
        <p data-testid="held-replaces" className="text-muted-foreground">
          {held.field.label} already holds a value; putting this one there replaces it.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function AssistantView() {
  const runtime = useRuntime();
  const { connection } = runtime;
  const { rows: threads, status } = useTopicState('assistantThread');
  const thread = threads?.[0];
  const instances = useTopic('providerInstances') ?? [];
  const items = useTopic('threadItems', thread ? assistantThreadId : undefined);
  const changes = useTopic('assistantChanges') ?? [];
  const proposals = useTopic('assistantProposals') ?? [];
  const patterns = useSetting('assistant.secretPatterns');
  const { problem, asked } = useOpenProblem();
  const composer = useRef<ComposerHandle>(null);
  const [held, setHeld] = useState<Held>();
  const [saved, setSaved] = useState<string>();

  if (status !== 'ready' && !thread) return <TopicPlaceholder status={status} />;
  if (!connection) return <TopicPlaceholder status="offline" />;
  if (!thread && !asked) return <TopicPlaceholder status="loading" />;
  // No provider can run it (spec 27): the sentence and the same step as at first start. The
  // conversation comes back once one passes its test.
  if (!thread || problem) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto">
        <Banner tone="warning" testId="assistant-problem" actions={<ProviderLinks />}>
          {problem ?? 'Opening the assistant…'}
        </Banner>
        <div className="flex justify-center px-6 py-8">
          <ConnectAgentStep />
        </div>
      </div>
    );
  }

  const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);
  const { after, rest } = placeRows(items ?? [], changes, proposals);
  const asks = askedFields(items ?? []);

  const extraAfter = (item: ThreadItem): ReactNode => {
    const ask = askOf(item);
    const placed = after.get(item.id);
    if (!ask && !placed) return null;
    return (
      <div className="flex flex-col gap-2">
        {ask?.kind === 'secretField' && <SecretFieldCard request={ask.request} guide={ask.guide} />}
        {ask?.kind === 'secretVariable' && <SecretVariableCard request={ask.request} />}
        {ask?.kind === 'projectWork' && <ProjectWorkCard offer={ask.offer} />}
        {placed && <Rows placed={placed} patterns={patterns} />}
      </div>
    );
  };

  // The composer sends what its box holds now, the way its own Send does: queued while a turn
  // runs, as the answer to a waiting question.
  const sendAnyway = () => {
    setHeld(undefined);
    composer.current?.sendUnchecked();
  };

  const putInField = (current: Held) => async (replaces: boolean) => {
    const { field } = current;
    if (!field) return;
    if (isVariable(field)) {
      const owner = instances.find((entry) => entry.id === field.providerInstanceId);
      if (!owner) throw new Error(`No provider instance ${field.providerInstanceId}`);
      await storeSecretVariable(connection, field, owner.env, current.match.value);
    } else {
      await storeSecretSetting(
        { connection, settings: runtime.settings },
        field.key,
        field.projectId,
        current.match.value,
      );
    }
    setHeld(undefined);
    setSaved(
      `Saved in ${field.label}${replaces ? ' in place of the value it held' : ''}. It was taken out of your message.`,
    );
    composer.current?.setText(withoutSecret(current, composer.current.text()));
  };

  const notice = held ? (
    <HeldLine
      held={held}
      onPut={held.field ? putInField(held) : undefined}
      onSend={sendAnyway}
      onDismiss={() => setHeld(undefined)}
    />
  ) : saved ? (
    <p role="status" data-testid="held-saved" className="text-xs text-muted-foreground">
      {saved}
    </p>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-medium">Assistant</h2>
        <span data-testid="assistant-provider" className="text-xs text-muted-foreground">
          {instance ? providerLabel(instance, instances) : thread.providerInstanceId}
          {' · '}
          {thread.model}
        </span>
        <Button asChild size="xs" variant="ghost" className="ml-auto">
          <Link to="/settings/$group" params={{ group: 'assistant' }}>
            Settings
          </Link>
        </Button>
      </header>
      <ThreadConversation
        thread={thread}
        instance={instance}
        autoFocus
        extras={{
          after: extraAfter,
          ...(rest.changes.length + rest.proposals.length > 0
            ? { end: <Rows placed={rest} patterns={patterns} /> }
            : {}),
          composerRef: composer,
          placeholder: 'Tell the assistant what to set up or change in wow',
          beforeSend: (text) => {
            setSaved(undefined);
            const found = holdMessage(
              text,
              patterns,
              asks,
              undefined,
              (id) => instances.find((entry) => entry.id === id)?.name,
            );
            setHeld(found ?? undefined);
            return found === null;
          },
          notice,
        }}
      />
    </div>
  );
}

function ProviderLinks() {
  return (
    <div className="flex gap-2">
      <Button asChild size="xs" variant="outline">
        <Link to="/settings/$group" params={{ group: 'providers' }}>
          Settings → Providers
        </Link>
      </Button>
      <Button asChild size="xs" variant="outline">
        <Link to="/settings/$group" params={{ group: 'assistant' }}>
          Settings → Assistant
        </Link>
      </Button>
    </div>
  );
}
