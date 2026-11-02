import type { SubscriptionTopic, TopicRow } from '@wow/contracts';
import { useTopic } from '@/chat/data';
import { useConnectionState } from './runtime';

// What a view may say about a topic. Views never show an empty state before the first snapshot
// (design rules), so they need to tell "nothing there" from "not arrived yet".
// - loading: connected or connecting, no snapshot yet
// - ready: the server's current rows
// - disconnected: the connection dropped; rows, if any, are the last ones received
// - offline: the app runs without a server (development, tests)
export type TopicStatus = 'loading' | 'ready' | 'disconnected' | 'offline';

export interface TopicState<T extends SubscriptionTopic> {
  readonly rows: readonly TopicRow<T>[] | undefined;
  readonly status: TopicStatus;
}

export function topicStatus(
  hasRows: boolean,
  connection: { readonly status: string; readonly configured: boolean },
): TopicStatus {
  if (!connection.configured) return 'offline';
  if (connection.status === 'reconnecting' || connection.status === 'closed') return 'disconnected';
  return hasRows ? 'ready' : 'loading';
}

export function useTopicState<T extends SubscriptionTopic>(
  topic: T,
  threadId?: string,
): TopicState<T> {
  const rows = useTopic(topic, threadId);
  const connection = useConnectionState();
  return { rows, status: topicStatus(rows !== undefined, connection) };
}
