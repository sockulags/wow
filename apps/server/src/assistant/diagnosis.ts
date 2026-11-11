import {
  OutlookProfile,
  SecretRef,
  assistantDiagnosisTool,
  awaitedProviderKind,
  lacksRequiredModel,
  modelMark,
  providerKindLabels,
  isEventTrigger,
  isLiveRunState,
  projectCodeHost,
  resolveZoneSetting,
  settingGroupTitles,
  settingsRegistry,
  trackerConnectionLabels,
  triggerEventLabel,
  type AssistantPlace,
  type Diagnosis,
  type DiagnosisProblem,
  type TrackerConnection,
} from '@wow/contracts';
import { and, asc, desc, eq, inArray, isNotNull, isNull, not, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runPath } from '../core/workflows.js';
import { triggersPath } from '../core/triggers.js';
import * as t from '../db/schema.js';
import { skillInstalled, type Reader, type ReaderDeps } from './readers.js';

// "Why does this not work" (app assistant spec 19, 20): what is failing in the setup, each with
// its reason and the setting or view to fix it in. Everything comes from stored state and the
// sign-in test Settings runs, never from a thread's messages or a step's final message: a run
// is explained by its stored error.

const none = z.object({}).strict();

const services: readonly TrackerConnection[] = ['jira', 'github', 'gitlab', 'confluence'];

const providersPlace: AssistantPlace = {
  label: 'Settings → Providers',
  path: '/settings/providers',
};
const trackersPlace: AssistantPlace = {
  label: `Settings → ${settingGroupTitles.trackers}`,
  path: '/settings/trackers',
};
const triggersPlace: AssistantPlace = { label: 'Workflows → Triggers', path: triggersPath };
const projectPlace = (name: string): AssistantPlace => ({
  label: `Settings → Projects → ${name}`,
  path: '/settings/projects',
});
const workflowPlace = (id: string, name: string): AssistantPlace => ({
  label: `Workflows → ${name}`,
  path: `/workflows/${encodeURIComponent(id)}`,
});

function settingPlace(key: string): AssistantPlace {
  const group = Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].group
    : undefined;
  return group
    ? { label: `Settings → ${settingGroupTitles[group]}`, path: `/settings/${group}` }
    : trackersPlace;
}

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : 'It failed without saying why.';

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// A host connection is in use where its token or its address is stored: tested once for the
// shared settings, and once more for each project that stores its own.
function connectionContexts(
  service: TrackerConnection,
  deps: ReaderDeps,
  projects: readonly { id: string; name: string }[],
): { projectId?: string; projectName?: string }[] {
  const keys = [`trackers.${service}.token`, `trackers.${service}.baseUrl`];
  const stored = (projectId?: string) =>
    keys.some((key) => {
      const { source, value } = deps.settings.resolve(key, { projectId });
      if (source === 'default') return false;
      if (key.endsWith('.token')) return SecretRef.safeParse(value).success;
      return projectId === undefined || source === `project:${projectId}`;
    });
  const own = (projectId: string) =>
    keys.some((key) => deps.settings.resolve(key, { projectId }).source === `project:${projectId}`);
  return [
    ...(stored() ? [{}] : []),
    ...projects
      .filter((project) => own(project.id) && stored(project.id))
      .map((project) => ({ projectId: project.id, projectName: project.name })),
  ];
}

async function connections(
  deps: ReaderDeps,
  projects: readonly { id: string; name: string }[],
): Promise<{ problems: DiagnosisProblem[]; tested: string[] }> {
  const tests = services.flatMap((service) =>
    connectionContexts(service, deps, projects).map(async ({ projectId, projectName }) => {
      const name = `${trackerConnectionLabels[service]}${projectName ? ` for ${projectName}` : ''}`;
      const place = projectName ? projectPlace(projectName) : trackersPlace;
      try {
        const result = await deps.trackers.test(service, projectId);
        return { name, problem: result.ok ? null : { message: result.message, place } };
      } catch (error) {
        return { name, problem: { message: reasonOf(error), place } };
      }
    }),
  );
  const results = await Promise.all(tests);
  return {
    tested: results.map((result) => result.name),
    problems: results.flatMap(({ name, problem }) =>
      problem
        ? [
            {
              kind: 'connection' as const,
              what: `${name}: connection test`,
              reason: problem.message,
              place: problem.place,
            },
          ]
        : [],
    ),
  };
}

function providers(deps: ReaderDeps): DiagnosisProblem[] {
  return deps.db
    .select()
    .from(t.providerInstances)
    .orderBy(asc(t.providerInstances.name))
    .all()
    .filter((instance) => instance.status !== 'ready')
    .map((instance) => ({
      kind: 'provider',
      what: `Provider ${instance.name}`,
      reason:
        instance.status === 'error'
          ? `It is not signed in: its last test failed${instance.statusMessage ? ` (${instance.statusMessage})` : ''}. Press Test after fixing it.`
          : 'It has not been tested, so wow does not know whether it is signed in. Press Test.',
      place: providersPlace,
    }));
}

// A read of a run counts only while the run is live: an ended run is not read again, so its
// last error would stay for good. Plan reads stay while the plan is read.
function hostReads(deps: ReaderDeps): DiagnosisProblem[] {
  const failed = [
    ...deps.db
      .select()
      .from(t.hostReads)
      .where(isNotNull(t.hostReads.error))
      .orderBy(asc(t.hostReads.id))
      .all()
      .map((row) => ({
        ...row,
        runId: row.scope === 'run' ? row.id.slice('run:'.length) : null,
      })),
    ...deps.db
      .select()
      .from(t.ticketReads)
      .where(isNotNull(t.ticketReads.error))
      .orderBy(asc(t.ticketReads.id))
      .all(),
    ...deps.db
      .select()
      .from(t.pageReads)
      .where(isNotNull(t.pageReads.error))
      .orderBy(asc(t.pageReads.id))
      .all(),
  ];
  const runIds = [...new Set(failed.flatMap((row) => (row.runId === null ? [] : [row.runId])))];
  const live = new Set(
    runIds.length === 0
      ? []
      : deps.db
          .select({ id: t.workflowRuns.id, state: t.workflowRuns.state })
          .from(t.workflowRuns)
          .where(inArray(t.workflowRuns.id, runIds))
          .all()
          .filter((run) => isLiveRunState(run.state))
          .map((run) => run.id),
  );
  return failed.flatMap((row) =>
    row.error && (row.runId === null || live.has(row.runId))
      ? [
          {
            kind: 'hostRead' as const,
            what: `Reading ${row.hostName}`,
            reason: row.error.message,
            place: row.error.setting ? settingPlace(row.error.setting) : trackersPlace,
          },
        ]
      : [],
  );
}

function skills(
  deps: ReaderDeps,
  workflows: readonly (typeof t.workflows.$inferSelect)[],
): DiagnosisProblem[] {
  const installed = deps.db
    .select({ name: t.skills.name })
    .from(t.skills)
    .all()
    .map((skill) => skill.name);
  return workflows.flatMap((workflow) =>
    workflow.steps
      .filter((step) => !skillInstalled(step.skillName, installed))
      .map((step) => ({
        kind: 'skill' as const,
        what: `Workflow ${workflow.name}, step ${step.id}`,
        reason: `It runs the skill ${step.skillName}, which is not installed on this machine. Install the skill or pick another one for the step.`,
        place: workflowPlace(workflow.id, workflow.name),
      })),
  );
}

// Steps stored without a model their provider needs (questions and models spec 19), from
// before wow refused them or applied from a setup file.
function models(
  deps: ReaderDeps,
  workflows: readonly (typeof t.workflows.$inferSelect)[],
): DiagnosisProblem[] {
  const instances = new Map(
    deps.db
      .select()
      .from(t.providerInstances)
      .all()
      .map((instance) => [instance.id, instance]),
  );
  return workflows.flatMap((workflow) =>
    workflow.steps.flatMap((step) => {
      const instance = instances.get(step.providerInstanceId);
      const kind = instance?.kind ?? awaitedProviderKind(step.providerInstanceId);
      if (!kind || !lacksRequiredModel(step, kind)) return [];
      const mark = modelMark(step.skillName, {
        name: instance?.name ?? providerKindLabels[kind],
        kind,
        defaultModel: instance?.defaultModel ?? null,
      });
      return [
        {
          kind: 'model' as const,
          what: `Workflow ${workflow.name}, step ${step.id}`,
          reason: `${mark.charAt(0).toUpperCase()}${mark.slice(1)}.`,
          place: workflowPlace(workflow.id, workflow.name),
        },
      ];
    }),
  );
}

interface Names {
  readonly workflows: ReadonlyMap<string, string>;
  readonly projects: ReadonlyMap<string, string>;
  // A stored time as the user reads it, in the calendar's zone.
  readonly time: (iso: string) => string;
}

// Each list below is one bounded query: what still counts is decided in SQL, so the limit is
// applied to what is reported and no row costs a query of its own.

// An event trigger that could not start its run records the event with no run and stores a
// "Trigger failed" notification under `<trigger>:<event>:failed` (see core/triggers.ts); its
// newest failure counts until the trigger starts a run after it.
function triggers(deps: ReaderDeps, limit: number, names: Names): DiagnosisProblem[] {
  const failures = deps.db
    .select({ trigger: t.triggers, body: t.notifications.body })
    .from(t.triggerEvents)
    .innerJoin(
      t.notifications,
      eq(
        t.notifications.id,
        sql`${t.triggerEvents.triggerId} || ':' || ${t.triggerEvents.eventId} || ':failed'`,
      ),
    )
    .innerJoin(t.triggers, eq(t.triggers.id, t.triggerEvents.triggerId))
    .where(
      and(
        isNull(t.triggerEvents.runId),
        eq(t.notifications.kind, 'failed'),
        eq(t.triggers.kind, 'event'),
        sql`not exists (select 1 from ${t.triggerEvents} as other join ${t.notifications} as newer on newer.id = other.trigger_id || ':' || other.event_id || ':failed' where other.trigger_id = ${t.triggerEvents.triggerId} and other.run_id is null and newer.kind = 'failed' and (julianday(newer.at) > julianday(${t.notifications.at}) or (julianday(newer.at) = julianday(${t.notifications.at}) and newer.id > ${t.notifications.id})))`,
        sql`not exists (select 1 from ${t.triggerEvents} as started where started.trigger_id = ${t.triggerEvents.triggerId} and started.run_id is not null and julianday(started.at) > julianday(${t.notifications.at}))`,
      ),
    )
    .orderBy(desc(t.notifications.at))
    .limit(limit)
    .all();
  const reads = deps.db
    .select({
      projectId: t.hostReads.projectId,
      host: t.hostReads.host,
      fetchedAt: t.hostReads.fetchedAt,
    })
    .from(t.hostReads)
    .where(
      inArray(t.hostReads.projectId, [
        ...new Set(failures.flatMap(({ trigger }) => trigger.projectId ?? [])),
      ]),
    )
    .all();
  return failures.flatMap(({ trigger, body }) =>
    isEventTrigger(trigger)
      ? [
          {
            kind: 'trigger' as const,
            what: `Trigger "${triggerEventLabel(trigger.event, projectCodeHost(reads, trigger.projectId))}" for ${names.workflows.get(trigger.workflowId) ?? trigger.workflowId} in ${names.projects.get(trigger.projectId) ?? trigger.projectId}`,
            reason: `It could not start a run: ${body}`,
            place: triggersPlace,
          },
        ]
      : [],
  );
}

// A run of the workflow in the project that started after `startedAt` and ended done. Times are
// compared as instants: a card's start keeps the offset the command gave it, so text order is
// not time order.
const doneAfter = (
  workflowId: typeof t.workflowRuns.workflowId | typeof t.calendarItems.workflowId,
  projectId: typeof t.workflowRuns.projectId | typeof t.calendarItems.projectId,
  startedAt: typeof t.workflowRuns.startedAt | typeof t.calendarItems.start,
) =>
  sql`exists (select 1 from ${t.workflowRuns} as later where later.state = 'done' and later.workflow_id = ${workflowId} and later.project_id = ${projectId} and julianday(later.started_at) > julianday(${startedAt}))`;

// A failed run counts until a later run of the same workflow in the same project ends done; a
// failed plan run until a later plan run of the same plan ends done. A run whose workflow or
// project was deleted cannot be run again, so it no longer counts.
function runs(deps: ReaderDeps, limit: number, names: Names): DiagnosisProblem[] {
  const candidates = deps.db
    .select({ run: t.workflowRuns })
    .from(t.workflowRuns)
    .innerJoin(t.workflows, eq(t.workflows.id, t.workflowRuns.workflowId))
    .innerJoin(t.projects, eq(t.projects.id, t.workflowRuns.projectId))
    .where(
      and(
        eq(t.workflowRuns.state, 'failed'),
        not(
          doneAfter(t.workflowRuns.workflowId, t.workflowRuns.projectId, t.workflowRuns.startedAt),
        ),
      ),
    )
    .orderBy(desc(t.workflowRuns.startedAt))
    .limit(limit)
    .all();
  const failed = candidates.map(({ run }): DiagnosisProblem => {
    const workflow = names.workflows.get(run.workflowId) ?? run.workflowId;
    const step = run.steps.find((entry) => entry.state === 'failed' && entry.error);
    const reason = step?.error
      ? `Step ${step.stepId} failed: ${step.error}`
      : run.workingCopy?.error
        ? `Its working copy failed: ${run.workingCopy.error}`
        : 'It failed without an error message.';
    return {
      kind: 'run',
      what: `Run of ${workflow} in ${names.projects.get(run.projectId) ?? run.projectId}, started ${names.time(run.startedAt)}`,
      reason,
      place: { label: `The run of ${workflow}`, path: runPath(run.id) },
    };
  });
  const failedPlans = deps.db
    .select({ run: t.planRuns })
    .from(t.planRuns)
    .innerJoin(t.projects, eq(t.projects.id, t.planRuns.projectId))
    .where(
      and(
        eq(t.planRuns.state, 'failed'),
        sql`not exists (select 1 from ${t.planRuns} as later where later.state = 'done' and later.plan_id = ${t.planRuns.planId} and julianday(later.started_at) > julianday(${t.planRuns.startedAt}))`,
      ),
    )
    .orderBy(desc(t.planRuns.startedAt))
    .limit(limit)
    .all();
  const planRuns = failedPlans.map(({ run }): DiagnosisProblem => ({
    kind: 'run',
    what: `Plan run of ${run.intentId} in ${names.projects.get(run.projectId) ?? run.projectId}, started ${names.time(run.startedAt)}`,
    reason: run.message ?? 'It failed without an error message.',
    place: {
      label: `Plans → ${run.intentId}`,
      path: `/plans/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.intentId)}`,
    },
  }));
  return [...failed, ...planRuns];
}

// A card with a workflow whose start passed without a run: missed, or failed before its run
// could start (the reason is in its "Trigger failed" notification). It counts until a run of
// its workflow in its project that started after the card's start ends done.
function cards(deps: ReaderDeps, limit: number, names: Names): DiagnosisProblem[] {
  const policy = deps.settings.get('scheduler.missedPolicy');
  const policyLabel = settingsRegistry['scheduler.missedPolicy'].options?.[policy]?.label ?? policy;
  const candidates = deps.db
    .select({
      card: t.calendarItems,
      failure: sql<
        string | null
      >`(select failure.body from ${t.notifications} as failure where failure.kind = 'failed' and failure.run_id is null and failure.calendar_item_id = "calendar_items"."id" order by failure.at desc limit 1)`,
      offered: sql<
        number | null
      >`(select card_trigger.offer_run_now from ${t.triggers} as card_trigger where card_trigger.kind = 'card' and card_trigger.calendar_item_id = "calendar_items"."id" limit 1)`,
    })
    .from(t.calendarItems)
    .where(
      and(
        eq(t.calendarItems.source, 'local'),
        isNotNull(t.calendarItems.workflowId),
        isNotNull(t.calendarItems.projectId),
        or(
          and(eq(t.calendarItems.state, 'failed'), isNull(t.calendarItems.runId)),
          eq(t.calendarItems.state, 'missed'),
        ),
        not(
          doneAfter(t.calendarItems.workflowId, t.calendarItems.projectId, t.calendarItems.start),
        ),
      ),
    )
    .orderBy(sql`julianday(${t.calendarItems.start}) desc`)
    .limit(limit)
    .all();
  return candidates.map(({ card, failure, offered }): DiagnosisProblem => {
    let reason: string;
    if (card.state === 'failed') {
      const prefix = `${card.title}: `;
      const why = failure?.startsWith(prefix) ? failure.slice(prefix.length) : failure;
      reason = `Its run could not start${why ? `: ${why}` : '.'}`;
    } else {
      reason = `Its start time passed without a run: it was put in the past, or wow was closed or the scheduler paused then. Missed triggers are set to "${policyLabel}" in Settings → Scheduler.${offered ? ' Run now on the card starts it.' : ''}`;
    }
    return {
      kind: 'card',
      what: `Card "${card.title}" at ${names.time(card.start)}`,
      reason,
      place: {
        label: `Calendar → ${card.title}`,
        path: `/calendar?item=${encodeURIComponent(card.id)}`,
      },
    };
  });
}

// Times are told in the zone the calendar shows, so the agent can repeat them as they are.
function timeText(deps: ReaderDeps): (iso: string) => string {
  const profile = OutlookProfile.safeParse(deps.db.select().from(t.outlookStatus).get()?.profile);
  const { zone } = resolveZoneSetting(
    deps.settings.get('calendar.zone'),
    profile.success ? profile.data : null,
  );
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (iso) => {
    const at = Date.parse(iso);
    return Number.isNaN(at) ? iso : `${format.format(at)} (${zone})`;
  };
}

export async function diagnose(deps: ReaderDeps): Promise<Diagnosis> {
  const limit = deps.settings.get('assistant.diagnosisLimit');
  const projects = deps.db
    .select({ id: t.projects.id, name: t.projects.name })
    .from(t.projects)
    .orderBy(asc(t.projects.name))
    .all();
  const workflows = deps.db.select().from(t.workflows).orderBy(asc(t.workflows.name)).all();
  const names: Names = {
    workflows: new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    projects: new Map(projects.map((project) => [project.id, project.name])),
    time: timeText(deps),
  };
  const instances = deps.db.select({ id: t.providerInstances.id }).from(t.providerInstances).all();
  const tested = await connections(deps, projects);
  const problems = [
    ...providers(deps),
    ...tested.problems,
    ...hostReads(deps),
    ...skills(deps, workflows),
    ...models(deps, workflows),
    ...triggers(deps, limit, names),
    ...runs(deps, limit, names),
    ...cards(deps, limit, names),
  ];
  const checked = [
    instances.length === 0
      ? 'provider sign-ins: no provider instance is set up (Settings → Providers)'
      : `provider sign-ins: ${plural(instances.length, 'instance')}`,
    tested.tested.length === 0
      ? 'connection tests: no host connection is set up'
      : `connection tests: ${tested.tested.join(', ')}`,
    'the last read of each host',
    `skills and models of ${plural(workflows.length, 'workflow')}`,
    'event triggers',
    'runs and plan runs',
    'calendar cards with a workflow',
  ];
  return {
    outcome: 'diagnosed',
    summary:
      problems.length === 0
        ? 'Nothing is failing in what wow checked.'
        : `${plural(problems.length, 'thing is', 'things are')} failing.`,
    problems,
    checked,
  };
}

export const diagnosisReaders = {
  [assistantDiagnosisTool]: {
    description:
      'Says what is failing in the setup and where to fix each: provider instances that are not signed in, failed connection tests of the hosts in use, failed host reads, workflow steps whose skill is not installed or that lack a model their provider needs, event triggers that failed, failed runs with their error, and cards that did not start and why. Use it when the user asks why something does not work, and give each place as a link.',
    input: none,
    read: (_args, deps) => diagnose(deps),
  } satisfies Reader<typeof none>,
} as const;
