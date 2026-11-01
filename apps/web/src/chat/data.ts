import {
  ProviderModel,
  subscriptionTopics,
  type Command,
  type DispatchResult,
  type SubscriptionTopic,
  type TopicRow,
} from '@wow/contracts';
import {
  createSubscriptionStore,
  dispatch,
  type Connection,
  type SubscriptionState,
  type SubscriptionStore,
} from '@wow/client-runtime';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { createStore, useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';

const empty = createStore<SubscriptionState<never[]>>(() => ({
  data: undefined,
  error: undefined,
}));

// The current rows of a server topic, or undefined until the first snapshot (or without a server).
// Components that ask for the same topic share one server subscription.
export function useTopic<T extends SubscriptionTopic>(
  topic: T,
  threadId?: string,
): readonly TopicRow<T>[] | undefined {
  const { connection } = useRuntime();
  const [store, setStore] = useState<SubscriptionStore<TopicRow<T>[]>>();
  useEffect(() => {
    if (!connection) return undefined;
    if (subscriptionTopics[topic].threadScoped && threadId === undefined) return undefined;
    // The row schema of T parses to TopicRow<T>; TypeScript cannot follow the lookup generically.
    const schema = z.array(subscriptionTopics[topic].row) as unknown as z.ZodType<TopicRow<T>[]>;
    const created = createSubscriptionStore(
      connection,
      topic,
      schema,
      threadId === undefined ? null : { threadId },
    );
    setStore(created);
    return () => {
      created.dispose();
      setStore(undefined);
    };
  }, [connection, topic, threadId]);
  return useStore(store ?? empty).data;
}

export function useDispatch(): (command: Command) => Promise<DispatchResult> {
  const { connection } = useRuntime();
  return useCallback(
    (command: Command) =>
      connection
        ? dispatch(connection, command)
        : Promise.reject(new Error('Not connected to the wow server')),
    [connection],
  );
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Models of one provider instance, asked once per connection; the provider reports them.
const modelRequests = new WeakMap<Connection, Map<string, Promise<ProviderModel[]>>>();

function requestModels(connection: Connection, providerInstanceId: string) {
  let perConnection = modelRequests.get(connection);
  if (!perConnection) {
    perConnection = new Map();
    modelRequests.set(connection, perConnection);
  }
  let request = perConnection.get(providerInstanceId);
  if (!request) {
    request = connection
      .request('provider.listModels', { providerInstanceId })
      .then((result) => ProviderModel.array().parse(result));
    // A failed request is asked again next time instead of being remembered.
    request.catch(() => perConnection.delete(providerInstanceId));
    perConnection.set(providerInstanceId, request);
  }
  return request;
}

export interface ModelsState {
  readonly models: readonly ProviderModel[];
  readonly error: string | undefined;
}

export function useModels(providerInstanceId: string | undefined): ModelsState {
  const { connection } = useRuntime();
  const [state, setState] = useState<ModelsState & { readonly for: string | undefined }>({
    for: undefined,
    models: [],
    error: undefined,
  });
  useEffect(() => {
    if (!connection || providerInstanceId === undefined) return undefined;
    let current = true;
    requestModels(connection, providerInstanceId).then(
      (models) => current && setState({ for: providerInstanceId, models, error: undefined }),
      (error: unknown) =>
        current && setState({ for: providerInstanceId, models: [], error: errorMessage(error) }),
    );
    return () => {
      current = false;
    };
  }, [connection, providerInstanceId]);
  return state.for === providerInstanceId ? state : { models: [], error: undefined };
}
