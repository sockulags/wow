import { Link, Outlet } from '@tanstack/react-router';
import { MessagesSquareIcon, PlusIcon } from 'lucide-react';
import { useConnectionState } from '@/app/runtime';
import { ShortcutHint } from '@/components/hint';
import { DisconnectedState, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useTopic } from './data';

// The chat area. The thread list is the app's left side (orchestrator threads spec 30), so this
// holds the open thread, a new one, or a hint to pick one.
export function ChatLayout() {
  const { configured } = useConnectionState();
  if (!configured) return <DisconnectedState offline />;
  return (
    <div className="h-full min-h-0 min-w-0">
      <Outlet />
    </div>
  );
}

export function ChatHome() {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances');
  const any = threads !== undefined && threads.length > 0;
  if (instances !== undefined && instances.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquareIcon}
        title="Set up a provider to start a thread"
        description="wow runs Claude Code and Codex on your machine. Add an instance and test it first."
        action={
          <Button asChild size="sm">
            <Link to="/settings/$group" params={{ group: 'providers' }}>
              Set up a provider
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={MessagesSquareIcon}
      title={any ? 'Pick a thread' : 'No threads yet'}
      description={
        any
          ? 'Pick a thread from the list, or start a new one.'
          : 'Start a thread to give an agent a task in one of your projects.'
      }
      action={
        <Button asChild size="sm">
          <Link to="/chat/new">
            <PlusIcon />
            New thread
            <ShortcutHint shortcut="keybindings.newThread" />
          </Link>
        </Button>
      }
    />
  );
}
