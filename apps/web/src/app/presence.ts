import { dispatch } from '@wow/client-runtime';
import { useEffect } from 'react';
import { useRuntime } from './runtime';

// Tells the server when the window is shown again after it was hidden (chief of staff spec 20),
// with since when; whether that was long enough for a briefing is the server's to decide.
export function usePresence(): void {
  const { connection } = useRuntime();
  useEffect(() => {
    if (!connection || typeof document === 'undefined') return;
    let hiddenAt: string | undefined = document.hidden ? new Date().toISOString() : undefined;
    const onChange = () => {
      if (document.hidden) {
        hiddenAt = new Date().toISOString();
        return;
      }
      if (hiddenAt === undefined) return;
      const awayFrom = hiddenAt;
      hiddenAt = undefined;
      dispatch(connection, { type: 'presence.back', awayFrom }).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [connection]);
}
