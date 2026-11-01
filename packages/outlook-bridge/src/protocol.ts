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
});
export type Appointment = z.infer<typeof Appointment>;

export const UnreadMessage = z.object({
  entryId: z.string().min(1),
  folder: z.string(),
  from: z.string(),
  subject: z.string(),
  receivedAt: OffsetDateTime,
  snippet: z.string(),
});
export type UnreadMessage = z.infer<typeof UnreadMessage>;

export const BridgeErrorCode = z.enum(['unavailable', 'failed', 'bad_request']);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCode>;

export type BridgeRequest =
  | { op: 'ping' }
  | { op: 'calendar'; from: string; to: string }
  | { op: 'unreadMail'; folders: readonly string[]; limit: number }
  | { op: 'open'; entryId: string };

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

export const UnreadMailResult = z.object({
  items: listOf(UnreadMessage),
  unreadCount: z.number().int().nonnegative(),
});
export type UnreadMailResult = z.infer<typeof UnreadMailResult>;

export const OpenResult = z.object({ opened: z.literal(true) });

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
  unreadMail: UnreadMailResult,
  open: OpenResult,
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
