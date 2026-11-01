import type { Appointment, BridgeErrorCode, PingResult, UnreadMailResult } from './protocol.js';

export interface CalendarWindow {
  // Instants as ISO strings with an offset; the bridge converts them to Outlook's local time.
  readonly from: string;
  readonly to: string;
}

// Where the server reads Outlook from: the PowerShell COM bridge on Windows, fixtures elsewhere.
// Read-only apart from `open`, which only asks Outlook to show an item.
export interface OutlookSource {
  readonly kind: 'bridge' | 'mock';
  ping(): Promise<PingResult>;
  calendar(window: CalendarWindow): Promise<Appointment[]>;
  unreadMail(folders: readonly string[], limit: number): Promise<UnreadMailResult>;
  open(entryId: string): Promise<void>;
  close(): Promise<void>;
}

export type OutlookErrorCode = BridgeErrorCode | 'timeout' | 'exited' | 'protocol';

export class OutlookError extends Error {
  override readonly name = 'OutlookError';
  constructor(
    readonly code: OutlookErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// Timers go through this so tests drive time by hand instead of sleeping.
export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Off Windows, or with WOW_OUTLOOK=mock, the fixture-backed MockOutlookSource is used.
export function prefersMock(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): boolean {
  return platform !== 'win32' || env['WOW_OUTLOOK'] === 'mock';
}
