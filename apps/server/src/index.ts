import type { RpcRequest } from '@wow/contracts';

// Placeholder until U2 implements the server. It proves the server compiles against contracts.
export function describeRequest(request: RpcRequest): string {
  return `${request.method}#${request.id}`;
}
