import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { projects, threadItems, threads } from '../db/schema.js';

// The thread list's filter and the palette (agent workbench spec 66, 69): a thread matches when
// every typed word is in its title, its project's name or the text of one of its messages.
// Archived threads are found too. Message text is searched in SQLite with LIKE, so a long
// history is not loaded into memory; LIKE ignores case for ASCII letters only.

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export function searchThreads(db: Db, query: string): string[] {
  const typed = words(query);
  const rows = db
    .select({ id: threads.id, title: threads.title, projectName: projects.name })
    .from(threads)
    .leftJoin(projects, eq(projects.id, threads.projectId))
    .where(ne(threads.kind, 'assistant'))
    .orderBy(desc(threads.updatedAt))
    .all();
  if (typed.length === 0) return rows.map((row) => row.id);
  let candidates = rows;
  for (const word of typed) {
    const named = (row: (typeof rows)[number]) =>
      row.title.toLowerCase().includes(word) ||
      (row.projectName ?? '').toLowerCase().includes(word);
    const rest = candidates.filter((row) => !named(row)).map((row) => row.id);
    const inMessages =
      rest.length === 0
        ? new Set<string>()
        : new Set(
            db
              .selectDistinct({ threadId: threadItems.threadId })
              .from(threadItems)
              .where(
                and(
                  inArray(threadItems.threadId, rest),
                  inArray(threadItems.kind, ['user', 'assistant_text']),
                  sql`json_extract(${threadItems.payload}, '$.text') like ${likePattern(word)} escape '\\'`,
                ),
              )
              .all()
              .map((row) => row.threadId),
          );
    candidates = candidates.filter((row) => named(row) || inMessages.has(row.id));
    if (candidates.length === 0) break;
  }
  return candidates.map((row) => row.id);
}
