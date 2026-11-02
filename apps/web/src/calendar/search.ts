import type { CalendarViewKind } from './layout';
import { localDate, parseIsoDate, resolveZone, type LocalDate } from './time';

// What the calendar's URL holds, so a reload or a link shows the same range.
export interface CalendarSearch {
  readonly view?: CalendarViewKind;
  // YYYY-MM-DD; absent means today.
  readonly date?: string;
  // The card or meeting selected for the context panel (owner decision F-1).
  readonly item?: string;
}

export function validateCalendarSearch(search: Record<string, unknown>): CalendarSearch {
  const view = search['view'] === 'day' || search['view'] === 'week' ? search['view'] : undefined;
  const date =
    typeof search['date'] === 'string' && parseIsoDate(search['date']) ? search['date'] : undefined;
  const item =
    typeof search['item'] === 'string' && search['item'] !== '' ? search['item'] : undefined;
  return { ...(view ? { view } : {}), ...(date ? { date } : {}), ...(item ? { item } : {}) };
}

// Which day "today" is follows the configured zone, not the machine's.
export const todayIn = (zoneSetting: string): LocalDate =>
  localDate(new Date(), resolveZone(zoneSetting));

export const anchorDate = (search: CalendarSearch, zoneSetting: string): LocalDate =>
  (search.date === undefined ? undefined : parseIsoDate(search.date)) ?? todayIn(zoneSetting);
