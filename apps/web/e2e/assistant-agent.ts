import type { ProviderAdapter, ProviderCommand, ProviderEvent } from '@wow/contracts';

// The mock agent of the assistant's turns (e2e/assistant.spec.ts). An ordinary thread goes to
// the chat tests' script; a turn that carries wow's toolset calls wow's tools in process, the
// way a real agent would over MCP, and reports each call as Claude Code does
// (`mcp__wow__<tool>`). What the user wrote picks the scenario.

export interface AssistantToolsLike {
  call(name: string, args: unknown): Promise<{ readonly text: string; readonly isError: boolean }>;
}

interface Step {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

// The user's own words: the last part of the prompt, after a note from wow if there is one.
const userText = (prompt: string) => prompt.split('\n\n').at(-1) ?? prompt;
const noteOf = (prompt: string) =>
  prompt.startsWith('[From wow') ? prompt.slice(0, prompt.lastIndexOf('\n\n')) : null;

interface Scenario {
  readonly steps: Step[];
  readonly answer: string;
  // An answer made from what the tools answered, in the order called.
  readonly reply?: (results: readonly string[]) => string;
}

interface Problem {
  readonly what: string;
  readonly reason: string;
  readonly place: { readonly label: string };
}

// What a real agent would say from diagnose_setup's answer: each failing thing with its reason
// and place, or that nothing fails.
function diagnosisReply(results: readonly string[]): string {
  const { summary, problems } = JSON.parse(results[0] ?? '{}') as {
    summary?: string;
    problems?: Problem[];
  };
  return [
    summary ?? 'wow did not answer.',
    ...(problems ?? []).map(
      (problem) => `- ${problem.what}: ${problem.reason} Fix it in ${problem.place.label}.`,
    ),
  ].join('\n');
}

function scenario(text: string, trackerUrl: string): Scenario {
  if (/work hours/i.test(text)) {
    return {
      steps: [
        {
          tool: 'set_setting',
          args: {
            key: 'calendar.workHours',
            scope: 'global',
            value: {
              start: '08:00',
              end: '16:00',
              days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            },
          },
        },
      ],
      answer: 'Your work hours now end at 16:00. You can see them in Settings → Calendar.',
    };
  }
  if (/scripts/i.test(text)) {
    return {
      steps: [
        { tool: 'set_setting', args: { key: 'viewer.htmlScripts', scope: 'global', value: true } },
      ],
      answer: 'That lets HTML files run their scripts in the viewer, so it waits for your yes.',
    };
  }
  if (/gitlab/i.test(text)) {
    return {
      steps: [
        {
          tool: 'set_setting',
          args: { key: 'trackers.gitlab.baseUrl', scope: 'global', value: `${trackerUrl}/gitlab` },
        },
        { tool: 'show_secret_field', args: { key: 'trackers.gitlab.token' } },
      ],
      answer:
        "I set the GitLab address. The steps from wow's guide are above the field: create a personal access token with read_api on your GitLab and put it in the field; I never see it.",
    };
  }
  if (/not work/i.test(text)) {
    return {
      steps: [{ tool: 'diagnose_setup', args: {} }],
      answer: '',
      reply: diagnosisReply,
    };
  }
  if (/kettle test/i.test(text)) {
    return {
      steps: [{ tool: 'offer_project_work', args: { text } }],
      answer:
        'That is work in your project, which the chat view is for. Open it there with the button.',
    };
  }
  return { steps: [], answer: `You said: ${text}` };
}

let made = 0;

export class AssistantMockAgent implements ProviderAdapter {
  readonly kind = 'claude' as const;
  readonly #ordinary: ProviderAdapter;
  readonly #tools: () => AssistantToolsLike;
  readonly #trackerUrl: string;
  readonly #listeners = new Set<(event: ProviderEvent) => void>();

  constructor(ordinary: ProviderAdapter, tools: () => AssistantToolsLike, trackerUrl: string) {
    this.#ordinary = ordinary;
    this.#tools = tools;
    this.#trackerUrl = trackerUrl;
    ordinary.onEvent((event) => this.#emit(event));
  }

  send(command: ProviderCommand): Promise<unknown> {
    if (command.type === 'startTurn' && command.toolset) {
      // Answered after send resolves, the way a provider streams after accepting a turn.
      setImmediate(() => void this.#turn(command.threadId, command.prompt));
      return Promise.resolve({ ok: true });
    }
    return this.#ordinary.send(command);
  }

  async #turn(threadId: string, prompt: string): Promise<void> {
    const text = userText(prompt);
    const { steps, answer, reply: replyOf } = scenario(text, this.#trackerUrl);
    const results: string[] = [];
    this.#emit({ type: 'session', threadId, providerSessionId: `assistant-session-${threadId}` });
    for (const step of steps) {
      const itemId = `${threadId}-tool-${++made}`;
      this.#emit({
        type: 'toolCallStarted',
        threadId,
        itemId,
        name: `mcp__wow__${step.tool}`,
        input: step.args,
      });
      const result = await this.#tools().call(step.tool, step.args);
      results.push(result.text);
      this.#emit({ type: 'toolCallOutput', threadId, itemId, output: result.text });
      this.#emit({
        type: 'toolCallCompleted',
        threadId,
        itemId,
        status: result.isError ? 'error' : 'ok',
      });
    }
    const note = noteOf(prompt);
    const said = replyOf ? replyOf(results) : answer;
    const reply = note
      ? `${said}\n\nwow told me:\n\n${note.split('\n').slice(1).join('\n')}`
      : said;
    this.#emit({
      type: 'textDelta',
      threadId,
      itemId: `${threadId}-reply-${++made}`,
      delta: reply,
    });
    this.#emit({ type: 'turnCompleted', threadId });
  }

  #emit(event: ProviderEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): Promise<void> {
    this.#listeners.clear();
    return this.#ordinary.dispose();
  }
}
