import type { PlanFile, PlanIntent, PlanUnit } from '@wow/contracts';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MapIcon,
  RefreshCwIcon,
  SearchXIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useConnectionState, useRuntime, useSetting } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { errorMessage, useTopic } from '@/chat/data';
import { Markdown } from '@/components/markdown';
import { DisconnectedState, EmptyState, Stale, TopicPlaceholder } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { cn } from '@/lib/utils';
import {
  fileNames,
  plansByProject,
  problemLabel,
  revisionLabel,
  staleLabel,
  unitStatusLabels,
} from './model';

// Reads the plan files again (`plans.refresh`). The watcher normally keeps the view current; this
// is for what it cannot see, such as a project folder that did not exist when the plans were read.
function RefreshButton() {
  const { connection } = useRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = async () => {
    if (!connection) return;
    setBusy(true);
    setError(undefined);
    try {
      await connection.request('plans.refresh', {});
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start"
        disabled={busy}
        onClick={() => void refresh()}
      >
        <RefreshCwIcon />
        Refresh now
      </Button>
      {error && (
        <p role="alert" className="px-2 text-2xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function IntentRow({ intent }: { intent: PlanIntent }) {
  const stale = intent.spec?.stale || intent.plan?.stale;
  return (
    <Link
      to="/plans/$projectId/$intentId"
      params={{ projectId: intent.projectId, intentId: intent.intentId }}
      className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
      activeProps={{ className: 'bg-sidebar-accent', 'aria-current': 'page' }}
    >
      <span className="line-clamp-2">{intent.title}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
        <span>{revisionLabel(intent.status, intent.rev)}</span>
        <span>· {intent.spec ? 'spec' : 'no spec'}</span>
        <span>· {intent.plan ? 'plan' : 'no plan'}</span>
        {stale && <span className="text-warning">· stale</span>}
        {intent.problems.length > 0 && (
          <span className="text-destructive">
            · {intent.problems.length} {intent.problems.length === 1 ? 'problem' : 'problems'}
          </span>
        )}
      </span>
    </Link>
  );
}

function IntentList() {
  const { rows: intents, status } = useTopicState('planIntents');
  const projects = useTopic('projects');
  const directory = useSetting('plans.intentsDirectory');
  return (
    <nav
      aria-label="Plans"
      className="flex w-72 shrink-0 flex-col border-r border-border bg-sidebar/50"
    >
      <div className="flex min-h-10 shrink-0 flex-col justify-center px-2">
        <RefreshButton />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {intents === undefined || projects === undefined ? (
          <TopicPlaceholder status={status} compact />
        ) : projects.length === 0 ? (
          <EmptyState compact icon={MapIcon} title="No projects yet">
            Add a project in Settings and its intents show here.
          </EmptyState>
        ) : (
          <Stale status={status}>
            {plansByProject(projects, intents).map(({ project, intents: own }) => (
              <section key={project.id} aria-label={project.name} className="mt-2">
                <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                  {project.name}
                  <span className="ml-1 opacity-70">{own.length}</span>
                </h3>
                {own.length === 0 ? (
                  <p className="px-2 pb-1 text-2xs text-muted-foreground">
                    No intents in this project&apos;s {directory} folder.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {own.map((intent) => (
                      <li key={intent.id}>
                        <IntentRow intent={intent} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </Stale>
        )}
      </div>
    </nav>
  );
}

export function PlansLayout() {
  const { configured } = useConnectionState();
  if (!configured) return <DisconnectedState offline />;
  return (
    <div className="flex h-full min-h-0">
      <IntentList />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export function PlansHome() {
  const intents = useTopic('planIntents');
  const any = intents !== undefined && intents.length > 0;
  return (
    <EmptyState
      icon={MapIcon}
      title={any ? 'Pick an intent' : 'No intents yet'}
      description="wow reads each project's intent, spec and plan files and shows a plan's units. It never writes them."
    />
  );
}

function FileRow({
  name,
  present,
  status,
  rev,
  stale,
  extra,
}: {
  name: string;
  present: boolean;
  status: string | null;
  rev: number | null;
  stale?: string | undefined;
  extra?: string | undefined;
}) {
  return (
    <div data-testid={`plan-file-${name}`} className="flex flex-wrap items-center gap-2 py-1">
      <dt className="w-20 shrink-0 font-mono text-xs">{name}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs">
        {present ? (
          <span>{revisionLabel(status, rev)}</span>
        ) : (
          <span className="text-muted-foreground">Missing</span>
        )}
        {extra && <span className="text-muted-foreground">· {extra}</span>}
        {stale && <Badge variant="warning">{stale}</Badge>}
      </dd>
    </div>
  );
}

const derivedRow = (kind: 'spec' | 'plan', file: PlanFile | null, extra?: string) => (
  <FileRow
    name={fileNames[kind]}
    present={file !== null}
    status={file?.status ?? null}
    rev={file?.rev ?? null}
    stale={file ? staleLabel(kind, file) : undefined}
    extra={extra}
  />
);

function UnitRow({
  unit,
  open,
  onToggle,
}: {
  unit: PlanUnit;
  open: boolean;
  onToggle: () => void;
}) {
  // The line keeps the id apart for a key a plan lists twice.
  const contractId = `unit-contract-${unit.key}-${unit.line}`;
  return (
    <li data-testid={`unit-${unit.key}`} className="border-b border-border last:border-b-0">
      <div className="flex items-start gap-2 px-3 py-2">
        {unit.contract ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-expanded={open}
            aria-controls={contractId}
            aria-label={`Contract of ${unit.key}`}
            onClick={onToggle}
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        ) : (
          <span className="size-8 shrink-0" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
          <p className="flex items-baseline gap-2 text-sm">
            <span data-testid="unit-key" className="shrink-0 font-mono text-xs">
              {unit.key}
            </span>
            <span data-testid="unit-title" className="min-w-0">
              {unit.title}
            </span>
          </p>
          {unit.dependsOn.length > 0 && (
            <p data-testid="unit-depends" className="text-2xs text-muted-foreground">
              Depends on {unit.dependsOn.join(', ')}
            </p>
          )}
          {unit.blocked !== null && (
            <p data-testid="unit-blocked" className="text-2xs text-muted-foreground">
              Blocked: {unit.blocked}
            </p>
          )}
        </div>
        <Badge
          data-testid="unit-status"
          variant={unit.status === 'blocked' ? 'warning' : 'outline'}
          className="mt-1"
          title={unit.statusReason}
        >
          {unitStatusLabels[unit.status]}
        </Badge>
      </div>
      {open && unit.contract && (
        <dl id={contractId} data-testid="unit-contract" className="grid gap-3 px-3 pb-3 pl-13">
          {unit.contract.map((field) => (
            <div key={field.name} className="grid gap-1">
              <dt className="text-2xs font-medium text-muted-foreground">{field.name}</dt>
              <dd>
                {field.value === null ? (
                  <span className="text-xs text-muted-foreground">Not in this contract</span>
                ) : (
                  <Markdown text={field.value} className="text-xs" />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function PlanView({
  projectId,
  intentId,
  openUnit,
}: {
  projectId: string;
  intentId: string;
  openUnit: string | undefined;
}) {
  const { rows: intents, status } = useTopicState('planIntents');
  const projects = useTopic('projects');
  const navigate = useNavigate();
  if (intents === undefined) return <TopicPlaceholder status={status} />;
  const intent = intents.find(
    (candidate) => candidate.projectId === projectId && candidate.intentId === intentId,
  );
  if (!intent) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="No such intent"
        description="Its folder may have been renamed or removed."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/plans">Back to the plans</Link>
          </Button>
        }
      />
    );
  }
  const project = projects?.find((candidate) => candidate.id === projectId);
  const toggle = (key: string) =>
    void navigate({
      to: '/plans/$projectId/$intentId',
      params: { projectId, intentId },
      search: openUnit === key ? {} : { unit: key },
      replace: true,
    });
  // Units that share a reason show it once above the list instead of on every row.
  const reasons = [
    ...new Set(
      intent.units.filter((unit) => unit.status === 'unknown').map((unit) => unit.statusReason),
    ),
  ];
  return (
    <Stale status={status} className="h-full overflow-y-auto">
      <article aria-label={intent.title} className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{intent.title}</h2>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{intent.intentId}</span>
            {project && <span> · {project.name}</span>}
          </p>
        </header>

        <section aria-label="Files">
          <dl className="divide-y divide-border rounded-md border border-border px-3">
            <FileRow
              name={fileNames.intent}
              present={intent.hasIntent}
              status={intent.status}
              rev={intent.rev}
            />
            {derivedRow('spec', intent.spec)}
            {derivedRow(
              'plan',
              intent.plan,
              intent.source ? `units in ${intent.source}` : undefined,
            )}
          </dl>
        </section>

        {intent.problems.length > 0 && (
          <section aria-label="Problems" className="flex flex-col gap-1">
            <h3 className="text-xs font-medium">Problems</h3>
            <ul className="flex flex-col gap-1">
              {intent.problems.map((problem, index) => (
                <li
                  // One line can have the same problem twice.
                  key={`${index}:${problemLabel(problem)}`}
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs"
                >
                  {problemLabel(problem)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {intent.plan && (
          <section aria-label="Units" className="flex flex-col gap-1">
            <h3 className="text-xs font-medium">
              Units<span className="ml-1 text-muted-foreground">{intent.units.length}</span>
            </h3>
            {reasons.map((reason) => (
              <p
                key={reason}
                data-testid="unit-status-reason"
                className="text-xs text-muted-foreground"
              >
                Status unknown: {reason}.
              </p>
            ))}
            {intent.source === 'issues' && (
              <p className="text-xs text-muted-foreground">
                This plan keeps dependencies and contracts in issues, so only keys and titles show.
              </p>
            )}
            {intent.units.length > 0 && (
              <ol className={cn('rounded-md border border-border')}>
                {intent.units.map((unit, index) => (
                  <UnitRow
                    // A plan with a duplicate key still lists both lines.
                    key={`${unit.key}:${index}`}
                    unit={unit}
                    open={openUnit === unit.key}
                    onToggle={() => toggle(unit.key)}
                  />
                ))}
              </ol>
            )}
          </section>
        )}
      </article>
    </Stale>
  );
}
