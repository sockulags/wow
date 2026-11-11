import { RepeatRule, repeatRuleWords } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  firstAfter,
  instantOf,
  localDay,
  occurrenceOn,
  occurrences,
  occurrencesIn,
  type Series,
} from './occurrences.js';

// Recurring cards spec 1 to 3: occurrences in the card's zone, across daylight saving changes
// and month ends, with intervals and both kinds of end. The platform's zone data decides the
// offsets; the expected instants below are what Stockholm's clocks say.

const rule = (input: Partial<RepeatRule> & Pick<RepeatRule, 'frequency'>): RepeatRule =>
  RepeatRule.parse(input);

const take = (series: Series, count: number) => {
  const found = [];
  for (const occurrence of occurrences(series)) {
    found.push(occurrence);
    if (found.length === count) break;
  }
  return found;
};

const stockholm = 'Europe/Stockholm';
const localTime = (instant: string, zone = stockholm) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(instant));
const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

describe('weekdays at 08:30 in Europe/Stockholm across daylight saving (spec 1, 2)', () => {
  // Wednesday 25 March 2026 at 08:30 CET; clocks go forward on Sunday 29 March.
  const spring: Series = {
    start: '2026-03-25T07:30:00.000Z',
    end: '2026-03-25T08:00:00.000Z',
    zone: stockholm,
    repeat: rule({ frequency: 'weekly', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] }),
  };

  it('falls on every weekday at 08:30 local time before and after clocks go forward', () => {
    const found = take(spring, 10);
    expect(found.map((occurrence) => occurrence.date)).toEqual([
      '2026-03-25',
      '2026-03-26',
      '2026-03-27',
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-06',
      '2026-04-07',
    ]);
    expect(found.map((occurrence) => weekday(occurrence.date))).not.toContain('Sat');
    expect(found.map((occurrence) => weekday(occurrence.date))).not.toContain('Sun');
    for (const occurrence of found) {
      expect(localTime(occurrence.start)).toBe('08:30');
      expect(localTime(occurrence.end)).toBe('09:00');
    }
    // The offset moved from +01:00 to +02:00, so the instant moved an hour.
    expect(found[2]?.start).toBe('2026-03-27T07:30:00.000Z');
    expect(found[3]?.start).toBe('2026-03-30T06:30:00.000Z');
  });

  it('stays at 08:30 when clocks go back in October', () => {
    const autumn: Series = {
      ...spring,
      start: '2026-10-21T06:30:00.000Z',
      end: '2026-10-21T07:00:00.000Z',
    };
    const found = take(autumn, 6);
    expect(found.map((occurrence) => occurrence.date)).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
    ]);
    for (const occurrence of found) expect(localTime(occurrence.start)).toBe('08:30');
    expect(found[2]?.start).toBe('2026-10-23T06:30:00.000Z');
    expect(found[3]?.start).toBe('2026-10-26T07:30:00.000Z');
  });

  it('starts on a Wednesday and counts that start as the first occurrence', () => {
    expect(take(spring, 1)[0]).toEqual({
      date: '2026-03-25',
      start: spring.start,
      end: spring.end,
    });
  });
});

describe('local times that do not exist or happen twice (spec 2)', () => {
  it('moves a time in the skipped hour to the first time after it that exists', () => {
    // 02:30 on 29 March 2026 does not exist in Stockholm: the clocks jump from 02:00 to 03:00.
    const instant = instantOf(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
      stockholm,
    );
    expect(new Date(instant).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(localTime(new Date(instant).toISOString())).toBe('03:00');
  });

  it('uses the first of a time that happens twice', () => {
    // 02:30 on 25 October 2026 happens at +02:00 and again at +01:00.
    const instant = instantOf(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
      stockholm,
    );
    expect(new Date(instant).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('runs a daily 02:30 card at 03:00 on the day clocks go forward', () => {
    const daily: Series = {
      start: '2026-03-28T01:30:00.000Z',
      end: '2026-03-28T02:00:00.000Z',
      zone: stockholm,
      repeat: rule({ frequency: 'daily' }),
    };
    const [, sunday, monday] = take(daily, 3);
    expect(sunday).toMatchObject({ date: '2026-03-29', start: '2026-03-29T01:00:00.000Z' });
    expect(monday).toMatchObject({ date: '2026-03-30', start: '2026-03-30T00:30:00.000Z' });
  });
});

describe('monthly, intervals and ends (spec 1, 3)', () => {
  const monthly: Series = {
    start: '2026-01-31T08:00:00.000Z',
    end: '2026-01-31T09:00:00.000Z',
    zone: stockholm,
    repeat: rule({ frequency: 'monthly' }),
  };

  it('has no occurrence in a month without the 31st', () => {
    expect(take(monthly, 7).map((occurrence) => occurrence.date)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
      '2026-12-31',
    ]);
  });

  it('keeps the local time across daylight saving in a monthly series', () => {
    for (const occurrence of take(monthly, 7)) expect(localTime(occurrence.start)).toBe('09:00');
  });

  it('falls on every second period with an interval of two', () => {
    const everyOther: Series = { ...monthly, repeat: rule({ frequency: 'monthly', interval: 2 }) };
    expect(take(everyOther, 4).map((occurrence) => occurrence.date)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ]);
    const fortnightly: Series = {
      start: '2026-11-02T08:00:00.000Z',
      end: '2026-11-02T08:30:00.000Z',
      zone: stockholm,
      repeat: rule({ frequency: 'weekly', interval: 2, weekdays: ['mon', 'thu'] }),
    };
    expect(take(fortnightly, 5).map((occurrence) => occurrence.date)).toEqual([
      '2026-11-02',
      '2026-11-05',
      '2026-11-16',
      '2026-11-19',
      '2026-11-30',
    ]);
    const everyThirdDay: Series = {
      ...fortnightly,
      repeat: rule({ frequency: 'daily', interval: 3 }),
    };
    expect(take(everyThirdDay, 3).map((occurrence) => occurrence.date)).toEqual([
      '2026-11-02',
      '2026-11-05',
      '2026-11-08',
    ]);
  });

  it('ends after a count, the first occurrence included', () => {
    const counted: Series = {
      ...monthly,
      repeat: rule({ frequency: 'monthly', end: { kind: 'after', count: 3 } }),
    };
    expect([...occurrences(counted)].map((occurrence) => occurrence.date)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
  });

  it('ends on a date, inclusive', () => {
    const dated: Series = {
      start: '2026-11-02T08:00:00.000Z',
      end: '2026-11-02T08:30:00.000Z',
      zone: stockholm,
      repeat: rule({ frequency: 'daily', end: { kind: 'on', date: '2026-11-05' } }),
    };
    expect([...occurrences(dated)].map((occurrence) => occurrence.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(firstAfter(dated, Date.parse('2026-11-05T09:00:00.000Z'))).toBeUndefined();
  });
});

describe('reading a series', () => {
  const daily: Series = {
    start: '2026-11-02T08:00:00.000Z',
    end: '2026-11-02T08:30:00.000Z',
    zone: stockholm,
    repeat: rule({ frequency: 'daily' }),
  };

  it('returns at most the limit in a range and says there were more', () => {
    const from = Date.parse('2026-11-01T00:00:00.000Z');
    const to = Date.parse('2026-12-01T00:00:00.000Z');
    expect(occurrencesIn(daily, from, to, 100).found).toHaveLength(29);
    const limited = occurrencesIn(daily, from, to, 10);
    expect(limited.found).toHaveLength(10);
    expect(limited.more).toBe(true);
  });

  it('finds the occurrence on a day and the next one after an instant', () => {
    expect(occurrenceOn(daily, '2026-11-04')?.start).toBe('2026-11-04T08:00:00.000Z');
    expect(occurrenceOn(daily, '2026-11-01')).toBeUndefined();
    expect(firstAfter(daily, Date.parse('2026-11-04T08:00:00.000Z'))?.date).toBe('2026-11-05');
    expect(
      firstAfter(daily, Date.parse('2026-11-03T00:00:00.000Z'), (o) => o.date !== '2026-11-03')
        ?.date,
    ).toBe('2026-11-04');
    expect(localDay('2026-11-02T23:30:00.000Z', stockholm)).toBe('2026-11-03');
  });
});

describe('the rule in words', () => {
  it('says the days, the time in the zone and the end', () => {
    const card = { start: '2026-11-04T07:30:00.000Z', zone: stockholm };
    expect(
      repeatRuleWords(
        rule({
          frequency: 'weekly',
          weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
          end: { kind: 'on', date: '2026-12-19' },
        }),
        card,
      ),
    ).toBe('Every weekday at 08:30, until 19 December 2026');
    expect(repeatRuleWords(rule({ frequency: 'weekly', interval: 2 }), card)).toBe(
      'Every 2 weeks on Wednesday at 08:30',
    );
    expect(
      repeatRuleWords(rule({ frequency: 'monthly', end: { kind: 'after', count: 6 } }), card),
    ).toBe('Every month on the 4th at 08:30, 6 times');
    expect(repeatRuleWords(rule({ frequency: 'daily' }))).toBe('Every day');
  });

  it('refuses weekdays on a rule that is not weekly', () => {
    expect(RepeatRule.safeParse({ frequency: 'daily', weekdays: ['mon'] }).success).toBe(false);
  });
});
