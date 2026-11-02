import {
  OutlookSync,
  createOutlookSource,
  type Clock,
  type OutlookFailure,
  type OutlookSnapshot,
  type OutlookSource,
  type SyncOutcome,
} from '@wow/outlook-bridge';
import { randomUUID } from 'node:crypto';
import type { BackgroundService, OutlookMode, ServiceContext } from '../hooks/index.js';

// Polls Outlook (the bridge on Windows, the mock elsewhere) and stores what it read through
// `outlook.sync` / `outlook.fail` commands, so the cache and the "unavailable" banner are
// projections like everything else. Only reads; `open` asks Outlook to show an item.

export interface OutlookService extends BackgroundService {
  readonly mode: OutlookMode;
  open(entryId: string): Promise<void>;
  // Polls now; resolves when the result is stored.
  refresh(): Promise<SyncOutcome>;
}

export interface OutlookServiceOptions {
  // A source to use instead of the one `mode` selects (tests, the Playwright server).
  readonly source?: OutlookSource;
  readonly clock?: Clock;
}

export function snapshotCommand(snapshot: OutlookSnapshot) {
  return {
    type: 'outlook.sync' as const,
    at: snapshot.at,
    window: snapshot.window,
    calendar: snapshot.calendar.map((entry) => ({
      id: entry.id,
      externalId: entry.externalId,
      title: entry.title,
      start: entry.start,
      end: entry.end,
      zone: entry.zone,
      allDay: entry.allDay,
      location: entry.location,
      joinUrl: entry.joinUrl,
      state: entry.state,
    })),
    mail: snapshot.mail.map((entry) => ({ ...entry })),
    unreadCount: snapshot.unreadCount,
    bridgeVersion: snapshot.bridgeVersion,
  };
}

export function failureCommand(failure: OutlookFailure) {
  return {
    type: 'outlook.fail' as const,
    at: failure.at,
    code: failure.code,
    message: failure.message,
    unavailableSince: failure.unavailableSince,
  };
}

export async function startOutlookService(
  mode: OutlookMode,
  context: ServiceContext,
  options: OutlookServiceOptions = {},
): Promise<OutlookService> {
  const { settings } = context;
  const source =
    options.source ??
    (await createOutlookSource(mode, {
      requestTimeoutMs: () => settings.get('outlook.requestTimeoutMs'),
      ...(options.clock ? { clock: options.clock } : {}),
    }));
  const sync = new OutlookSync({
    source,
    sink: {
      synced: (snapshot) => void context.dispatch(randomUUID(), snapshotCommand(snapshot)),
      failed: (failure) => void context.dispatch(randomUUID(), failureCommand(failure)),
    },
    settings: () => ({
      pollSeconds: settings.get('outlook.pollSeconds'),
      zone: settings.get('calendar.zone'),
      firstDayOfWeek: settings.get('calendar.firstDayOfWeek'),
      lookaheadDays: settings.get('calendar.lookaheadDays'),
      folders: settings.get('outlook.folders'),
      mailRail: settings.get('outlook.mailRail'),
      mailLimit: settings.get('outlook.mailLimit'),
    }),
    ...(options.clock ? { clock: options.clock } : {}),
    onError: (error) => context.logger.error('outlook sync failed', error),
  });
  sync.start();
  return {
    mode,
    open: (entryId) => source.open(entryId),
    refresh: async () => {
      // One poll at a time: a refresh waits for the poll in flight.
      await sync.whenIdle();
      return sync.syncOnce();
    },
    stop: () => sync.stop(),
  };
}
