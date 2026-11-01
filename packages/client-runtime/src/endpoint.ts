import { ServerInfo } from '@wow/contracts';

// The desktop app reads `~/.wow/server.json` and hands its contents to the web client; in
// development the client gets a URL such as `ws://127.0.0.1:4317/?token=...`. Both end as one
// WebSocket URL.

export function endpointFromServerInfo(json: unknown): string {
  const info = ServerInfo.parse(typeof json === 'string' ? JSON.parse(json) : json);
  return `ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`;
}

export function endpointFromUrl(raw: string, token?: string): string {
  const url = new URL(raw);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported server URL protocol: ${url.protocol}`);
  }
  if (token !== undefined) url.searchParams.set('token', token);
  return url.toString();
}
