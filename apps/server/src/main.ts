import { createClaudeAdapter } from '@wow/provider-claude';
import { startOutlookService } from './outlook/service.js';
import { startServer } from './server.js';

// Command-line entry: `pnpm --filter @wow/server start`, and the entry of the desktop app's server
// bundle.
const server = await startServer({
  hooks: {
    providers: { claude: createClaudeAdapter },
    outlook: (mode, context) => startOutlookService(mode, context),
  },
});

let stopping = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  server.logger.info('stopping', { signal });
  server.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      server.logger.error('stop failed', error);
      process.exit(1);
    },
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
