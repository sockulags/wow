import { settingValue } from '@wow/client-runtime';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { calendarCommands } from '@/calendar/commands';
import { validateCalendarSearch } from '@/calendar/search';
import { chatCommands } from '@/chat/commands';
import { useTopic } from '@/chat/data';
import { runningTurn } from '@/chat/model';
import { providerCommands } from '@/providers/commands';
import { buildCommands, type AppCommand, type CommandContext } from './commands';
import { eventToBinding, hasCommandModifier, normalizeBinding } from './keybindings';
import { useRuntime } from './runtime';

export function useCommands(): {
  readonly commands: readonly AppCommand[];
  readonly context: CommandContext;
} {
  const { settings, layout, draft, connection } = useRuntime();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const locationSearch = useRouterState({ select: (state) => state.location.search });
  const openThreadId = /^\/chat\/(?!new$)([^/]+)$/.exec(pathname)?.[1];
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances');
  const turns = useTopic('turns', openThreadId);
  const calendarItems = useTopic('calendarItems');
  const calendarSearch = useMemo(
    () => (pathname === '/calendar' ? validateCalendarSearch(locationSearch) : undefined),
    [pathname, locationSearch],
  );
  const staticCommands = useMemo(() => buildCommands(), []);
  const commands = useMemo(
    () => [
      ...calendarCommands({
        search: calendarSearch,
        cards: (calendarItems ?? []).filter((item) => item.source === 'local'),
      }),
      ...chatCommands({
        threads: threads ?? [],
        instances: instances ?? [],
        openThread: threads?.find((thread) => thread.id === openThreadId),
        running: runningTurn(turns ?? []) !== undefined,
      }),
      ...providerCommands(instances ?? []),
      ...staticCommands,
    ],
    [staticCommands, threads, instances, turns, openThreadId, calendarItems, calendarSearch],
  );
  const context = useMemo(
    () => ({ navigate, settings, layout, draft, connection }),
    [navigate, settings, layout, draft, connection],
  );
  return { commands, context };
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

// Applies the keybindings settings. Bindings are read at key time, so a change on the settings page
// takes effect on the next key press.
export function useGlobalKeybindings(
  commands: readonly AppCommand[],
  context: CommandContext,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const pressed = eventToBinding(event);
      if (!pressed) return;
      const { values } = context.settings.getState();
      const command = commands.find((candidate) => {
        if (!candidate.keybinding) return false;
        const binding = settingValue(values, candidate.keybinding);
        return (
          typeof binding === 'string' && binding !== '' && normalizeBinding(binding) === pressed
        );
      });
      if (!command) return;
      // Plain keys stay with text fields; shortcuts with Ctrl, Alt or Cmd work everywhere.
      if (isEditable(event.target) && !hasCommandModifier(pressed)) return;
      event.preventDefault();
      command.run(context);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commands, context]);
}
