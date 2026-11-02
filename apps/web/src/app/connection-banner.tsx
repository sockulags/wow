import { UnplugIcon } from 'lucide-react';
import { Banner } from '@/components/banner';
import { Button } from '@/components/ui/button';
import { useConnectionState, useRuntime } from './runtime';

// Nothing while connected (audit E-16); a banner with "Retry now" while the server cannot be
// reached (A-08). Views keep their last rows, dimmed, underneath.
export function ConnectionBanner() {
  const { connection } = useRuntime();
  const { status, configured } = useConnectionState();
  if (!configured) {
    return (
      <Banner tone="info" icon={UnplugIcon} testId="connection-banner">
        No wow server. Settings are kept in memory until you start one.
      </Banner>
    );
  }
  if (status !== 'reconnecting' && status !== 'closed') return null;
  return (
    <Banner
      tone="warning"
      icon={UnplugIcon}
      testId="connection-banner"
      actions={
        status === 'reconnecting' && (
          <Button size="xs" variant="outline" onClick={() => connection?.retry()}>
            Retry now
          </Button>
        )
      }
    >
      {status === 'reconnecting'
        ? 'Not connected to the wow server. Retrying…'
        : 'Disconnected from the wow server. Restart wow to connect again.'}
    </Banner>
  );
}
