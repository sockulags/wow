import type { ProviderCommand } from '@wow/contracts';
import type { MethodUse } from './compat/schema.js';
import type { ThreadStartParams, TurnStartParams } from './protocol/generated/index.js';

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;
export type Toolset = NonNullable<StartTurn['toolset']>;

// A thread that only has the app's tools (app assistant spec 2). The settings below switch
// codex's own tools off where it has a switch; should one stay (apply_patch and the MCP resource
// tools have none), the thread still runs in a read-only sandbox without network and never asks
// to leave it: a command cannot write, cannot reach a host and is not offered to the user for
// approval. The folder it starts in is the app's empty one.
export const toolsOnlyMode = { approvalPolicy: 'never', sandbox: 'read-only' } as const;

// Sent with every turn of such a thread, because it replaces what config.toml allows (network
// access in the sandbox).
export const toolsOnlySandbox: NonNullable<TurnStartParams['sandboxPolicy']> = {
  type: 'readOnly',
  networkAccess: false,
};

// What thread/start and thread/resume get on top of the usual settings. `config` overrides
// config.toml for this thread: `mcp_servers` as a whole, so the servers the user set up for
// their own work are not there, web search off, codex's switchable tools off (commands, image
// viewing, subagents, goals, apps, image generation, computer and browser use, plugins, skill
// search, tool suggestions, sleep, code mode, questions to the user; each is a feature
// `codex features list` of 0.166.0 shows on by default), the user's own hooks off, since they
// run the user's commands, and a shell environment that inherits nothing, so a command the agent runs, if
// one is still offered, sees no variable of wow's or the instance's (an API key among them). The
// token travels in a header of the MCP server entry and only over stdio to the app-server.
export function toolsOnlySettings(
  toolset: Toolset,
  instructions: string | undefined,
): Pick<ThreadStartParams, 'config' | 'developerInstructions'> {
  return {
    config: {
      mcp_servers: {
        [toolset.name]: {
          url: toolset.url,
          http_headers: { Authorization: `Bearer ${toolset.token}` },
        },
      },
      web_search: 'disabled',
      features: {
        shell_tool: false,
        unified_exec: false,
        view_image: false,
        multi_agent: false,
        goals: false,
        apps: false,
        image_generation: false,
        computer_use: false,
        browser_use: false,
        browser_use_external: false,
        in_app_browser: false,
        plugins: false,
        remote_plugin: false,
        skill_search: false,
        tool_suggest: false,
        sleep_tool: false,
        code_mode_host: false,
        hooks: false,
      },
      tools: { experimental_request_user_input: { enabled: false } },
      shell_environment_policy: { inherit: 'none' },
    },
    ...(instructions === undefined ? {} : { developerInstructions: instructions }),
  };
}

// The options above, for the check against a codex other than the tested one. They are not part
// of the generated fingerprint: an ordinary thread never sends them, so a codex without them
// stays compatible and only a tools-only thread is refused.
const options: MethodUse = {
  kind: 'clientRequest',
  params: [{ path: 'config' }, { path: 'developerInstructions' }],
  result: [],
};
export const toolsOnlyUses: Readonly<Record<string, MethodUse>> = {
  'thread/start': options,
  'thread/resume': options,
};
