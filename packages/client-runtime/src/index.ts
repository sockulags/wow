import { RpcRequest } from '@wow/contracts';

// Placeholder until U3 adds the connection. Outgoing requests are validated like the server does.
export function encodeRequest(request: RpcRequest): string {
  return JSON.stringify(RpcRequest.parse(request));
}
