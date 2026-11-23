import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { threads } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import type { Engine } from './engine.js';

// Done threads not active for `chat.doneArchiveDays` days are archived on the scheduler's tick
// (chat overview spec 11), as "Archive thread" would. Pinned threads and workflow steps' threads
// are left; the filter and the palette still find what is archived, and Unarchive brings it back.

const oneDay = 86_400_000;

export interface ArchiveByAgeDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly clock: () => Date;
}

export function archiveDoneByAge(deps: ArchiveByAgeDeps): void {
  const days = deps.settings.get('chat.doneArchiveDays');
  if (days === 0) return;
  const before = deps.clock().getTime() - days * oneDay;
  const old = deps.db
    .select({ id: threads.id, updatedAt: threads.updatedAt, runId: threads.runId })
    .from(threads)
    .where(
      and(
        eq(threads.state, 'done'),
        eq(threads.archived, false),
        eq(threads.pinned, false),
        eq(threads.kind, 'chat'),
      ),
    )
    .all()
    .filter((thread) => thread.runId === null && Date.parse(thread.updatedAt) < before);
  for (const thread of old) {
    try {
      deps.engine.dispatch(`archive-by-age:${thread.id}:${thread.updatedAt}`, {
        type: 'thread.setArchived',
        threadId: thread.id,
        archived: true,
      });
    } catch (error) {
      deps.logger.warn('an old done thread was not archived', String(error));
    }
  }
}
