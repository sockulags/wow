import {
  createConnection,
  createMemorySettingsSource,
  createSettingsStore,
  endpointFromServerInfo,
  endpointFromUrl,
  type Connection,
} from '@wow/client-runtime';
import { createDraftStore } from '@/chat/draft';
import { createServerSettingsSource } from '@/settings/server-source';
import { createLayoutStore, type Runtime } from './runtime';
import { createUpdatesClient } from './updates';

declare global {
  interface Window {
    // Set by the desktop preload (U14) with the contents of `~/.wow/server.json`.
    wowServerInfo?: unknown;
  }
}

// Where the server is: the desktop app injects server.json; in development `?server=<url>&token=`
// or VITE_WOW_SERVER_URL point at a running server. Without either the shell runs offline.
export function resolveEndpoint(location: Location, injected: unknown): string | undefined {
  if (injected !== undefined) return endpointFromServerInfo(injected);
  const params = new URLSearchParams(location.search);
  const url = params.get('server') ?? import.meta.env['VITE_WOW_SERVER_URL'];
  if (typeof url !== 'string' || url === '') return undefined;
  return endpointFromUrl(url, params.get('token') ?? undefined);
}

export function createRuntime(): Runtime {
  const endpoint = resolveEndpoint(window.location, window.wowServerInfo);
  const connection: Connection | undefined = endpoint
    ? createConnection({ url: endpoint })
    : undefined;
  const updatesBridge = window.wowDesktop?.updates;
  return {
    connection,
    updates: updatesBridge ? createUpdatesClient(updatesBridge) : undefined,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    // Without a server (development, the shell tests) settings live in memory.
    settings: createSettingsStore(
      connection ? createServerSettingsSource(connection) : createMemorySettingsSource(),
    ),
  };
}
