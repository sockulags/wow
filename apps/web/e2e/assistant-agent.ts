import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ServerCommand,
} from '@wow/contracts';

// The mock agent of the assistant's turns (e2e/assistant.spec.ts). An ordinary thread goes to
// the chat tests' script; a turn that carries wow's toolset calls wow's tools in process, the
// way a real agent would over MCP, and reports each call as Claude Code does
// (`mcp__wow__<tool>`). What the user wrote picks the scenario.

export interface AssistantToolsLike {
  call(name: string, args: unknown): Promise<{ readonly text: string; readonly isError: boolean }>;
}

// What the agent does in a turn: a call of one of wow's tools, or a command wow would carry out
// for the assistant (with its origin), which is how the assistant's own commands reach the
// engine; a mock agent may try one that no tool offers, to show that wow refuses it.
type Step =
  | { readonly tool: string; readonly args: Record<string, unknown> }
  | { readonly command: ServerCommand };

// Carries out a command as the assistant's; throws wow's refusal.
export type AssistantAct = (command: ServerCommand) => void;

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
  const approve = /approve the run (\S+)/i.exec(text);
  if (approve?.[1]) {
    // wow offers no tool for a gate (spec 11); even the real command, sent as the assistant's,
    // is refused, and the run keeps waiting.
    return {
      steps: [{ command: { type: 'workflowRun.continue', runId: approve[1] } }],
      answer:
        'Only you approve a run at its gate, send it back or stop it; wow gives me no tool for that and refuses it from me. Open the run from Workflows → Runs and answer the gate there.',
    };
  }
  return { steps: [], answer: `You said: ${text}` };
}

// One thing a setup file left to fill in, from wow's note at first start (spec 24).
interface FillIn {
  readonly label: string;
  readonly key: string | null;
  readonly secret: boolean;
}

const firstStartLine = 'The first-start step just finished';

// The lines of a note's section, from its heading to the next line without a "- ".
function section(note: string, heading: RegExp): string[] {
  const lines = note.split('\n');
  const at = lines.findIndex((line) => heading.test(line));
  if (at === -1) return [];
  const after = lines.slice(at + 1);
  const end = after.findIndex((line) => !line.startsWith('- '));
  return (end === -1 ? after : after.slice(0, end)).map((line) => line.slice(2));
}

function fillInsOf(note: string): FillIn[] {
  return section(note, /^To fill in after the setup file/).map((line) => {
    const match = /^(.+?) \(([^,)]+)(?:, [^)]*)?\): (.*)$/.exec(line);
    const label = match?.[1] ?? line;
    const key = match?.[2]?.includes('.') ? match[2] : null;
    return { label, key, secret: match?.[3]?.startsWith('a secret') ?? false };
  });
}

// How a real agent would ask for the next thing, one per answer.
function ask(item: FillIn): { readonly steps: Step[]; readonly text: string } {
  if (item.secret && item.key) {
    return {
      steps: [{ tool: 'show_secret_field', args: { key: item.key } }],
      text: `Next: ${item.label}. Create it with the steps above the field and save it there; I never see it. Say "done" when it is saved.`,
    };
  }
  if (item.key === 'calendar.workHours') {
    return {
      steps: [],
      text: 'Next: your work hours. When does your working day start and end?',
    };
  }
  return {
    steps: [],
    text: `Next: ${item.label}. Which folder on this computer holds your project? Add it in Settings → Projects, or tell me where it is.`,
  };
}

let made = 0;

export class AssistantMockAgent implements ProviderAdapter {
  readonly kind = 'claude' as const;
  readonly #ordinary: ProviderAdapter;
  readonly #tools: () => AssistantToolsLike;
  readonly #act: AssistantAct;
  readonly #trackerUrl: string;
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  // What the setup file left to fill in and was not asked for yet; undefined when no walk-through
  // is going on.
  #walk: FillIn[] | undefined;

  constructor(
    ordinary: ProviderAdapter,
    tools: () => AssistantToolsLike,
    act: AssistantAct,
    trackerUrl: string,
  ) {
    this.#ordinary = ordinary;
    this.#tools = tools;
    this.#act = act;
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

  // The greeting after the first-start step: what is set up and what a first run still needs,
  // from wow's note, then the first thing the setup file left to fill in.
  #greeting(note: string): Scenario & { readonly told: true } {
    const setUp = section(note, /^Set up:$/);
    const needed = section(note, /^Still needed for a first run:$/);
    this.#walk = fillInsOf(note);
    const first = this.#walk.shift();
    const next = first ? ask(first) : undefined;
    return {
      steps: next?.steps ?? [],
      answer: [
        'Welcome to wow. This is set up:',
        ...setUp.map((line) => `- ${line}`),
        '',
        'A first run still needs:',
        ...needed.map((line) => `- ${line}`),
        ...(next
          ? ['', 'Your setup file left some things to fill in, one at a time.', next.text]
          : []),
      ].join('\n'),
      told: true,
    };
  }

  // Each answer during the walk-through asks for the next thing, until none is left.
  #walkOn(current: Scenario): Scenario {
    if (!this.#walk) return current;
    const item = this.#walk.shift();
    if (!item) this.#walk = undefined;
    const next = item ? ask(item) : undefined;
    const said = current.answer === '' ? '' : `${current.answer}\n\n`;
    return {
      steps: [...current.steps, ...(next?.steps ?? [])],
      answer: `${said}${next ? next.text : 'That is everything the setup file left to fill in.'}`,
    };
  }

  async #turn(threadId: string, prompt: string): Promise<void> {
    const text = userText(prompt);
    const note = noteOf(prompt);
    const greeting = note?.includes(firstStartLine) ? this.#greeting(note) : undefined;
    const {
      steps,
      answer,
      reply: replyOf,
    } = greeting ?? this.#walkOn(scenario(text, this.#trackerUrl));
    const results: string[] = [];
    this.#emit({ type: 'session', threadId, providerSessionId: `assistant-session-${threadId}` });
    for (const step of steps) {
      const itemId = `${threadId}-tool-${++made}`;
      this.#emit({
        type: 'toolCallStarted',
        threadId,
        itemId,
        name: 'tool' in step ? `mcp__wow__${step.tool}` : `wow command ${step.command.type}`,
        input: 'tool' in step ? step.args : step.command,
      });
      const result =
        'tool' in step ? await this.#tools().call(step.tool, step.args) : this.#command(step);
      results.push(result.text);
      this.#emit({ type: 'toolCallOutput', threadId, itemId, output: result.text });
      this.#emit({
        type: 'toolCallCompleted',
        threadId,
        itemId,
        status: result.isError ? 'error' : 'ok',
      });
    }
    const said = replyOf ? replyOf(results) : answer;
    const reply =
      note && !greeting
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

  #command(step: { readonly command: ServerCommand }): { text: string; isError: boolean } {
    try {
      this.#act(step.command);
      return { text: JSON.stringify({ outcome: 'changed' }), isError: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: JSON.stringify({ outcome: 'refused', reason }), isError: true };
    }
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
