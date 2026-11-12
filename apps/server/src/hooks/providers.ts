import {
  providerChatOptions,
  type ProviderAdapter,
  type ProviderAdapterContext,
  type ProviderCommand,
  type ProviderEvent,
  type ProviderInstance,
  type ProviderKind,
  type ProviderModel,
  type ProviderSlashCommand,
  type ProviderTestResult,
} from '@wow/contracts';

export type ProviderAdapterFactory = (
  instance: ProviderInstance,
  context: ProviderAdapterContext,
) => ProviderAdapter;

// Maps a provider command to the events the mock answers with. The default echoes the prompt.
export type MockScript = (command: ProviderCommand) => ProviderEvent[];

// The prompt, and how many images came with it (agent workbench spec 53), so a test sees that
// they reached the adapter.
export const imagesReceived = (count: number): string =>
  `Received ${count} image${count === 1 ? '' : 's'}.`;

const echoed = (command: Extract<ProviderCommand, { type: 'startTurn' }>): string => {
  const count = command.images?.length ?? 0;
  return count === 0 ? command.prompt : `${command.prompt}\n\n${imagesReceived(count)}`;
};

// A compaction as Claude Code reports one after `/compact` (agent workbench spec 46).
export const mockCompaction = (threadId: string): ProviderEvent => ({
  type: 'compacted',
  threadId,
  trigger: 'manual',
  preTokens: 152_000,
  postTokens: 18_000,
});

// A turn of two tool calls, a command and a read (agent workbench spec 45).
export const mockTwoTools = (threadId: string, cwd: string): ProviderEvent[] => [
  {
    type: 'toolCallStarted',
    threadId,
    itemId: `${threadId}-tool-1`,
    name: 'Bash',
    input: { command: 'pnpm lint' },
    kind: 'command',
    command: 'pnpm lint',
  },
  { type: 'toolCallCompleted', threadId, itemId: `${threadId}-tool-1`, status: 'ok' },
  {
    type: 'toolCallStarted',
    threadId,
    itemId: `${threadId}-tool-2`,
    name: 'Bash',
    input: { command: 'pnpm test' },
    kind: 'command',
    command: 'pnpm test',
    cwd,
  },
];

// A subagent as Claude Code's adapter reports one (agent workbench spec 44): the Agent call,
// three calls and a note of the subagent under it while it runs, then its count, time and
// answer. `running` leaves it running; `done` finishes it and the turn's own answer follows.
export const mockSubagent = (
  threadId: string,
  cwd: string,
): { running: ProviderEvent[]; done: ProviderEvent[] } => {
  const agent = `${threadId}-agent`;
  const nested = (id: string, event: Partial<ProviderEvent>): ProviderEvent =>
    ({
      type: 'toolCallStarted',
      threadId,
      itemId: `${agent}-${id}`,
      parentItemId: agent,
      ...event,
    }) as ProviderEvent;
  const finished = (id: string): ProviderEvent => ({
    type: 'toolCallCompleted',
    threadId,
    itemId: `${agent}-${id}`,
    status: 'ok',
  });
  return {
    running: [
      {
        type: 'toolCallStarted',
        threadId,
        itemId: agent,
        name: 'Agent',
        input: { description: 'explore the auth code', subagent_type: 'Explore' },
        kind: 'subagent',
        description: 'explore the auth code',
        prompt: 'Find where the kettle checks who may start it, and say which file holds it.',
        agentType: 'Explore',
      },
      nested('grep', {
        name: 'Grep',
        input: { pattern: 'mayStart', path: 'src' },
        kind: 'search',
        pattern: 'mayStart',
        path: 'src',
      }),
      { type: 'toolCallOutput', threadId, itemId: `${agent}-grep`, output: 'src/auth.ts\n' },
      finished('grep'),
      nested('read', {
        name: 'Read',
        input: { file_path: `${cwd}/src/auth.ts` },
        kind: 'read',
        path: `${cwd}/src/auth.ts`,
      }),
      {
        type: 'toolCallOutput',
        threadId,
        itemId: `${agent}-read`,
        output: 'export const mayStart\n',
      },
      finished('read'),
      {
        type: 'textDelta',
        threadId,
        itemId: `${agent}-note`,
        delta: 'The check is in src/auth.ts; running its test.',
        parentItemId: agent,
      },
      nested('test', {
        name: 'Bash',
        input: { command: 'pnpm test auth' },
        kind: 'command',
        command: 'pnpm test auth',
      }),
    ],
    done: [
      finished('test'),
      {
        type: 'toolCallCompleted',
        threadId,
        itemId: agent,
        status: 'ok',
        toolCount: 3,
        // 1:32, as the spec's example reads.
        durationMs: (60 + 32) * 1000,
        answer: 'The kettle checks `mayStart` in `src/auth.ts`; its test passes.',
      },
      {
        type: 'textDelta',
        threadId,
        itemId: `${threadId}-after-agent`,
        delta: 'The subagent found the check in src/auth.ts.',
      },
    ],
  };
};

const echo: MockScript = (command) => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  const subagent = /with an agent/i.test(command.prompt)
    ? mockSubagent(threadId, command.cwd)
    : undefined;
  const extra: ProviderEvent[] = subagent
    ? [...subagent.running, ...subagent.done]
    : /compact/i.test(command.prompt)
      ? [mockCompaction(threadId)]
      : /two tools/i.test(command.prompt)
        ? [
            ...mockTwoTools(threadId, command.cwd),
            { type: 'toolCallCompleted', threadId, itemId: `${threadId}-tool-2`, status: 'ok' },
          ]
        : [];
  return [
    { type: 'session', threadId, providerSessionId: `mock-${threadId}` },
    ...extra,
    { type: 'textDelta', threadId, itemId: `${threadId}-text`, delta: echoed(command) },
    { type: 'usage', threadId, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    { type: 'turnCompleted', threadId },
  ];
};

// Stands in for a real provider in tests and with WOW_PROVIDERS=mock. Events are emitted after
// send() resolves, the way a real provider streams after accepting a command.
export const mockModels: readonly ProviderModel[] = [
  { id: 'mock-model', label: 'Mock model', description: '', efforts: ['low', 'high'] },
  {
    id: 'mock-model-large',
    label: 'Mock model, large',
    description: 'Invented: the larger mock model',
    efforts: ['low', 'medium', 'high'],
  },
];

// Invented models in the shape Codex reports them (agent workbench spec 7, 8): descriptions,
// the provider's default, each model's default effort and which models take images. The Codex
// adapter leaves hidden models out, so none is here. The labels start like the Claude mock's,
// so a case that only checks "Mock model" passes on either instance.
export const mockCodexModels: readonly ProviderModel[] = [
  {
    id: 'mock-codex',
    label: 'Mock model for Codex',
    description: 'Invented: the everyday mock model',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    isDefault: true,
    imageInput: true,
  },
  {
    id: 'mock-codex-mini',
    label: 'Mock model for Codex, mini',
    description: 'Invented: small and quick',
    efforts: ['low', 'medium'],
    defaultEffort: 'low',
    isDefault: false,
    imageInput: false,
  },
];

// Invented commands in the shape Claude Code lists them (agent workbench spec 60): built-in ones,
// one of them with a name wow uses too, and a project command. Codex reports none.
export const mockClaudeCommands: readonly ProviderSlashCommand[] = [
  { name: 'clear', description: 'Clear the conversation (invented)', argumentHint: '' },
  { name: 'review', description: 'Review the open changes (invented)', argumentHint: '' },
  {
    name: 'release-notes',
    description: 'Write release notes for a version (invented)',
    argumentHint: '<version>',
  },
];

// What the mock says first in a turn that went back in the conversation (Edit, Fork): the
// messages it still remembers, so a test sees what was kept (agent workbench spec 62, 71).
export const keptMessagesText = (prompts: readonly string[]): string =>
  prompts.length === 0
    ? 'Starting a new conversation.'
    : `Picked up after: ${prompts.map((prompt) => `"${prompt}"`).join(', ')}.`;

const endsTurn = (event: ProviderEvent) =>
  event.type === 'turnCompleted' || event.type === 'turnFailed' || event.type === 'turnInterrupted';

// The mock's own record of a Claude Code conversation: each session's turns with the point it
// gave after each, so a turn that goes back keeps what Claude Code would keep.
class MockConversations {
  readonly #sessions = new Map<string, { prompt: string; point: string }[]>();
  readonly #sessionOf = new Map<string, string>();
  readonly #prompts = new Map<string, string>();
  #count = 0;

  startTurn(command: Extract<ProviderCommand, { type: 'startTurn' }>): ProviderEvent[] {
    const { threadId, goBack } = command;
    this.#prompts.set(threadId, command.prompt);
    if (!goBack) {
      if (!this.#sessionOf.has(threadId) && command.resumeId)
        this.#sessionOf.set(threadId, command.resumeId);
      return [];
    }
    const before = command.resumeId ? (this.#sessions.get(command.resumeId) ?? []) : [];
    const at = goBack.at === null ? -1 : before.findIndex((entry) => entry.point === goBack.at);
    if (goBack.at !== null && at === -1) {
      return [{ type: 'turnFailed', threadId, error: `No message ${goBack.at} to go back to` }];
    }
    const kept = before.slice(0, at + 1);
    this.#count += 1;
    const session =
      goBack.fork || goBack.at === null || !command.resumeId
        ? `mock-${threadId}-${this.#count}`
        : command.resumeId;
    this.#sessions.set(session, kept);
    this.#sessionOf.set(threadId, session);
    return [
      { type: 'session', threadId, providerSessionId: session },
      {
        type: 'textDelta',
        threadId,
        itemId: `${threadId}-kept-${this.#count}`,
        delta: keptMessagesText(kept.map((entry) => entry.prompt)),
      },
    ];
  }

  // A script's session id stands until the mock went back; a turn's end gets its point.
  passing(event: ProviderEvent): ProviderEvent {
    const { threadId } = event;
    if (event.type === 'session') {
      const known = this.#sessionOf.get(threadId);
      if (known) return { ...event, providerSessionId: known };
      this.#sessionOf.set(threadId, event.providerSessionId);
      return event;
    }
    if (!endsTurn(event)) return event;
    const session = this.#sessionOf.get(threadId);
    if (!session) return event;
    const entries = this.#sessions.get(session) ?? [];
    const point = `${session}:${entries.length + 1}`;
    entries.push({ prompt: this.#prompts.get(threadId) ?? '', point });
    this.#sessions.set(session, entries);
    this.#prompts.delete(threadId);
    return { ...event, resumePoint: point };
  }
}

export class MockProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  readonly requiresModel: boolean;
  readonly sent: ProviderCommand[] = [];
  readonly #script: MockScript;
  readonly #testResult: () => ProviderTestResult;
  readonly #models: () => readonly ProviderModel[];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  // Only a provider that can go back keeps points (agent workbench spec 63).
  readonly #conversations: MockConversations | undefined;

  // testResult answers "test"; the default is a ready instance.
  constructor(
    kind: ProviderKind,
    script: MockScript = echo,
    testResult: () => ProviderTestResult = () => ({
      ok: true,
      account: 'mock',
      version: 'mock',
      message: null,
    }),
    // What listModels answers; throwing stands for a provider that cannot list them.
    models: () => readonly ProviderModel[] = () => mockModels,
  ) {
    this.kind = kind;
    this.requiresModel = providerChatOptions[kind].requiresModel;
    this.#script = script;
    this.#testResult = testResult;
    this.#models = models;
    this.#conversations =
      providerChatOptions[kind].cannotGoBack === null ? new MockConversations() : undefined;
  }

  #passing(events: readonly ProviderEvent[]): ProviderEvent[] {
    const conversations = this.#conversations;
    return conversations ? events.map((event) => conversations.passing(event)) : [...events];
  }

  send(command: ProviderCommand): Promise<unknown> {
    this.sent.push(command);
    const back =
      command.type === 'startTurn' && this.#conversations
        ? this.#conversations.startTurn(command)
        : [];
    // A go-back the mock cannot follow fails the turn, as Claude Code refuses an unknown point;
    // the turn wrote nothing, so it ends without a point.
    const events = back.some((event) => event.type === 'turnFailed')
      ? back
      : this.#passing([...back, ...this.#script(command)]);
    setImmediate(() => {
      for (const event of events) for (const listener of this.#listeners) listener(event);
    });
    if (command.type === 'listModels') {
      try {
        return Promise.resolve(this.#models().map((model) => ({ ...model })));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (command.type === 'test') {
      return Promise.resolve(this.#testResult());
    }
    // Claude Code takes a message into its running turn; Codex does not (spec 51).
    if (command.type === 'handOver') {
      return Promise.resolve({ taken: this.kind === 'claude' });
    }
    if (command.type === 'listCommands') {
      return Promise.resolve(
        this.kind === 'claude' ? mockClaudeCommands.map((entry) => ({ ...entry })) : [],
      );
    }
    return Promise.resolve({ ok: true });
  }

  // Events the provider sends without a command: a turn it starts by itself after its
  // background work ends.
  emit(events: readonly ProviderEvent[]): void {
    for (const event of this.#passing(events))
      for (const listener of this.#listeners) listener(event);
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): Promise<void> {
    this.#listeners.clear();
    return Promise.resolve();
  }
}

export const prefersMockProviders = (env: Record<string, string | undefined>): boolean =>
  env['WOW_PROVIDERS'] === 'mock';

// Where the provider units plug in: each registers a factory for its kind. With
// WOW_PROVIDERS=mock every instance gets the mock adapter instead.
export class ProviderAdapters {
  readonly #factories: Partial<Record<ProviderKind, ProviderAdapterFactory>>;
  readonly #mock: boolean;

  constructor(
    factories: Partial<Record<ProviderKind, ProviderAdapterFactory>>,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.#factories = factories;
    this.#mock = prefersMockProviders(env);
  }

  get mock(): boolean {
    return this.#mock;
  }

  create(instance: ProviderInstance, context: ProviderAdapterContext): ProviderAdapter {
    if (this.#mock) return new MockProviderAdapter(instance.kind);
    const factory = this.#factories[instance.kind];
    if (!factory) throw new Error(`No adapter is installed for ${instance.kind} providers`);
    return factory(instance, context);
  }
}
