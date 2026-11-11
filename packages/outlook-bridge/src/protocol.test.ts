import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CalendarResult, findJoinUrl, parseResponseLine, resultSchemas } from './protocol.js';
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
  body: null,
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

  // bridge.ps1 cannot run here, so its request switch is read as text: the script and the protocol
  // answer the same operations, and none of them reads anything but the calendar (spec 4).
  it('asks Outlook for calendar items only, in the protocol and in bridge.ps1', async () => {
    const script = await readFile(fileURLToPath(new URL('../bridge.ps1', import.meta.url)), 'utf8');
    const handled = [...script.matchAll(/^\s+'(\w+)' \{ Invoke-/gm)].map((match) => match[1]);
    const calendarOnly = ['ping', 'calendar', 'open', 'profile'];
    expect(handled).toEqual(calendarOnly);
    expect(Object.keys(resultSchemas)).toEqual(calendarOnly);
    // GetDefaultFolder(6) is the inbox; the calendar is folder 9.
    expect(script).not.toMatch(/GetDefaultFolder\(6\)|\[UnRead\]|ReceivedTime|SenderName/);
  });

  it('uses the mock off Windows or when asked', () => {
    expect(prefersMock('linux', {})).toBe(true);
    expect(prefersMock('win32', { WOW_OUTLOOK: 'mock' })).toBe(true);
    expect(prefersMock('win32', {})).toBe(false);
  });
});
