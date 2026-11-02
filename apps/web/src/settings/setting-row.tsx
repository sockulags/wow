import type { SettingDefinition } from '@wow/contracts';
import { resolveSetting, validateSetting, type SettingsState } from '@wow/client-runtime';
import { RotateCcwIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { WithTooltip } from '@/components/hint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useRuntime, useSetting } from '@/app/runtime';
import type { SettingEntry } from '@/app/sections';
import { cn } from '@/lib/utils';
import { fieldKind } from './field-kind';
import { Field, readableValue } from './fields';
import { SecretField } from './secret-field';

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Raw default, only with advanced.showSettingKeys (owner decision F-11).
export const formatRawDefault = (value: unknown): string =>
  typeof value === 'string' ? (value === '' ? '(none)' : value) : JSON.stringify(value);

// One setting's value, draft and write; shared by the rows and the keybindings table.
export function useSettingField(settingKey: string, definition: SettingDefinition) {
  const { settings } = useRuntime();
  const values = useStore(settings, (state: SettingsState) => state.values);
  const [draft, setDraft] = useState<{ value: unknown } | undefined>(undefined);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [changed, setChanged] = useState(false);
  const shown = draft ? draft.value : resolveSetting(settings.definitions, values, settingKey);
  const differs = !sameValue(shown, definition.default);

  const change = (next: unknown) => {
    const draftBox = { value: next };
    setDraft(draftBox);
    const local = validateSetting(settings.definitions, settingKey, next);
    setIssues(local.ok ? [] : local.issues);
    if (!local.ok) return;
    void settings.write(settingKey, next).then((result) => {
      if (!result.ok) {
        setIssues(result.issues);
        return;
      }
      setChanged(true);
      // Drop the draft only if the user has not typed something newer meanwhile.
      setDraft((current) => (current === draftBox ? undefined : current));
    });
  };

  const reset = () => {
    setDraft(undefined);
    setIssues([]);
    setChanged(true);
    void settings.reset(settingKey);
  };

  return { shown, differs, issues, change, reset, changed };
}

export function ResetButton({
  definition,
  onReset,
}: {
  definition: SettingDefinition;
  onReset: () => void;
}) {
  const kind = fieldKind(definition.schema);
  return (
    <WithTooltip
      label={`Default: ${readableValue(definition.default, kind, definition.options, definition.unit)}`}
    >
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onReset}>
        <RotateCcwIcon />
        Reset to default
      </Button>
    </WithTooltip>
  );
}

const simpleKinds = new Set(['text', 'number', 'boolean', 'enum', 'keybinding']);

export function SettingRow({
  settingKey,
  definition,
}: {
  settingKey: string;
  definition: SettingDefinition;
}) {
  const { restartApp } = useRuntime();
  const showKeys = useSetting('advanced.showSettingKeys');
  const kind = useMemo(() => fieldKind(definition.schema), [definition.schema]);
  const { shown, differs, issues, change, reset, changed } = useSettingField(
    settingKey,
    definition,
  );
  const id = `setting-${settingKey}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const secret = definition.schema.meta()?.['widget'] === 'secret';
  // Radio groups, lists and objects have no single control a <label for> can point at.
  const group = !secret && (!simpleKinds.has(kind.kind) || definition.radio === true);
  const describedBy = [helpId, issues.length > 0 ? errorId : undefined].filter(Boolean).join(' ');

  return (
    <div
      data-testid={id}
      className={cn(
        'flex flex-col gap-1.5 border-b border-border py-4 last:border-b-0',
        // Wide screens: label and help on the left, the control on the right, for short values.
        simpleKinds.has(kind.kind) &&
          !definition.radio &&
          'xl:grid xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] xl:gap-x-6',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <Label id={`${id}-label`} htmlFor={group ? undefined : id}>
            {definition.label}
          </Label>
          {definition.restartRequired && <Badge variant="outline">Restart required</Badge>}
          {differs && !secret && (
            <div className="ml-auto">
              <ResetButton definition={definition} onReset={reset} />
            </div>
          )}
        </div>
        <p id={helpId} className="text-xs text-muted-foreground">
          {definition.description}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1" {...(group ? { 'aria-labelledby': `${id}-label` } : {})}>
            {secret ? (
              <SecretField
                id={id}
                label={definition.label}
                settingKey={settingKey}
                value={shown}
                describedBy={helpId}
              />
            ) : (
              <Field
                id={id}
                label={definition.label}
                kind={kind}
                value={shown}
                invalid={issues.length > 0}
                options={definition.options}
                unit={definition.unit}
                radio={definition.radio}
                aria-describedby={describedBy}
                onChange={change}
              />
            )}
          </div>
        </div>
        {issues.length > 0 && (
          <ul id={errorId} role="alert" className="text-xs text-destructive">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {definition.restartRequired && changed && restartApp && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            Takes effect after a restart.
            <Button size="xs" variant="outline" onClick={restartApp}>
              Restart now
            </Button>
          </div>
        )}
        {showKeys && (
          <p className="font-mono text-2xs text-muted-foreground">
            {settingKey} · default {formatRawDefault(definition.default)}
          </p>
        )}
      </div>
    </div>
  );
}

export function SettingsForm({ entries }: { entries: readonly SettingEntry[] }) {
  return (
    <div className="flex flex-col">
      {entries.map(([key, definition]) => (
        <SettingRow key={key} settingKey={key} definition={definition} />
      ))}
    </div>
  );
}
