import type { SettingDefinition } from '@wow/contracts';
import { resolveSetting, type SettingsState } from '@wow/client-runtime';
import { useStore } from 'zustand';
import { useRuntime, useSetting } from '@/app/runtime';
import { normalizeBinding } from '@/app/keybindings';
import type { SettingEntry } from '@/app/sections';
import { KeybindingField } from './fields';
import { ResetButton, formatRawDefault, useSettingField } from './setting-row';

// Where a shortcut works. Calendar keys only fire while the calendar is open, chat keys while a
// thread is open (the composer's only while the composer has the focus), the side panel's tab
// keys while the focus is in the panel, diff keys while a line of a diff has the focus, the rule
// keys only in the workflow builder; everything else is global.
export type KeyScope = 'General' | 'Calendar' | 'Chat' | 'Panel' | 'Workflows' | 'Diff';

// Keys of the open thread's conversation (agent workbench spec 74, 88): they share keys with the
// builder's rule keys, which never fire in chat.
const conversationKeys = new Set([
  'toggleReasoning',
  'previousMessage',
  'nextMessage',
  'copyMessage',
  'editMessage',
  'forkMessage',
  'conversationEnd',
  'findInConversation',
  'findNext',
  'findPrevious',
]);

export function keyScope(settingKey: string): KeyScope {
  const name = settingKey.replace(/^keybindings\./, '');
  if (name.startsWith('calendar') || name === 'newCard') return 'Calendar';
  if (
    name === 'stopTurn' ||
    name === 'toBackground' ||
    name.startsWith('composer') ||
    conversationKeys.has(name)
  ) {
    return 'Chat';
  }
  if (name.startsWith('panel')) return 'Panel';
  if (name.startsWith('rule')) return 'Workflows';
  if (name.startsWith('diff')) return 'Diff';
  return 'General';
}

const overlaps = (a: KeyScope, b: KeyScope) => a === b || a === 'General' || b === 'General';

// For each shortcut, the other commands bound to the same keys where both can fire (audit E-11).
export function keyConflicts(
  bindings: Readonly<Record<string, string>>,
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  const entries = Object.entries(bindings).filter(([, binding]) => binding !== '');
  for (const [key, binding] of entries) {
    const normalized = normalizeBinding(binding);
    const others = entries
      .filter(
        ([other, otherBinding]) =>
          other !== key &&
          normalizeBinding(otherBinding) === normalized &&
          overlaps(keyScope(key), keyScope(other)),
      )
      .map(([other]) => other);
    if (others.length > 0) result.set(key, others);
  }
  return result;
}

function KeybindingRow({
  settingKey,
  definition,
  conflicts,
  labels,
}: {
  settingKey: string;
  definition: SettingDefinition;
  conflicts: readonly string[];
  labels: Readonly<Record<string, string>>;
}) {
  const showKeys = useSetting('advanced.showSettingKeys');
  const { shown, differs, issues, change, reset } = useSettingField(settingKey, definition);
  const id = `setting-${settingKey}`;
  return (
    <div
      data-testid={id}
      role="row"
      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 border-b border-border py-2.5 last:border-b-0"
    >
      <div role="rowheader" className="flex min-w-0 flex-col gap-0.5">
        <span id={`${id}-label`} className="text-sm font-medium">
          {definition.label}
        </span>
        <span id={`${id}-help`} className="text-xs text-muted-foreground">
          {definition.description}
        </span>
        {conflicts.length > 0 && (
          <span role="alert" className="text-xs text-destructive">
            Also used by {conflicts.map((other) => labels[other] ?? other).join(', ')}.
          </span>
        )}
        {issues.length > 0 && (
          <span role="alert" className="text-xs text-destructive">
            {issues.join(' ')}
          </span>
        )}
        {showKeys && (
          <span className="font-mono text-2xs text-muted-foreground">
            {settingKey} · default {formatRawDefault(definition.default)}
          </span>
        )}
      </div>
      <div role="cell">
        <KeybindingField
          id={id}
          label={definition.label}
          value={shown}
          invalid={issues.length > 0 || conflicts.length > 0}
          aria-describedby={`${id}-help`}
          onChange={change}
        />
      </div>
      <div role="cell" className="w-36 text-right">
        {differs && <ResetButton definition={definition} onReset={reset} />}
      </div>
    </div>
  );
}

// Settings → Keybindings: a table grouped by where each key works, with conflicts marked.
export function KeybindingsTable({ entries }: { entries: readonly SettingEntry[] }) {
  const { settings } = useRuntime();
  const values = useStore(settings, (state: SettingsState) => state.values);
  const bindings: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const [key, definition] of entries) {
    const value = resolveSetting(settings.definitions, values, key);
    bindings[key] = typeof value === 'string' ? value : '';
    labels[key] = definition.label;
  }
  const conflicts = keyConflicts(bindings);
  const scopes: KeyScope[] = ['General', 'Calendar', 'Chat', 'Workflows', 'Panel', 'Diff'];
  return (
    <div className="mt-4 flex flex-col gap-6">
      {scopes.map((scope) => {
        const rows = entries.filter(([key]) => keyScope(key) === scope);
        if (rows.length === 0) return null;
        return (
          <section key={scope} aria-label={scope}>
            <h3 className="text-xs font-medium text-muted-foreground">
              {scope === 'General'
                ? 'Everywhere'
                : scope === 'Panel'
                  ? 'In the side panel'
                  : scope === 'Workflows'
                    ? 'In the workflow builder'
                    : scope === 'Diff'
                      ? 'On a diff line'
                      : `In ${scope.toLowerCase()}`}
            </h3>
            <div role="table" aria-label={`${scope} shortcuts`}>
              <div role="rowgroup">
                {rows.map(([key, definition]) => (
                  <KeybindingRow
                    key={key}
                    settingKey={key}
                    definition={definition}
                    conflicts={conflicts.get(key) ?? []}
                    labels={labels}
                  />
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
