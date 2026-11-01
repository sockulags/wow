import {
  RpcRequest,
  isRpcMethod,
  rpcMethods,
  type RpcErrorCode,
  type RpcMethod,
  type RpcParams,
  type RpcResponse,
  type RpcResult,
} from '@wow/contracts';
import { CommandRejected } from '../core/orchestrator.js';

export class RpcFault extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcFault';
  }
}

export type Handlers<C> = {
  [M in RpcMethod]: (params: RpcParams<M>, connection: C) => RpcResult<M> | Promise<RpcResult<M>>;
};

// Used as the response id when a message is too broken to carry its own.
export const unknownRequestId = '?';

const failure = (id: string, code: RpcErrorCode, message: string, data?: unknown): RpcResponse => ({
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

// Validates one raw message against the contracts, runs its handler and validates the result.
// Transports stay thin: they only move strings.
export async function route<C>(
  raw: string,
  handlers: Handlers<C>,
  connection: C,
  onInternalError: (error: unknown, method: string) => void,
): Promise<RpcResponse> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return failure(unknownRequestId, 'parse_error', 'Message is not JSON');
  }
  const request = RpcRequest.safeParse(message);
  if (!request.success) {
    const id =
      typeof message === 'object' && message !== null && 'id' in message
        ? String((message as { id: unknown }).id) || unknownRequestId
        : unknownRequestId;
    return failure(id, 'invalid_request', 'Expected {id, method, params}', request.error.issues);
  }
  const { id, method, params } = request.data;
  if (!isRpcMethod(method)) return failure(id, 'unknown_method', `Unknown method ${method}`);
  const contract = rpcMethods[method];
  const parsed = contract.params.safeParse(params ?? {});
  if (!parsed.success) {
    return failure(id, 'invalid_params', `Invalid params for ${method}`, parsed.error.issues);
  }
  try {
    const handler = handlers[method] as (params: unknown, connection: C) => unknown;
    const result = contract.result.parse(await handler(parsed.data, connection));
    return { id, result };
  } catch (error) {
    if (error instanceof CommandRejected || error instanceof RpcFault) {
      return failure(id, error.code, error.message, error.data);
    }
    onInternalError(error, method);
    return failure(id, 'internal', error instanceof Error ? error.message : String(error));
  }
}
