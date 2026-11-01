import { settingValue } from '@wow/client-runtime';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { buildCommands, type AppCommand, type CommandContext } from './commands';
import { eventToBinding, hasCommandModifier, normalizeBinding } from './keybindings';
import { useRuntime } from './runtime';

export function useCommands(): {
  readonly commands: readonly AppCommand[];
  readonly context: CommandContext;
} {
  const { settings, layout } = useRuntime();
  const navigate = useNavigate();
  const commands = useMemo(() => buildCommands(), []);
  const context = useMemo(() => ({ navigate, settings, layout }), [navigate, settings, layout]);
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
