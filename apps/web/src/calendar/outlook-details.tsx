import type { CalendarItem } from '@wow/contracts';
import { ExternalLinkIcon, MapPinIcon, PlusIcon, UserIcon, VideoIcon } from 'lucide-react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/feedback';
import { meetingPlace, timeRange } from './items';
import { formatShortDay, localDate } from './time';

export interface NewCardRange {
  readonly start: string;
  readonly end: string;
}

// The read-only details of an Outlook meeting (audit B-05): when, where, who organizes it and the
// start of its body, with Join, "Open in Outlook" and a new card right before or after it.
// Nothing here changes Outlook.
export function OutlookDetails({
  item,
  zone,
  cardMinutes,
  onNewCard,
}: {
  item: CalendarItem;
  zone: string;
  cardMinutes: number;
  onNewCard: (range: NewCardRange) => void;
}) {
  const { connection } = useRuntime();
  const cancelled = item.state === 'cancelled';
  const place = meetingPlace(item.location, item.joinUrl);
  const length = cardMinutes * 60_000;
  const start = Date.parse(item.start);
  const end = Date.parse(item.end);
  const openInOutlook = () => {
    if (!connection || !item.externalId) return;
    connection.request('outlook.open', { entryId: item.externalId }).then(
      () => notify.success('Opened in Outlook', { description: item.title, id: 'outlook-open' }),
      (error: unknown) =>
        notify.error('Could not open the meeting in Outlook', {
          description: errorMessage(error),
          id: 'outlook-open',
        }),
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="outlook-details">
      <div className="flex flex-col gap-1">
        <h3 className={cancelled ? 'text-sm font-medium line-through' : 'text-sm font-medium'}>
          {item.title}
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {item.allDay
            ? `${formatShortDay(localDate(new Date(item.start), zone))}, all day`
            : `${formatShortDay(localDate(new Date(item.start), zone))}, ${timeRange(item, zone)}`}
          {cancelled ? ' · Cancelled' : ''}
        </p>
      </div>
      {(place || item.organizer) && (
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 text-xs">
          {place && (
            <>
              <dt>
                <MapPinIcon aria-label="Where" className="size-3.5 text-muted-foreground" />
              </dt>
              <dd className="min-w-0 truncate">{place}</dd>
            </>
          )}
          {item.organizer && (
            <>
              <dt>
                <UserIcon aria-label="Organizer" className="size-3.5 text-muted-foreground" />
              </dt>
              <dd className="min-w-0 truncate">{item.organizer}</dd>
            </>
          )}
        </dl>
      )}
      {item.body && <p className="line-clamp-4 text-xs text-muted-foreground">{item.body}</p>}
      <div className="flex flex-wrap gap-2">
        {item.joinUrl && !cancelled && (
          <Button asChild size="xs">
            <a href={item.joinUrl} target="_blank" rel="noreferrer">
              <VideoIcon />
              Join
            </a>
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={!connection || !item.externalId}
          onClick={openInOutlook}
        >
          <ExternalLinkIcon />
          Open in Outlook
        </Button>
      </div>
      {!item.allDay && (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onNewCard({
                start: new Date(start - length).toISOString(),
                end: new Date(start).toISOString(),
              })
            }
          >
            <PlusIcon />
            Card before
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onNewCard({
                start: new Date(end).toISOString(),
                end: new Date(end + length).toISOString(),
              })
            }
          >
            <PlusIcon />
            Card after
          </Button>
        </div>
      )}
    </div>
  );
}
