import {
  assistantThreadId,
  hiddenText,
  hideSecrets,
  hideSecretsDeep,
  type ProviderEvent,
} from '@wow/contracts';

// What the assistant's agent reports goes through the secret net before it is stored (app
// assistant spec 18): a tool's input and output, its text and reasoning, its task list, and a
// failure's words. wow's own tools already hide what they return; this also covers what the
// agent wrote itself.
//
// Streamed text is checked on the whole text of its item, not piece by piece, so a value split
// across two pieces is still found. What is passed on is the hidden text up to its last
// whitespace: a token has none, so the end that is held back may still become one, and what was
// passed on never changes. The rest goes when the item ends (a tool call, an approval or a
// question starts, or the turn ends). A custom pattern that matches across whitespace can grow
// back over text already passed on; the rest of that item is then stored as [hidden].

type Streamed = Extract<ProviderEvent, { type: 'textDelta' | 'reasoningDelta' | 'toolCallOutput' }>;

interface Stream {
  readonly event: Streamed;
  raw: string;
  sent: string;
  broken: boolean;
}

const textOf = (event: Streamed) => (event.type === 'toolCallOutput' ? event.output : event.delta);

const withText = (event: Streamed, text: string): Streamed =>
  event.type === 'toolCallOutput' ? { ...event, output: text } : { ...event, delta: text };

const toolTexts = [
  'command',
  'cwd',
  'path',
  'pattern',
  'url',
  'query',
  'server',
  'tool',
  'diff',
] as const;

// The facts an adapter read from a tool's input repeat parts of it, so they get the same net.
const hiddenFacts = (
  event: Extract<ProviderEvent, { type: 'toolCallStarted' }>,
  patterns: readonly RegExp[],
) => {
  const out: Partial<Record<(typeof toolTexts)[number], string>> = {};
  for (const key of toolTexts) {
    const value = event[key];
    if (value !== undefined) out[key] = hideSecrets(value, patterns);
  }
  return out;
};

const lastSpace = (text: string, from: number): number => {
  for (let index = text.length - 1; index >= from; index -= 1) {
    if (/\s/.test(text[index] ?? '')) return index + 1;
  }
  return -1;
};

export class AssistantRedactor {
  readonly #streams = new Map<string, Stream>();

  // `patterns` is asked only for the assistant thread, so an ordinary thread costs nothing.
  redact(
    threadId: string,
    events: readonly ProviderEvent[],
    patterns: () => readonly RegExp[],
  ): ProviderEvent[] {
    if (threadId !== assistantThreadId) return [...events];
    const compiled = patterns();
    const out: ProviderEvent[] = [];
    for (const event of events) {
      switch (event.type) {
        case 'textDelta':
        case 'reasoningDelta':
        case 'toolCallOutput':
          this.#take(event, compiled, out);
          break;
        case 'toolCallCompleted':
          this.#end(out, compiled, (stream) => stream.event.itemId === event.itemId);
          out.push(
            event.diff === undefined
              ? event
              : { ...event, diff: hideSecrets(event.diff, compiled) },
          );
          break;
        case 'toolCallStarted':
          this.#end(out, compiled, (stream) => stream.event.type !== 'toolCallOutput');
          out.push({
            ...event,
            name: hideSecrets(event.name, compiled),
            input: hideSecretsDeep(event.input, compiled),
            ...hiddenFacts(event, compiled),
          });
          break;
        case 'approvalRequested':
          this.#end(out, compiled, (stream) => stream.event.type !== 'toolCallOutput');
          out.push({
            ...event,
            summary: hideSecrets(event.summary, compiled),
            request: hideSecretsDeep(event.request, compiled),
            ...(event.facts === undefined
              ? {}
              : { facts: hideSecretsDeep(event.facts, compiled) as typeof event.facts }),
          });
          break;
        case 'questionAsked':
          this.#end(out, compiled, (stream) => stream.event.type !== 'toolCallOutput');
          out.push({
            ...event,
            question: hideSecrets(event.question, compiled),
            ...(event.header === undefined ? {} : { header: hideSecrets(event.header, compiled) }),
            options: event.options.map((option) => ({
              ...option,
              label: hideSecrets(option.label, compiled),
              ...(option.description === undefined
                ? {}
                : { description: hideSecrets(option.description, compiled) }),
            })),
          });
          break;
        case 'taskListUpdated':
          out.push({
            ...event,
            tasks: event.tasks.map((task) => ({
              ...task,
              content: hideSecrets(task.content, compiled),
            })),
          });
          break;
        case 'backgroundTasks':
          out.push({
            ...event,
            tasks: event.tasks.map((task) => ({
              ...task,
              description: hideSecrets(task.description, compiled),
            })),
          });
          break;
        case 'turnFailed':
          this.#end(out, compiled, () => true);
          out.push({ ...event, error: hideSecrets(event.error, compiled) });
          break;
        case 'turnCompleted':
        case 'turnInterrupted':
          this.#end(out, compiled, () => true);
          out.push(event);
          break;
        default:
          out.push(event);
      }
    }
    return out;
  }

  #take(event: Streamed, patterns: readonly RegExp[], out: ProviderEvent[]): void {
    const key = `${event.type}:${event.itemId}`;
    let stream = this.#streams.get(key);
    if (!stream) {
      stream = { event, raw: '', sent: '', broken: false };
      this.#streams.set(key, stream);
    }
    stream.raw += textOf(event);
    if (stream.broken) return;
    const hidden = hideSecrets(stream.raw, patterns);
    if (!hidden.startsWith(stream.sent)) {
      this.#break(stream, out);
      return;
    }
    const cut = lastSpace(hidden, stream.sent.length);
    if (cut <= stream.sent.length) return;
    const next = hidden.slice(stream.sent.length, cut);
    stream.sent += next;
    out.push(withText(stream.event, next));
  }

  #end(out: ProviderEvent[], patterns: readonly RegExp[], which: (stream: Stream) => boolean) {
    for (const [key, stream] of this.#streams) {
      if (!which(stream)) continue;
      this.#streams.delete(key);
      if (stream.broken) continue;
      const hidden = hideSecrets(stream.raw, patterns);
      if (!hidden.startsWith(stream.sent)) {
        this.#break(stream, out);
        continue;
      }
      const rest = hidden.slice(stream.sent.length);
      if (rest !== '') out.push(withText(stream.event, rest));
    }
  }

  #break(stream: Stream, out: ProviderEvent[]): void {
    stream.broken = true;
    out.push(withText(stream.event, hiddenText));
  }
}
