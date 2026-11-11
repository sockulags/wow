import {
  assistantThreadId,
  defaultSecretPatterns,
  hiddenText,
  secretPatterns,
  type ProviderEvent,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { AssistantRedactor } from './redact.js';

// The net over what the assistant's agent streams (app assistant spec 18), piece by piece as
// the provider service hands it on. Every value is invented.

const lookalike = 'glpat-abcdefghijklmnopqrstuvwxyz0123';
const patterns = secretPatterns(defaultSecretPatterns);
const threadId = assistantThreadId;

const text = (delta: string, itemId = 'text'): ProviderEvent => ({
  type: 'textDelta',
  threadId,
  itemId,
  delta,
});

const stored = (events: readonly ProviderEvent[]) =>
  events.map((event) => (event.type === 'textDelta' ? event.delta : `<${event.type}>`)).join('');

describe('the net over streamed text', () => {
  it('finds a lookalike split across pieces that arrive in separate batches', () => {
    const redactor = new AssistantRedactor();
    const seen: ProviderEvent[] = [];
    for (const piece of ['Here: glpat-abcdefgh', 'ijklmnopqrstuvwxyz', '0123 is it.']) {
      seen.push(...redactor.redact(threadId, [text(piece)], () => patterns));
    }
    seen.push(...redactor.redact(threadId, [{ type: 'turnCompleted', threadId }], () => patterns));
    expect(stored(seen)).toBe(`Here: ${hiddenText} is it.<turnCompleted>`);
    expect(JSON.stringify(seen)).not.toMatch(/glpat|abcdefgh|ijklmn|0123/);
  });

  it('finds a value after "password is" when the word and the value come in different pieces', () => {
    const redactor = new AssistantRedactor();
    const seen = redactor.redact(
      threadId,
      [
        text('my password is '),
        text('9f8e7d6c5b4a'),
        text('39281706f5e4d3c2'),
        { type: 'toolCallStarted', threadId, itemId: 'tool', name: 'x', input: {} },
      ],
      () => patterns,
    );
    expect(stored(seen)).toBe(`my password is ${hiddenText}<toolCallStarted>`);
  });

  it('passes ordinary text on at each whitespace and the rest when the item ends', () => {
    const redactor = new AssistantRedactor();
    expect(stored(redactor.redact(threadId, [text('Work hours are')], () => patterns))).toBe(
      'Work hours ',
    );
    expect(
      stored(
        redactor.redact(
          threadId,
          [text(' set.'), { type: 'turnCompleted', threadId }],
          () => patterns,
        ),
      ),
    ).toBe('are set.<turnCompleted>');
  });

  it('holds tool output until the call completes and hides it whole', () => {
    const redactor = new AssistantRedactor();
    const seen = redactor.redact(
      threadId,
      [
        {
          type: 'toolCallOutput',
          threadId,
          itemId: 'tool',
          output: `{"v":"${lookalike.slice(0, 9)}`,
        },
        { type: 'toolCallOutput', threadId, itemId: 'tool', output: `${lookalike.slice(9)}"}` },
        { type: 'toolCallCompleted', threadId, itemId: 'tool', status: 'ok' },
      ],
      () => patterns,
    );
    expect(seen.map((event) => event.type)).toEqual(['toolCallOutput', 'toolCallCompleted']);
    expect(seen[0]).toMatchObject({ output: `{"v":"${hiddenText}"}` });
  });

  it('does not compile the patterns for an ordinary thread and leaves it as reported', () => {
    const redactor = new AssistantRedactor();
    const events: ProviderEvent[] = [
      { type: 'textDelta', threadId: 'chat-1', itemId: 'text', delta: lookalike },
    ];
    expect(
      redactor.redact('chat-1', events, () => {
        throw new Error('compiled for an ordinary thread');
      }),
    ).toEqual(events);
  });
});
