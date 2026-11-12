import { describe, expect, it } from 'vitest';
import {
  boundedSessionTools,
  mcpServersNeedingYou,
  sameSessionTools,
  SessionTools,
  sessionToolsLimits,
  ThreadTools,
} from './session-tools.js';
import { ProviderEvent } from './provider.js';

const tools = (overrides: Partial<SessionTools> = {}): SessionTools => ({
  reportedAt: '2026-11-12T20:41:00.000Z',
  complete: true,
  mcpServers: [
    {
      name: 'tea-docs',
      state: 'connected',
      stateWord: 'connected',
      error: null,
      source: 'project',
      version: '1.2.0',
      address: 'https://docs.tea.example',
      tools: [{ name: 'search_docs', description: 'Search', readOnly: true, destructive: false }],
    },
    {
      name: 'tea-tracker',
      state: 'failed',
      stateWord: 'failed',
      error: 'spawn tea-tracker ENOENT',
      source: 'user',
      version: null,
      address: 'tea-tracker',
      tools: [],
    },
  ],
  builtInTools: ['Bash'],
  skills: [],
  commands: [],
  agents: [],
  plugins: [],
  instructionFiles: [],
  ...overrides,
});

describe('session tools (thread work U5)', () => {
  it('keeps only named fields: a config, an environment or headers do not come through', () => {
    const withConfig = {
      ...tools(),
      mcpServers: [
        {
          ...tools().mcpServers[0],
          config: { url: 'https://docs.tea.example/v1?key=secret', headers: { A: 'Bearer x' } },
          env: { TOKEN: 'secret' },
          args: ['--token=secret'],
        },
      ],
    };
    const event = ProviderEvent.parse({ type: 'sessionTools', threadId: 't1', tools: withConfig });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('bounds texts and lists so a large session fits the schema', () => {
    const many = tools({
      builtInTools: Array.from({ length: sessionToolsLimits.builtInTools + 5 }, (_, n) => `T${n}`),
      skills: [{ name: 'brew', description: 'x'.repeat(sessionToolsLimits.text + 50) }],
      instructionFiles: ['', '/work/tea/AGENTS.md'],
    });
    expect(SessionTools.safeParse(many).success).toBe(false);
    const bounded = boundedSessionTools(many);
    expect(SessionTools.parse(bounded).builtInTools).toHaveLength(sessionToolsLimits.builtInTools);
    expect(bounded.skills[0]?.description?.length).toBe(sessionToolsLimits.text);
    expect(bounded.instructionFiles).toEqual(['/work/tea/AGENTS.md']);
  });

  it('tells a changed list from one reported again at another time', () => {
    expect(sameSessionTools(tools(), tools({ reportedAt: '2026-11-12T21:00:00.000Z' }))).toBe(true);
    expect(sameSessionTools(tools(), tools({ builtInTools: ['Bash', 'Read'] }))).toBe(false);
  });

  it('counts the servers that need the user, for the header chip', () => {
    expect(mcpServersNeedingYou(tools())).toEqual({ failed: 1, needsAuth: 0 });
    expect(mcpServersNeedingYou(undefined)).toEqual({ failed: 0, needsAuth: 0 });
  });

  it('is the row of the threadTools topic', () => {
    expect(
      ThreadTools.parse({ threadId: 't1', tools: tools(), source: 'turn', live: true }),
    ).toMatchObject({ live: true });
  });
});
