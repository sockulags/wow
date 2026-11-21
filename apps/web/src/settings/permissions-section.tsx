import {
  AssistantPermission,
  AssistantPermissionKind,
  assistantPermissionDescriptions,
  assistantPermissionLabels,
  type Project,
  type Workflow,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { KeyRoundIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { useCalendarPrefs } from '@/calendar/prefs';
import { ChoiceSelect } from '@/components/choice-select';
import { DateField } from '@/components/date-time-fields';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

// Settings → Assistant → Permissions (chief of staff spec 4): what the assistant may do without
// asking while "Let the assistant act under its permissions" is on. The list is the
// `assistant.permissions` setting; adding, pausing and removing write it whole, as the user's.

const permissionsOf = (value: unknown): AssistantPermission[] => {
  const parsed = AssistantPermission.array().safeParse(value);
  return parsed.success ? parsed.data : [];
};

const withWorkflows = (kind: AssistantPermissionKind) =>
  kind === 'planRuns' || kind === 'startRuns';

const names = (ids: readonly string[], rows: readonly { id: string; name: string }[]) =>
  ids.map((id) => rows.find((row) => row.id === id)?.name ?? id).join(', ');

function Picks({
  legend,
  rows,
  picked,
  onChange,
}: {
  readonly legend: string;
  readonly rows: readonly { id: string; name: string }[];
  readonly picked: readonly string[];
  readonly onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <legend className="mb-1 text-xs font-medium">{legend}</legend>
      {rows.map((row) => {
        const id = `permission-${legend}-${row.id}`;
        return (
          <label key={row.id} htmlFor={id} className="flex items-center gap-1.5">
            <Checkbox
              id={id}
              checked={picked.includes(row.id)}
              onCheckedChange={(checked) =>
                onChange(
                  checked === true
                    ? [...picked, row.id]
                    : picked.filter((entry) => entry !== row.id),
                )
              }
            />
            {row.name}
          </label>
        );
      })}
    </fieldset>
  );
}

function AddPermission({
  projects,
  workflows,
  onAdd,
}: {
  readonly projects: readonly Project[];
  readonly workflows: readonly Workflow[];
  readonly onAdd: (permission: AssistantPermission) => void;
}) {
  const [kind, setKind] = useState<AssistantPermissionKind>('planRuns');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [workflowIds, setWorkflowIds] = useState<string[]>([]);
  const [mode, setMode] = useState('default');
  const [until, setUntil] = useState('');
  const [limit, setLimit] = useState('');
  const { firstDayOfWeek } = useCalendarPrefs();
  const limitNumber = limit.trim() === '' ? undefined : Number(limit);
  const ready =
    projectIds.length > 0 &&
    (!withWorkflows(kind) || workflowIds.length > 0) &&
    (limitNumber === undefined || (Number.isInteger(limitNumber) && limitNumber >= 1));
  return (
    <section
      aria-label="Add a permission"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceSelect
          id="permission-kind"
          label="Kind"
          value={kind}
          choices={AssistantPermissionKind.options.map((option) => ({
            value: option,
            label: assistantPermissionLabels[option],
          }))}
          onValueChange={(value) => setKind(AssistantPermissionKind.parse(value))}
        />
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {assistantPermissionDescriptions[kind]}
        </p>
      </div>
      <Picks legend="Projects" rows={projects} picked={projectIds} onChange={setProjectIds} />
      {withWorkflows(kind) && (
        <Picks legend="Workflows" rows={workflows} picked={workflowIds} onChange={setWorkflowIds} />
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {kind === 'startThreads' && (
          <label className="flex items-center gap-1.5">
            Widest permission mode
            <Input
              aria-label="Widest permission mode"
              className="h-7 w-32 text-xs"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            />
          </label>
        )}
        <span className="flex items-center gap-1.5">
          Until
          <DateField
            id="permission-until"
            label="Until"
            className="w-36"
            value={until}
            firstDayOfWeek={firstDayOfWeek}
            onValueChange={setUntil}
          />
        </span>
        <label className="flex items-center gap-1.5">
          Times a day
          <Input
            aria-label="Times a day"
            inputMode="numeric"
            placeholder="No limit"
            className="h-7 w-24 text-xs"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!ready}
          onClick={() =>
            onAdd({
              id: crypto.randomUUID(),
              kind,
              projectIds,
              workflowIds: withWorkflows(kind) ? workflowIds : [],
              ...(kind === 'startThreads' && mode.trim() ? { maxPermissionMode: mode.trim() } : {}),
              ...(until ? { until } : {}),
              ...(limitNumber === undefined ? {} : { dailyLimit: limitNumber }),
              paused: false,
              addedAt: new Date().toISOString(),
            })
          }
        >
          <PlusIcon aria-hidden />
          Add permission
        </Button>
      </div>
    </section>
  );
}

export function PermissionsSection() {
  const { connection } = useRuntime();
  const permissions = permissionsOf(useSetting('assistant.permissions'));
  const delegation = useSetting('assistant.delegation');
  const projects = useTopic('projects') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const [error, setError] = useState<string>();
  const write = async (next: AssistantPermission[]) => {
    if (!connection) return;
    setError(undefined);
    try {
      await dispatch(
        connection,
        next.length === 0
          ? { type: 'setting.reset', key: 'assistant.permissions', scope: 'global' }
          : { type: 'setting.set', key: 'assistant.permissions', scope: 'global', value: next },
      );
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const update = (id: string, change: Partial<AssistantPermission>) =>
    void write(permissions.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));
  return (
    <section
      aria-label="Permissions"
      className="mt-3 flex flex-col gap-2"
      data-testid="permissions-section"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Permissions</h3>
        <p className="text-xs text-muted-foreground">
          {delegation
            ? 'The assistant does what these cover without asking, and reports it.'
            : 'Off: the assistant asks first, whatever is listed. Turn on "Let the assistant act under its permissions" below.'}{' '}
          It never answers a gate or an approval.
        </p>
      </div>
      {permissions.length === 0 ? (
        <EmptyState compact icon={KeyRoundIcon} title="No permissions">
          The assistant asks before it starts or plans work.
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {permissions.map((permission) => (
            <li
              key={permission.id}
              data-testid="assistant-permission"
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-xs"
            >
              <span className="font-medium">{assistantPermissionLabels[permission.kind]}</span>
              <span className="min-w-0 flex-1 text-muted-foreground">
                {names(permission.projectIds, projects)}
                {permission.workflowIds.length > 0 &&
                  ` · ${names(permission.workflowIds, workflows)}`}
                {permission.maxPermissionMode && ` · at most ${permission.maxPermissionMode}`}
                {permission.until && ` · until ${permission.until}`}
                {permission.dailyLimit !== undefined && ` · ${permission.dailyLimit} a day`}
              </span>
              <label className="flex items-center gap-1.5">
                <Switch
                  aria-label={`Paused: ${assistantPermissionLabels[permission.kind]}`}
                  checked={permission.paused}
                  onCheckedChange={(paused) => update(permission.id, { paused })}
                />
                Paused
              </label>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Remove ${assistantPermissionLabels[permission.kind]}`}
                onClick={() =>
                  void write(permissions.filter((entry) => entry.id !== permission.id))
                }
              >
                <Trash2Icon aria-hidden />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AddPermission
        projects={projects}
        workflows={workflows}
        onAdd={(permission) => void write([...permissions, permission])}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
