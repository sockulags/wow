import { z } from 'zod';

// Shape of `~/.wow/server.json`, written by the server at startup and read by the desktop app to
// connect the web client. Extra fields are allowed so the server can add more without breaking
// older clients.
export const ServerInfo = z.looseObject({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});
export type ServerInfo = z.infer<typeof ServerInfo>;
