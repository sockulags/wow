import type { SettingDefinition, SettingGroup } from '@wow/contracts';
import { resolveSetting, validateSetting, type SettingsState } from '@wow/client-runtime';
import { Link, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useRuntime } from '@/app/runtime';
import { isSettingGroup, settingGroupTitles, settingsByGroup } from '@/app/sections';
import { fieldKind } from './field-kind';
import { Field } from './fields';

const formatDefault = (value: unknown): string =>
  typeof value === 'string' ? (value === '' ? '(none)' : value) : JSON.stringify(value);

function SettingRow({
  settingKey,
  definition,
}: {
  settingKey: string;
  definition: SettingDefinition;
}) {
  const { settings } = useRuntime();
  const values = useStore(settings, (state: SettingsState) => state.values);
  const kind = useMemo(() => fieldKind(definition.schema), [definition.schema]);
  const [draft, setDraft] = useState<{ value: unknown } | undefined>(undefined);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const id = `setting-${settingKey}`;
  const shown = draft ? draft.value : resolveSetting(settings.definitions, values, settingKey);
  const modified = settingKey in values;

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
      // Drop the draft only if the user has not typed something newer meanwhile.
      setDraft((current) => (current === draftBox ? undefined : current));
    });
  };

  const reset = () => {
    setDraft(undefined);
    setIssues([]);
    void settings.reset(settingKey);
  };

  return (
    <div
      data-testid={id}
      className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id}>{definition.label}</Label>
        {definition.restartRequired && <Badge variant="outline">Restart required</Badge>}
        {definition.secret && <Badge variant="outline">Secret</Badge>}
        {modified && (
          <Button variant="link" size="sm" className="ml-auto h-auto p-0 text-xs" onClick={reset}>
            Reset to default
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{definition.description}</p>
      <Field
        id={id}
        label={definition.label}
        kind={kind}
        value={shown}
        invalid={issues.length > 0}
        onChange={change}
      />
      {issues.length > 0 && (
        <ul role="alert" className="text-xs text-destructive">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <p className="font-mono text-[11px] text-muted-foreground">
        {settingKey} · default {formatDefault(definition.default)}
      </p>
    </div>
  );
}

export function SettingsForm({
  entries,
}: {
  entries: readonly (readonly [string, SettingDefinition])[];
}) {
  return (
    <div className="flex flex-col">
      {entries.map(([key, definition]) => (
        <SettingRow key={key} settingKey={key} definition={definition} />
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { group } = useParams({ from: '/settings/$group' });
  const { settings } = useRuntime();
  const groups = useMemo(() => settingsByGroup(settings.definitions), [settings.definitions]);
  const current: SettingGroup | undefined = isSettingGroup(group) ? group : undefined;
  const entries = current ? (groups.get(current) ?? []) : [];

  return (
    <div className="flex h-full">
      <nav aria-label="Settings groups" className="w-48 shrink-0 border-r border-border p-2">
        <ul className="flex flex-col gap-0.5">
          {[...groups.keys()].map((name) => (
            <li key={name}>
              <Link
                to="/settings/$group"
                params={{ group: name }}
                className="flex h-7 items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                activeProps={{
                  className: 'bg-accent text-accent-foreground font-medium',
                  'aria-current': 'page',
                }}
              >
                {settingGroupTitles[name]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section aria-labelledby="settings-title" className="min-w-0 flex-1 overflow-auto px-6 py-4">
        <h2 id="settings-title" className="text-base font-semibold">
          {current ? settingGroupTitles[current] : 'Settings'}
        </h2>
        {/* Remount per group so drafts never leak between pages. */}
        <SettingsForm key={group} entries={entries} />
      </section>
    </div>
  );
}
