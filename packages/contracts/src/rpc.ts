import { z } from 'zod';

// Envelope for the local WebSocket. Method names and their params/result schemas are added per
// feature; the envelope only fixes the shape every message has.

export const RpcId = z.string().min(1);
export type RpcId = z.infer<typeof RpcId>;

export const RpcRequest = z.object({
  id: RpcId,
  method: z.string().min(1),
  params: z.unknown(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcError = z.object({
  code: z.string().min(1),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export const RpcSuccess = z.object({ id: RpcId, result: z.unknown() }).strict();
export type RpcSuccess = z.infer<typeof RpcSuccess>;

export const RpcFailure = z.object({ id: RpcId, error: RpcError }).strict();
export type RpcFailure = z.infer<typeof RpcFailure>;

export const RpcResponse = z.union([RpcSuccess, RpcFailure]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export const SubscriptionPush = z.object({
  subscription: z.string().min(1),
  data: z.unknown(),
});
export type SubscriptionPush = z.infer<typeof SubscriptionPush>;

// Anything the server sends: a response to a request, or a push for a subscription.
export const ServerMessage = z.union([RpcSuccess, RpcFailure, SubscriptionPush]);
export type ServerMessage = z.infer<typeof ServerMessage>;
