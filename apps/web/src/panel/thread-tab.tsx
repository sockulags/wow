import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, MessagesSquareIcon } from 'lucide-react';
import type { ViewerThread } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { ThreadConversation } from '@/chat/thread-view';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';

// Another thread in a tab of the side panel (parallel threads spec 15 to 17): its conversation,
// cards and composer as a step's thread shows them there, with "Open thread" for everything the
// main view has besides (find, export, restore, fork, edit).
export function ThreadTab({ thread: shown }: { readonly thread: ViewerThread }) {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const thread = threads?.find((candidate) => candidate.id === shown.threadId);
  if (threads !== undefined && !thread) {
    return (
      <EmptyState
        compact
        icon={MessagesSquareIcon}
        title="This thread is gone"
        description="It was deleted with its run or project. Close the tab."
      />
    );
  }
  if (!thread) return null;
  const instance = instances.find((candidate) => candidate.id === thread.providerInstanceId);
  return (
    <section
      aria-label={`Thread ${thread.title}`}
      data-testid="panel-thread-tab"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{thread.title}</span>
        <Button asChild size="xs" variant="ghost">
          <Link to="/chat/$threadId" params={{ threadId: thread.id }}>
            <ExternalLinkIcon aria-hidden />
            Open thread
          </Link>
        </Button>
      </div>
      <ThreadConversation key={thread.id} thread={thread} instance={instance} compact />
    </section>
  );
}
