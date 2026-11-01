import type { z } from 'zod';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Connection } from './connection.js';

export interface SubscriptionState<T> {
  // Undefined until the server pushed the first snapshot.
  readonly data: T | undefined;
  // Set when the server pushed something the schema rejects; the last good data is kept.
  readonly error: string | undefined;
}

export interface SubscriptionStore<T> extends StoreApi<SubscriptionState<T>> {
  dispose(): void;
}

// A Zustand store that mirrors one server subscription. The UI only renders what the server
// pushed; it never fills in data of its own.
export function createSubscriptionStore<S extends z.ZodType>(
  connection: Connection,
  name: string,
  schema: S,
  params: unknown = null,
): SubscriptionStore<z.output<S>> {
  const store = createStore<SubscriptionState<z.output<S>>>(() => ({
    data: undefined,
    error: undefined,
  }));
  const stop = connection.subscribe(name, params, (raw) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) store.setState({ data: parsed.data, error: undefined });
    else store.setState({ error: parsed.error.message });
  });
  return { ...store, dispose: stop };
}
