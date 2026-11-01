# @wow/client-runtime

Connection, subscriptions and stores shared by the web app and a later mobile client.

- `createConnection` opens the WebSocket (from `endpointFromServerInfo` for the desktop's
  `server.json` or `endpointFromUrl` in development), queues requests until it is open,
  reconnects with backoff and subscribes again after a reconnect.
- `createSubscriptionStore` mirrors one server subscription in a Zustand store.
- `createSettingsStore` reads and writes settings through a `SettingsSource`, validating against
  `settingsRegistry`; `createMemorySettingsSource` stands in until the settings RPC exists.
