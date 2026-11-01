import { describe, expect, it } from 'vitest';
import { CalendarResult, UnreadMailResult, findJoinUrl, parseResponseLine } from './protocol.js';
import { prefersMock } from './source.js';

const appointment = {
  entryId: '00000000ABCD',
  subject: 'Team standup',
  // [DateTimeOffset].ToString('o') writes seven fraction digits and the local offset.
  start: '2026-11-02T09:15:00.0000000+01:00',
  end: '2026-11-02T09:30:00.0000000+01:00',
  location: null,
  isAllDay: false,
  isRecurring: true,
  isCancelled: false,
  organizer: 'Ada Lindqvist',
  joinUrl: null,
  busyStatus: 2,
};

describe('bridge protocol', () => {
  it('parses results and errors and ignores lines that are not responses', () => {
    expect(parseResponseLine('{"id":1,"result":{"version":"1","outlook":"available"}}')).toEqual({
      id: 1,
      result: { version: '1', outlook: 'available' },
    });
    expect(
      parseResponseLine(
        '{"id":2,"error":{"code":"unavailable","message":"Outlook is not running"}}',
      ),
    ).toEqual({ id: 2, error: { code: 'unavailable', message: 'Outlook is not running' } });
    expect(parseResponseLine('WARNING: something from the profile')).toBeNull();
    expect(parseResponseLine('{"id":null,"error":{"code":"failed","message":"x"}}')).toBeNull();
  });

  it('accepts PowerShell timestamps and a single item where a list is expected', () => {
    expect(CalendarResult.parse({ items: [appointment] }).items).toHaveLength(1);
    expect(CalendarResult.parse({ items: appointment }).items).toEqual([appointment]);
    expect(CalendarResult.parse({ items: [] }).items).toEqual([]);
    expect(
      CalendarResult.safeParse({ items: [{ ...appointment, start: '2026-11-02 09:15' }] }).success,
    ).toBe(false);
    expect(UnreadMailResult.safeParse({ items: [], unreadCount: -1 }).success).toBe(false);
  });

  it('finds a Teams link in the body before the location', () => {
    const body =
      'Agenda\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_a%40thread.v2/0 \n';
    expect(findJoinUrl(body, 'Room 1')).toBe(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_a%40thread.v2/0',
    );
    expect(findJoinUrl(null, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_b')).toBe(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_b',
    );
    expect(findJoinUrl('see https://example.com/meet', 'Room 1')).toBeNull();
  });

  it('uses the mock off Windows or when asked', () => {
    expect(prefersMock('linux', {})).toBe(true);
    expect(prefersMock('win32', { WOW_OUTLOOK: 'mock' })).toBe(true);
    expect(prefersMock('win32', {})).toBe(false);
  });
});
