import { DispatchResult, type Command } from '@wow/contracts';
import type { Connection } from './connection.js';

// Sends one command. The id makes a retry after a dropped connection safe: the server answers a
// repeated id with the first receipt instead of applying the command twice.
export async function dispatch(
  connection: Connection,
  command: Command,
  commandId: string = globalThis.crypto.randomUUID(),
): Promise<DispatchResult> {
  return DispatchResult.parse(await connection.request('dispatch', { commandId, command }));
}
