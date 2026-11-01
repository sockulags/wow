import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
  ProviderKind,
} from '@wow/contracts';

export type ProviderAdapterFactory = (
  instance: ProviderInstance,
  context: ProviderAdapterContext,
) => ProviderAdapter;

// Maps a provider command to the events the mock answers with. The default echoes the prompt.
export type MockScript = (command: ProviderCommand) => ProviderEvent[];

const echo: MockScript = (command) => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  return [
    { type: 'session', threadId, providerSessionId: `mock-${threadId}` },
    { type: 'textDelta', threadId, itemId: `${threadId}-text`, delta: command.prompt },
    { type: 'usage', threadId, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    { type: 'turnCompleted', threadId },
  ];
};

// Stands in for a real provider in tests and with WOW_PROVIDERS=mock. Events are emitted after
// send() resolves, the way a real provider streams after accepting a command.
export class MockProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  readonly sent: ProviderCommand[] = [];
  readonly #script: MockScript;
  readonly #listeners = new Set<(event: ProviderEvent) => void>();

  constructor(kind: ProviderKind, script: MockScript = echo) {
    this.kind = kind;
    this.#script = script;
  }

  send(command: ProviderCommand): Promise<unknown> {
    this.sent.push(command);
    const events = this.#script(command);
    setImmediate(() => {
      for (const event of events) for (const listener of this.#listeners) listener(event);
    });
    if (command.type === 'listModels') {
      return Promise.resolve([
        { id: 'mock-model', label: 'Mock model', description: '', efforts: ['low', 'high'] },
      ]);
    }
    if (command.type === 'test') {
      return Promise.resolve({ ok: true, account: 'mock', version: 'mock', message: null });
    }
    return Promise.resolve({ ok: true });
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
