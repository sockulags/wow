import {
  assistantThreadId,
  hideSecrets,
  hideSecretsDeep,
  type ProviderEvent,
} from '@wow/contracts';

// What the assistant's agent reports goes through the secret net before it is stored (app
// assistant spec 18): a tool's input and output, its text and reasoning, and a failure's
// words. wow's own tools already hide what they return; this also covers what the agent wrote
// itself. Text that streams in pieces is checked piece by piece, so a value split across two
// pieces can pass: the net is not the mechanism, the secret field is.
export function redactAssistantEvents(
  threadId: string,
  events: readonly ProviderEvent[],
  patterns: readonly RegExp[],
): ProviderEvent[] {
  if (threadId !== assistantThreadId) return [...events];
  return events.map((event): ProviderEvent => {
    switch (event.type) {
      case 'toolCallStarted':
        return {
          ...event,
          name: hideSecrets(event.name, patterns),
          input: hideSecretsDeep(event.input, patterns),
        };
      case 'toolCallOutput':
        return { ...event, output: hideSecrets(event.output, patterns) };
      case 'textDelta':
      case 'reasoningDelta':
        return { ...event, delta: hideSecrets(event.delta, patterns) };
      case 'turnFailed':
        return { ...event, error: hideSecrets(event.error, patterns) };
      case 'approvalRequested':
        return {
          ...event,
          summary: hideSecrets(event.summary, patterns),
          request: hideSecretsDeep(event.request, patterns),
        };
      case 'questionAsked':
        return {
          ...event,
          question: hideSecrets(event.question, patterns),
          options: event.options.map((option) => ({
            ...option,
            label: hideSecrets(option.label, patterns),
            ...(option.description === undefined
              ? {}
              : { description: hideSecrets(option.description, patterns) }),
          })),
        };
      default:
        return event;
    }
  });
}
