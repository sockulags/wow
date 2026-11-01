import { startServer } from './server.js';

// Command-line entry: `pnpm --filter @wow/server start`. The desktop app calls startServer itself.
const server = await startServer();

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
