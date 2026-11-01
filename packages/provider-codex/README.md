# @wow/provider-codex

`codex app-server` adapter. Implements `ProviderAdapter` from `@wow/contracts` over the app-server's
newline-delimited JSON-RPC on stdio and maps it to `ProviderEvent` / `ProviderCommand`.

```ts
import { codexAdapterFactory } from '@wow/provider-codex';

startServer({
  hooks: {
    providers: {
      // requestTimeoutMs is read before every request; resolveEnv turns secret refs into values.
      codex: codexAdapterFactory({ requestTimeoutMs, resolveEnv }),
    },
  },
});
```

## Protocol version

`src/protocol/generated` is generated from codex **0.166.0** and is not edited by hand. To move to
another codex release:

```sh
pnpm --filter @wow/provider-codex generate:protocol /path/to/codex
```

The script runs `codex app-server generate-ts`, keeps the methods listed in `METHODS` and the types
they reach, and writes typed method maps (`ClientRequests`, `ServerNotifications`,
`ServerRequests`) plus `codexProtocolVersion`. A method that release no longer defines fails the
script, and the adapter stops compiling where a type changed. Re-record the fixtures afterwards.

initialize reports no protocol version, only a user agent (`wow/0.166.0 (...)`); the adapter reads
the version from it. The `test` command fails with a clear message when it differs from
`codexProtocolVersion`.

## Mapping

| wow                                | codex                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| process                            | `<binaryPath> app-server <launchArgs>`, `CODEX_HOME` = instance config dir      |
| `startTurn` (new thread)           | `thread/start` then `turn/start`                                                |
| `startTurn` (`resumeId` / restart) | `thread/resume` then `turn/start`                                               |
| `interrupt`                        | `turn/interrupt` with the running turn id                                       |
| `textDelta`                        | `item/agentMessage/delta` (or the whole `agentMessage` if nothing streamed)     |
| `reasoningDelta`                   | `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`                   |
| `toolCallStarted`                  | `item/started` for command, file change, MCP, dynamic tool, web search, image   |
| `toolCallOutput`                   | `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, or result   |
| `toolCallCompleted`                | `item/completed` (failed, declined or non-zero exit is `error`)                 |
| `approvalRequested`                | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,     |
|                                    | `item/permissions/requestApproval`                                              |
| `answerApproval`                   | `accept` / `acceptForSession` / `decline`; permissions granted per turn/session |
| `questionAsked`                    | one per question of `item/tool/requestUserInput`                                |
| `answerQuestion`                   | answers are sent together once every question of the request has one            |
| `taskListUpdated`                  | `turn/plan/updated`                                                             |
| `contextUsage`                     | `thread/tokenUsage/updated` (last request against the model context window)     |
| `usage`                            | thread token totals at `turn/completed` minus the totals at `turn/started`      |
| `turnCompleted` / `Interrupted`    | `turn/completed` with status `completed` / `interrupted`                        |
| `turnFailed`                       | `turn/completed` failed, an `error` without retry, a timeout, or process exit   |
| `listModels`                       | `model/list`, all pages, hidden models left out                                 |
| `test`                             | initialize, version check, `account/read`, `model/list`                         |

Permission modes are `read-only`, `auto` (default), `untrusted` and `full-access`
(`codexPermissionModes`); each is an approval policy plus a sandbox. Model, effort and permission
mode travel with every `turn/start`, so `setModel` and `setPermissionMode` apply to the next turn.
Server requests the adapter does not handle are answered with a JSON-RPC error so codex never
waits on them.

`startTurn` failures before the turn begins reject the promise and also emit `turnFailed`, so a
thread never stays working. If the app-server exits, running turns fail and the next command
starts a new process; threads are resumed with `thread/resume`.

## Tests

- `pnpm --filter @wow/provider-codex test` replays JSON-RPC fixtures through a fake stdio process
  (`ReplayCodexProcess`). `fixtures/turn-interrupt.jsonl` and `fixtures/test-not-logged-in.jsonl`
  are recorded from codex 0.166.0 with invented paths and ids; `fixtures/turn-tools.jsonl` is an
  invented turn written against the generated types.
- `WOW_REAL_PROVIDERS=1` runs `src/real.smoke.test.ts` against the installed codex (`CODEX_BIN`,
  `WOW_CODEX_HOME`); the turn needs a logged-in codex home.
