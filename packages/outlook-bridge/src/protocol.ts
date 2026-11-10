import { z } from 'zod';

// The JSON-lines protocol spoken by bridge.ps1 on stdin/stdout. It never leaves the server, so the
// schemas live here rather than in @wow/contracts. MockOutlookSource answers with the same shapes.

export const BRIDGE_PROTOCOL_VERSION = '1';

// A date with an explicit offset or Z, as written by [DateTimeOffset].ToString('o').
const OffsetDateTime = z.iso.datetime({ offset: true, local: false });

export const Appointment = z.object({
  entryId: z.string().min(1),
  subject: z.string(),
  start: OffsetDateTime,
  end: OffsetDateTime,
  location: z.string().nullable(),
  isAllDay: z.boolean(),
  isRecurring: z.boolean(),
  // Outlook keeps a cancelled meeting in the calendar (MeetingStatus olMeetingCanceled) until the
  // attendee removes it.
  isCancelled: z.boolean(),
  organizer: z.string().nullable(),
  joinUrl: z.string().nullable(),
  busyStatus: z.number().int().nullable(),
  // The plain-text body, cut at $BodyChars in bridge.ps1; `bodySnippet` makes the details line.
  body: z.string().nullable().default(null),
});
export type Appointment = z.infer<typeof Appointment>;

export const BridgeErrorCode = z.enum(['unavailable', 'failed', 'bad_request']);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCode>;

export type BridgeRequest =
  | { op: 'ping' }
  | { op: 'calendar'; from: string; to: string }
  | { op: 'open'; entryId: string }
  | { op: 'profile' };

export const PingResult = z.object({
  version: z.string().min(1),
  outlook: z.enum(['available', 'unavailable']),
  message: z.string().nullable().optional(),
});
export type PingResult = z.infer<typeof PingResult>;

// Windows PowerShell 5.1 turns a one-element array into a bare object in some pipelines, so lists
// accept either.
const listOf = <T extends z.ZodType>(item: T) =>
  z.union([z.array(item), item.transform((one) => [one])]);

export const CalendarResult = z.object({ items: listOf(Appointment) });
export type CalendarResult = z.infer<typeof CalendarResult>;

export const OpenResult = z.object({ opened: z.literal(true) });

// What Outlook knows about the user's calendar, as Outlook stores it. `profile.ts` turns it into
// the OutlookProfile the calendar settings default to. Every part is null when it cannot be read.
export const ProfileResult = z.object({
  // Windows time zone id of Outlook's calendar, such as "W. Europe Standard Time".
  timeZoneId: z.string().nullable(),
  // The calendar folder's IPM.Configuration.WorkHours roaming XML.
  workHoursXml: z.string().nullable(),
  // .NET DayOfWeek of the user's region: 0 is Sunday.
  firstDayOfWeek: z.number().int().min(0).max(6).nullable(),
  address: z.string().nullable(),
});
export type ProfileResult = z.infer<typeof ProfileResult>;

export const BridgeResponse = z.union([
  z.object({
    id: z.number().int(),
    error: z.object({ code: BridgeErrorCode, message: z.string() }),
  }),
  z.object({ id: z.number().int(), result: z.unknown() }),
]);
export type BridgeResponse = z.infer<typeof BridgeResponse>;

export const resultSchemas = {
  ping: PingResult,
  calendar: CalendarResult,
  open: OpenResult,
  profile: ProfileResult,
} as const;

export type BridgeOp = BridgeRequest['op'];
export type BridgeResult<Op extends BridgeOp> = z.output<(typeof resultSchemas)[Op]>;

export function parseResponseLine(line: string): BridgeResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = BridgeResponse.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const TEAMS_LINK = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+/i;

// Same rule as Find-JoinUrl in bridge.ps1: the body first, then the location.
export function findJoinUrl(body: string | null, location: string | null): string | null {
  for (const text of [body, location]) {
    const match = text ? TEAMS_LINK.exec(text) : null;
    if (match) return match[0];
  }
  return null;
}

// Longest meeting snippet kept for the calendar's details popover.
const SNIPPET_CHARS = 240;
const TEAMS_SEPARATOR = /\n\s*_{8,}/;

// The part of a meeting body worth showing: the text before the Teams invitation block (which
// starts with a line of underscores), without links, on one line.
export function bodySnippet(body: string | null): string | null {
  if (!body) return null;
  const text = (body.split(TEAMS_SEPARATOR)[0] ?? '')
    .replace(/<?https?:\/\/\S+>?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A label such as "Join:" left without the link it introduced.
    .replace(/\s*\S+:$/, '');
  if (text === '') return null;
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : text;
}
