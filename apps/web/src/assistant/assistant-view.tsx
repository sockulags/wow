import {
  SecretRef,
  askedQuestionsOf,
  assistantThreadId,
  heldSecretSentence,
  providerChatOptions,
  rpcMethods,
  type ProviderInstance,
  type Thread,
  type ThreadItem,
} from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { KeyRoundIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import type { ComposerHandle } from '@/chat/composer';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import type { QuestionHold } from '@/chat/question-card';
import type { ModelBarProps } from '@/chat/model-bar';
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
import { AssistantQuestions, askState } from './questions';
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
  // A pick in the bar writes these; asking again brings the thread in line with them.
  const model = useSetting('assistant.model');
  const effort = useSetting('assistant.effort');
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
  }, [connection, instancesKey, configured, allowCodex, model, effort]);
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
  const turns = useTopic('turns', thread ? assistantThreadId : undefined);
  const changes = useTopic('assistantChanges') ?? [];
  const proposals = useTopic('assistantProposals') ?? [];
  const patterns = useSetting('assistant.secretPatterns');
  const { problem, asked } = useOpenProblem();
  const composer = useRef<ComposerHandle>(null);
  const [held, setHeld] = useState<Held>();
  const [saved, setSaved] = useState<string>();
  const storedInstanceId = useSetting('assistant.providerInstanceId');
  const storedModel = useSetting('assistant.model');
  const storedEffort = useSetting('assistant.effort');
  const allowCodex = useSetting('assistant.allowCodex');

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
  const modelBar = assistantBar({
    thread,
    instances,
    stored: {
      instanceId: storedInstanceId,
      model: storedModel,
      effort: storedEffort,
      allowCodex,
    },
    write: (key, value) =>
      runtime.settings.write(key, value).then(
        (result) => {
          if (!result.ok) setSaved(`Could not save ${key}: ${result.issues.join('; ')}`);
          return result.ok;
        },
        (error: unknown) => {
          setSaved(
            `Could not save ${key}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        },
      ),
  });
  const { after, rest } = placeRows(items ?? [], changes, proposals);
  const asks = askedFields(items ?? []);

  const holdOf = (text: string) =>
    holdMessage(
      text,
      patterns,
      asks,
      undefined,
      (id) => instances.find((entry) => entry.id === id)?.name,
    );

  // Typed answers on a card go through the same check as a typed message (questions spec 10).
  const questionHold: QuestionHold<Held> = {
    check: (replies) => {
      setSaved(undefined);
      for (const reply of replies.values()) {
        const found = holdOf(reply.text);
        if (found) return found;
      }
      return null;
    },
    render: (current, controls) => (
      <HeldLine
        held={current}
        onPut={
          current.field
            ? async (replaces) => {
                const message = await storeHeld(current, replaces);
                controls.replaceText((text) => withoutSecret(current, text));
                controls.dismiss();
                setSaved(message);
              }
            : undefined
        }
        onSend={controls.sendAnyway}
        onDismiss={controls.dismiss}
      />
    ),
  };

  const extraAfter = (item: ThreadItem): ReactNode => {
    const ask = askOf(item);
    const questions = askedQuestionsOf(item);
    const placed = after.get(item.id);
    if (!ask && !placed && !questions) return null;
    return (
      <div className="flex flex-col gap-2">
        {questions && (
          <AssistantQuestions
            item={item}
            request={questions}
            state={askState(item, items ?? [], turns ?? [])}
            check={questionHold.check}
            renderHold={questionHold.render}
          />
        )}
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

  // Puts the held value in its field and says so; the caller takes it out of what was typed.
  const storeHeld = async (current: Held, replaces: boolean): Promise<string> => {
    const { field } = current;
    if (!field) throw new Error('No field for this value');
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
    return `Saved in ${field.label}${replaces ? ' in place of the value it held' : ''}. It was taken out of your message.`;
  };

  const putInField = (current: Held) => async (replaces: boolean) => {
    if (!current.field) return;
    const message = await storeHeld(current, replaces);
    setHeld(undefined);
    setSaved(message);
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
            const found = holdOf(text);
            setHeld(found ?? undefined);
            return found === null;
          },
          questionHold,
          notice,
          modelBar: modelBar ?? null,
        }}
      />
    </div>
  );
}

// The Assistant view's composer bar (agent workbench spec 10): the provider instance, model and
// effort the assistant's settings name, else what its thread runs on now. A pick writes the
// setting, as Settings → Assistant does; a new instance starts from its own defaults. The mode
// is the assistant's fixed one and is not a choice.
export function assistantBar({
  thread,
  instances,
  stored,
  write,
}: {
  thread: Thread;
  instances: readonly ProviderInstance[];
  stored: {
    readonly instanceId: string;
    readonly model: string;
    readonly effort: string;
    readonly allowCodex: boolean;
  };
  // Whether the setting was saved; the caller tells the user when it was not.
  write(
    key: 'assistant.providerInstanceId' | 'assistant.model' | 'assistant.effort',
    value: string,
  ): Promise<boolean>;
}): Omit<ModelBarProps, 'ref' | 'returnFocus'> | undefined {
  const allowed = instances.filter((entry) => entry.kind === 'claude' || stored.allowCodex);
  const instance =
    allowed.find((entry) => entry.id === stored.instanceId) ??
    instances.find((entry) => entry.id === thread.providerInstanceId);
  if (!instance) return undefined;
  const onThread = instance.id === thread.providerInstanceId;
  return {
    providerInstanceId: instance.id,
    kind: instance.kind,
    value: {
      model: stored.model || (onThread ? thread.model : '') || instance.defaultModel || '',
      effort: stored.effort || (onThread ? thread.effort : '') || instance.defaultEffort || '',
      permissionMode: providerChatOptions[instance.kind].assistantPermissionMode,
    },
    defaults: { model: instance.defaultModel, effort: instance.defaultEffort },
    modeLocked: 'Read only',
    instances: {
      choices: allowed.map((entry) => ({ id: entry.id, label: providerLabel(entry, instances) })),
      value: instance.id,
      onChange: (id) => {
        if (id === instance.id) return;
        // The instance last, so the assistant is never opened on the new instance with the old
        // instance's model.
        void (async () => {
          if (!(await write('assistant.model', ''))) return;
          if (!(await write('assistant.effort', ''))) return;
          await write('assistant.providerInstanceId', id);
        })();
      },
    },
    onChange: (changes) => {
      if (changes.model !== undefined) void write('assistant.model', changes.model);
      if (changes.effort !== undefined) void write('assistant.effort', changes.effort);
    },
  };
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
