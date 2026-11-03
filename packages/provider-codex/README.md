# @wow/provider-codex

`codex app-server` adapter. Implements `ProviderAdapter` from `@wow/contracts` over the app-server's
newline-delimited JSON-RPC on stdio and maps it to `ProviderEvent` / `ProviderCommand`.

```ts
import { codexAdapterFactory } from '@wow/provider-codex';

startServer({
  hooks: {
    providers: {
      // The request timeout (providers.requestTimeoutMs, read before every request) and the
      // resolved instance env come from the server's ProviderAdapterContext.
      codex: codexAdapterFactory(),
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

The script also runs `codex app-server generate-json-schema` and writes
`src/protocol/generated/fingerprint.ts` (`codexProtocolFingerprint`): for every method in
`METHODS`, the params fields the adapter sends and the result or notification fields it reads,
each with its type, whether it is required and nullable, and its enum values or union tags. Which
fields those are is `FIELDS` in the script, with flags: `?` the adapter copes without the field
(or, on a method, without the notification or request), `~` it leaves a sent field out on some
requests, `=null` it may send null, `=a|b` the values it sends. A field `FIELDS` names that the
release lacks fails the script. When the adapter starts to read or send another field, add it to
`FIELDS` and regenerate. The script needs Node 22.18 or newer, which imports
`src/compat/schema.ts` as TypeScript.

### Other codex versions

initialize reports no protocol version, only a user agent (`wow/0.166.0 (...)`); the adapter reads
the version from it. When it differs from `codexProtocolVersion`, `test` runs
`<binaryPath> app-server generate-json-schema --out <temp dir>` (no network, no login; bounded by
`providers.testTimeoutMs`) and compares that schema with the fingerprint (`src/compat`):

- Read fields (codex → wow): missing is fine when `FIELDS` says the adapter copes, when the tested
  release already allowed null, or when the whole union variant on the path is gone (wow never
  sees such an item). A changed type, or a field that was always there becoming optional or
  nullable, is a problem. New enum values, variants, fields and methods are fine: the adapter
  ignores what it does not know, including notifications without params.
- Sent fields (wow → codex): missing is fine only when the adapter copes. A changed type, an enum
  value or variant the adapter sends that codex no longer accepts, null no longer accepted where
  the adapter sends null, a field it leaves out sometimes becoming required, and a new required
  property in an object it builds are problems.
- A string that became an enum (or back) is no type change.
- Methods: a missing request, client notification or handled server request is a problem (renamed
  or removed); a missing notification the adapter copes without is not.

Compatible: `test` passes with the message "codex 0.164.0 differs from the tested 0.166.0;
compatible" (naming what wow does without, if anything). Incompatible: `test` fails with every
problem listed. A codex whose schema generator fails (older releases) fails with that reason. The
answer is kept per binary path and version by the factory (`CompatibilityCache`), for the life of
the server process; a timeout is not kept. Checked by hand against real codex 0.100.0
(incompatible: `model/list` `includeHidden` and `hidden`, `sandboxPolicy<readOnly>.networkAccess`),
0.130.0 and 0.164.0 (compatible) and 0.166.0.

When the version is incompatible or older than tested, `test` also answers `update`
(`ProviderUpdate` in contracts, `src/install.ts`): `npm` when the binary is an npm global install
(`<prefix>\codex.cmd` next to `<prefix>\node_modules\@openai\codex` on Windows, a link into
`<prefix>/lib/node_modules/@openai/codex` or `<prefix>/bin/codex` with that package on POSIX),
with `--prefix` when `npm prefix -g` names another prefix; otherwise `manual` with the Homebrew or
download instruction. The server runs the npm update (`provider.update`); the adapter never does.

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
| `test`                             | initialize, version or schema check, `account/read`, `model/list`               |

Permission modes are `read-only`, `auto` (default), `untrusted` and `full-access`
(`codexPermissionModes`); each is an approval policy plus a sandbox. Model, effort and permission
mode travel with every `turn/start`, so `setModel` and `setPermissionMode` apply to the next turn.
Server requests the adapter does not handle are answered with a JSON-RPC error so codex never
waits on them.

`startTurn` failures before the turn begins reject the promise and also emit `turnFailed`, so a
thread never stays working. If the app-server exits, running turns fail and the next command
starts a new process; threads are resumed with `thread/resume`.

## Tests

- `src/compat/compat.test.ts` checks the comparison against invented schemas made from the
  fingerprint (`src/compat/synthesize.ts`), and `adapter.test.ts` runs `test` against a fake codex
  of another version with a compatible or incompatible invented schema. The fake user agent follows
  `codexProtocolVersion`, so regenerating for a new codex does not break these tests.
- `pnpm --filter @wow/provider-codex test` replays JSON-RPC fixtures through a fake stdio process
  (`ReplayCodexProcess`). `fixtures/turn-interrupt.jsonl` and `fixtures/test-not-logged-in.jsonl`
  are recorded from codex 0.166.0 with invented paths and ids; `fixtures/turn-tools.jsonl` is an
  invented turn written against the generated types.
- `WOW_REAL_PROVIDERS=1` runs `src/real.smoke.test.ts` against the installed codex (`CODEX_BIN`,
  `WOW_CODEX_HOME`); the turn needs a logged-in codex home. Its schema check needs neither login
  nor network (`WOW_CODEX_EXPECT=incompatible` for a release that is not compatible).
