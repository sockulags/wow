import {
  defaultAssistantInstructions,
  settingsRegistry,
  type AssistantChange,
  type AssistantProposal,
  type CalendarItem,
  type RepeatRule,
  type ServerCommand,
  type SubscriptionTopic,
  type Trigger,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';

// Recurring cards spec 13 and 18 to 21: the assistant's card tools take a repeat rule, a series
// is one change row that says the rule in words, Undo takes back or brings back the whole
// series, and the startSoon rule looks at the next occurrence.

let root: string;
let server: RunningServer;
let ids = 0;

// Tuesday 10 November 2026, 09:00 in Stockholm.
const now = '2026-11-10T08:00:00.000Z';
const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic) => snapshot(server.database.db, { topic }) as T[];
const card = (id: string) => rows<CalendarItem>('calendarItems').find((row) => row.id === id);
const trigger = (cardId: string) =>
  rows<Trigger>('triggers').find((row) => row.id === `${cardId}:trigger`);
const changes = () => rows<AssistantChange>('assistantChanges');

interface Called {
  readonly isError: boolean;
  readonly content: Record<string, unknown> & {
    outcome?: string;
    cardId?: string;
    change?: Pick<AssistantChange, 'id' | 'what' | 'from' | 'to'>;
    proposal?: Pick<AssistantProposal, 'id' | 'title' | 'lines'>;
  };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { isError: result.isError, content: JSON.parse(result.text) as Called['content'] };
}

const weekdays: RepeatRule = {
  frequency: 'weekly',
  interval: 1,
  weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  end: { kind: 'never' },
};

// 08:30 in Stockholm on a November day.
const morning = (date: string, minutes = 0) =>
  new Date(Date.parse(`${date}T07:30:00.000Z`) + minutes * 60_000).toISOString();

const review = (start: string, repeat: RepeatRule = weekdays) => ({
  title: 'Morning review',
  start,
  end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
  zone: 'Europe/Stockholm',
  projectId: 'tea',
  workflowId: 'delivery',
  repeat,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-repeat-'));
  await mkdir(path.join(root, 'tea'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
  });
  asUser({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Claude at work',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  asUser({
    type: 'workflow.create',
    workflowId: 'delivery',
    name: 'Delivery',
    steps: [
      {
        id: 's1',
        skillName: 'deliver-work',
        providerInstanceId: 'claude-work',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: [],
      },
    ],
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('the assistant makes a repeating card (spec 18)', () => {
  it('makes one card whose change row says the rule in words, and Undo removes the series', async () => {
    const made = await call('create_card', review(morning('2026-11-11')));
    expect(made.content.outcome).toBe('changed');
    const cardId = made.content.cardId ?? '';
    expect(
      rows<CalendarItem>('calendarItems').filter((row) => row.source === 'local'),
    ).toHaveLength(1);
    expect(card(cardId)).toMatchObject({ repeat: weekdays, nextAt: morning('2026-11-11') });
    expect(made.content.change?.to).toContain('Every weekday at 08:30');

    asUser({ type: 'assistant.undo', changeId: made.content.change?.id ?? '' });
    expect(card(cardId)).toBeUndefined();
    expect(trigger(cardId)?.state).toBe('cancelled');
  });

  it('takes the rule in the create_card and update_card tools and offers skip_card_occurrence', () => {
    const tools = server.assistant.tools.list();
    const input = (name: string) =>
      tools.find((tool) => tool.name === name)?.inputSchema as
        { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(input('create_card')?.properties ?? {})).toContain('repeat');
    expect(Object.keys(input('create_card')?.properties ?? {})).not.toContain('skippedDates');
    expect(Object.keys(input('update_card')?.properties ?? {})).toContain('repeat');
    expect(Object.keys(input('skip_card_occurrence')?.properties ?? {})).toEqual([
      'cardId',
      'date',
    ]);
  });
});

describe('waiting for a yes looks at the next occurrence (spec 20)', () => {
  it('is an ordinary change when the next occurrence is further ahead, even with a past start', async () => {
    // First occurrence last Wednesday; the next is tomorrow at 08:30.
    const made = await call('create_card', review(morning('2026-11-04')));
    expect(made.content.outcome).toBe('changed');
    expect(trigger(made.content.cardId ?? '')).toMatchObject({
      state: 'scheduled',
      runAt: morning('2026-11-11'),
    });
  });

  it('is a proposal when the next occurrence starts within assistant.startSoonMinutes', async () => {
    // Daily at 09:10, first yesterday: the next one is ten minutes from now.
    const soon = await call(
      'create_card',
      review('2026-11-09T08:10:00.000Z', {
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        end: { kind: 'never' },
      }),
    );
    expect(soon.content.outcome).toBe('proposed');
    expect(soon.content.proposal?.lines).toContainEqual({
      what: 'Repeats',
      from: null,
      to: 'Every day at 09:10',
    });
    expect(rows<CalendarItem>('calendarItems')).toHaveLength(0);

    asUser({ type: 'setting.set', key: 'assistant.startSoonMinutes', scope: 'global', value: 5 });
    const later = await call(
      'create_card',
      review('2026-11-09T08:10:00.000Z', {
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        end: { kind: 'never' },
      }),
    );
    expect(later.content.outcome).toBe('changed');
  });

  it('makes an update that brings the next occurrence close a proposal', async () => {
    const made = await call('create_card', review(morning('2026-11-11')));
    const cardId = made.content.cardId ?? '';
    // Every day from last Monday at 09:10: the next one is ten minutes from now.
    const moved = await call('update_card', {
      cardId,
      start: '2026-11-09T08:10:00.000Z',
      end: '2026-11-09T08:40:00.000Z',
      repeat: { frequency: 'daily' },
    });
    expect(moved.content.outcome).toBe('proposed');
    expect(moved.content.proposal?.lines).toContainEqual({
      what: 'Repeats',
      from: 'Every weekday at 08:30',
      to: 'Every day at 09:10',
    });
  });
});

describe('skipping and reading (spec 21)', () => {
  it('skips one occurrence, reads the next fire time, and Undo puts the day back', async () => {
    const cardId = (await call('create_card', review(morning('2026-11-11')))).content.cardId ?? '';
    const skipped = await call('skip_card_occurrence', { cardId, date: '2026-11-11' });
    expect(skipped.content.outcome).toBe('changed');
    expect(card(cardId)?.skippedDates).toEqual(['2026-11-11']);
    expect(trigger(cardId)?.runAt).toBe(morning('2026-11-12'));

    const read = await call('read_calendar', {
      from: '2026-11-10T00:00:00.000Z',
      to: '2026-11-14T00:00:00.000Z',
    });
    const [listed] = read.content['cards'] as Record<string, unknown>[];
    expect(listed).toMatchObject({
      id: cardId,
      nextAt: morning('2026-11-12'),
      repeats: 'Every weekday at 08:30',
      skippedDates: ['2026-11-11'],
      moreOccurrences: false,
    });
    const listedOccurrences = (listed?.['occurrences'] ?? []) as { date: string }[];
    expect(listedOccurrences.map((o) => o.date)).toEqual(['2026-11-12', '2026-11-13']);
    const triggers = (await call('read_triggers')).content as unknown as Record<string, unknown>[];
    expect(triggers).toContainEqual(
      expect.objectContaining({ cardId, runAt: morning('2026-11-12'), state: 'scheduled' }),
    );

    asUser({ type: 'assistant.undo', changeId: skipped.content.change?.id ?? '' });
    expect(card(cardId)?.skippedDates).toEqual([]);
    expect(trigger(cardId)?.runAt).toBe(morning('2026-11-11'));
  });

  it('refuses to skip a day the rule does not fall on', async () => {
    const cardId = (await call('create_card', review(morning('2026-11-11')))).content.cardId ?? '';
    const refused = await call('skip_card_occurrence', { cardId, date: '2026-11-14' });
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatchObject({ outcome: 'refused' });
  });
});

describe('one Undo for each change of a series (spec 13)', () => {
  it('restores a changed rule with its trigger', async () => {
    const cardId = (await call('create_card', review(morning('2026-11-11')))).content.cardId ?? '';
    const changed = await call('update_card', {
      cardId,
      repeat: { frequency: 'weekly', weekdays: ['fri'] },
    });
    expect(changed.content.change).toMatchObject({
      from: 'Every weekday at 08:30',
      to: 'Every week on Friday at 08:30',
    });
    expect(trigger(cardId)?.runAt).toBe(morning('2026-11-11'));
    asUser({ type: 'assistant.undo', changeId: changed.content.change?.id ?? '' });
    expect(card(cardId)?.repeat).toEqual(weekdays);
  });

  it('brings a deleted series back with its rule, skipped days and trigger', async () => {
    const cardId = (await call('create_card', review(morning('2026-11-11')))).content.cardId ?? '';
    await call('skip_card_occurrence', { cardId, date: '2026-11-11' });
    const deleted = await call('delete_card', { cardId });
    expect(deleted.content.outcome).toBe('changed');
    expect(card(cardId)).toBeUndefined();
    expect(trigger(cardId)?.state).toBe('cancelled');

    asUser({ type: 'assistant.undo', changeId: deleted.content.change?.id ?? '' });
    expect(card(cardId)).toMatchObject({ repeat: weekdays, skippedDates: ['2026-11-11'] });
    expect(trigger(cardId)).toMatchObject({ state: 'scheduled', runAt: morning('2026-11-12') });
    expect(changes().at(-1)?.state).toBe('undone');
  });
});

describe('the instruction text (spec 19)', () => {
  it('says to make one repeating card for anything recurring and never a card per day', () => {
    expect(defaultAssistantInstructions).toMatch(/one repeating card/);
    expect(defaultAssistantInstructions).toMatch(/never a card per day/);
    expect(settingsRegistry['assistant.instructions'].default).toBe(defaultAssistantInstructions);
  });
});
