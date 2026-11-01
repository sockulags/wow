import { describe, expect, it } from 'vitest';
import {
  Keybinding,
  KeyValueList,
  ProviderCommand,
  ProviderEvent,
  RpcResponse,
  ServerMessage,
  StepRun,
  WorkflowStep,
  settingsRegistry,
  type SettingDefinition,
} from './index.js';

describe('rpc envelope', () => {
  it('accepts a result or an error but not both', () => {
    expect(RpcResponse.safeParse({ id: '1', result: { ok: true } }).success).toBe(true);
    expect(
      RpcResponse.safeParse({ id: '1', error: { code: 'invalid', message: 'x' } }).success,
    ).toBe(true);
    expect(
      RpcResponse.safeParse({ id: '1', result: 1, error: { code: 'x', message: 'y' } }).success,
    ).toBe(false);
  });

  it('accepts subscription pushes from the server', () => {
    expect(ServerMessage.safeParse({ subscription: 'threads', data: [] }).success).toBe(true);
  });
});

describe('provider protocol', () => {
  it('parses a start turn command', () => {
    const command = ProviderCommand.parse({
      type: 'startTurn',
      threadId: 't1',
      cwd: 'C:\\work\\wow',
      prompt: 'hello',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(command.type).toBe('startTurn');
  });

  it('rejects an unknown event type', () => {
    expect(ProviderEvent.safeParse({ type: 'nope', threadId: 't1' }).success).toBe(false);
  });

  it('parses a question with options', () => {
    const event = ProviderEvent.parse({
      type: 'questionAsked',
      threadId: 't1',
      questionId: 'q1',
      question: 'Which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'needs a server' }],
      multiSelect: false,
    });
    expect(event.type).toBe('questionAsked');
  });
});

describe('workflow contracts', () => {
  it('parses a step and its run', () => {
    expect(
      WorkflowStep.parse({
        id: 's1',
        skillName: 'capture-intent',
        providerInstanceId: 'claude-work',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: ['intents/*/intent.md'],
      }).gateAfter,
    ).toBe(true);
    expect(StepRun.safeParse({ stepId: 's1', state: 'waiting', artifactsFound: [] }).success).toBe(
      true,
    );
  });
});

describe('settings registry', () => {
  const entries: [string, SettingDefinition][] = Object.entries(settingsRegistry);

  it('fills in the calendar, scheduler, appearance and keybindings groups', () => {
    const groups = new Set(entries.map(([, definition]) => definition.group));
    expect(groups).toEqual(new Set(['calendar', 'scheduler', 'appearance', 'keybindings']));
  });

  it('accepts shortcuts with modifiers or empty, and marks the schema as a keybinding', () => {
    expect(Keybinding.safeParse('Mod+K').success).toBe(true);
    expect(Keybinding.safeParse('Mod+Shift+,').success).toBe(true);
    expect(Keybinding.safeParse('').success).toBe(true);
    expect(Keybinding.safeParse('Mod+').success).toBe(false);
    expect(Keybinding.safeParse('Hyper+K').success).toBe(false);
    expect(Keybinding.meta()?.['widget']).toBe('keybinding');
  });

  it('rejects duplicate keys in a key-value list', () => {
    const entry = { key: 'TOKEN', value: 'x', secret: true };
    expect(KeyValueList.safeParse([entry]).success).toBe(true);
    expect(KeyValueList.safeParse([entry, entry]).success).toBe(false);
  });

  it.each(entries)('%s has a default that passes its own schema', (_key, definition) => {
    expect(definition.schema.safeParse(definition.default).success).toBe(true);
  });

  it('prefixes every key with its group', () => {
    for (const [key, definition] of entries) {
      expect(key.startsWith(`${definition.group}.`)).toBe(true);
    }
  });

  it('rejects an unknown time zone and inverted work hours', () => {
    expect(settingsRegistry['calendar.zone'].schema.safeParse('Europe/Stockholm').success).toBe(
      true,
    );
    expect(settingsRegistry['calendar.zone'].schema.safeParse('Mars/Olympus').success).toBe(false);
    expect(
      settingsRegistry['calendar.workHours'].schema.safeParse({
        start: '17:00',
        end: '08:00',
        days: ['monday'],
      }).success,
    ).toBe(false);
  });
});
