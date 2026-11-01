# @wow/outlook-bridge

Read-only access to the Outlook desktop client: `bridge.ps1` (PowerShell COM bridge, JSON lines),
`PowershellOutlookSource` (supervises the bridge: request ids, timeouts, restart),
`MockOutlookSource` with invented fixtures in `fixtures/`, and `OutlookSync`, which polls a source
and hands snapshots or failures to the server. See "Outlook bridge" in `docs/architecture.md`.

`pnpm --filter @wow/outlook-bridge test` runs the mock, parser and supervisor tests everywhere and
the real bridge against a machine without Outlook on Windows.
