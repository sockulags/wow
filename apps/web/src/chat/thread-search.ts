import { rpcMethods } from '@wow/contracts';
import { useEffect, useState } from 'react';
import { useConnectionState, useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from './data';
import { paletteThreadHits } from './thread-commands';

export interface ThreadSearch {
  // The threads the server found for the text as typed, or undefined while none arrived for it.
  readonly hits: ReadonlySet<string> | undefined;
  // Why the last search failed, if it did.
  readonly error: string | undefined;
}

// Asks the server's `threads.search` for the text (agent workbench spec 66, 69), and again when a
// thread changes or the connection comes back, since a new message may now hold the word.
export function useThreadSearch(text: string): ThreadSearch {
  const { connection } = useRuntime();
  const { status } = useConnectionState();
  const threads = useTopic('threads');
  const [answer, setAnswer] = useState<{ query: string; ids: ReadonlySet<string> }>();
  const [error, setError] = useState<{ query: string; message: string }>();
  const query = text.trim();
  const revision = threads
    ? `${threads.length}:${threads.reduce((latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest), '')}`
    : '';
  const open = status === 'open';
  useEffect(() => {
    if (!connection || !open || query === '') return undefined;
    let current = true;
    connection
      .request('threads.search', { query })
      .then((result) => rpcMethods['threads.search'].result.parse(result))
      .then(
        ({ threadIds }) => {
          if (!current) return;
          setAnswer({ query, ids: new Set(threadIds) });
          setError(undefined);
        },
        (failure: unknown) => {
          if (current) setError({ query, message: errorMessage(failure) });
        },
      );
    return () => {
      current = false;
    };
  }, [connection, open, query, revision]);
  return {
    hits: answer?.query === query ? answer.ids : undefined,
    error: error?.query === query ? error.message : undefined,
  };
}

// The palette's text, searched the same way; its thread commands read the hits from the store.
export function usePaletteThreadSearch(text: string): void {
  const { hits } = useThreadSearch(text);
  const query = text.trim();
  useEffect(() => {
    // Every command is rebuilt when the store changes, so an empty answer is written only once.
    if (hits === undefined || hits.size === 0) {
      if (paletteThreadHits.getState().query !== '') {
        paletteThreadHits.setState({ query: '', ids: new Set() });
      }
      return;
    }
    paletteThreadHits.setState({ query, ids: hits });
  }, [hits, query]);
}
