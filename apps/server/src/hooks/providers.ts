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

const echo: MockScript = (command) => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  return [
    { type: 'session', threadId, providerSessionId: `mock-${threadId}` },
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

export class MockProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  readonly requiresModel: boolean;
  readonly sent: ProviderCommand[] = [];
  readonly #script: MockScript;
  readonly #testResult: () => ProviderTestResult;
  readonly #models: () => readonly ProviderModel[];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();

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
  }

  send(command: ProviderCommand): Promise<unknown> {
    this.sent.push(command);
    const events = this.#script(command);
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
    for (const event of events) for (const listener of this.#listeners) listener(event);
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
