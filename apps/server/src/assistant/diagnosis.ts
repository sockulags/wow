import {
  OutlookProfile,
  SecretRef,
  assistantDiagnosisTool,
  awaitedProviderKind,
  lacksRequiredModel,
  modelMark,
  providerKindLabels,
  resolveZoneSetting,
  settingGroupTitles,
  settingsRegistry,
  trackerConnectionLabels,
  type AssistantPlace,
  type Diagnosis,
  type DiagnosisProblem,
  type TrackerConnection,
} from '@wow/contracts';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import * as t from '../db/schema.js';
import { skillInstalled, type Reader, type ReaderDeps } from './readers.js';

// "Why does this not work" (app assistant spec 19, 20): what is failing in the setup, each with
// its reason and the setting or view to fix it in. Everything comes from stored state and the
// sign-in test Settings runs, never from a thread's messages.

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
// A trigger is a card on the calendar now (orchestrator threads spec 27, 34).
const triggersPlace: AssistantPlace = { label: 'Calendar', path: '/calendar' };
const projectPlace = (name: string): AssistantPlace => ({
  label: `Settings → Projects → ${name}`,
  path: '/settings/projects',
});
// Workflows are files on Settings › Workflows (orchestrator threads spec 22, 34).
const workflowPlace = (_id: string, name: string): AssistantPlace => ({
  label: `Settings → Workflows → ${name}`,
  path: '/settings/workflows',
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
const dismissed = (decisionId: SQL) =>
  sql`exists (select 1 from ${t.decisionDismissals} where ${t.decisionDismissals.decisionId} = ${decisionId})`;

// A card with a workflow whose start passed without starting its thread: missed, or failed
// before its thread could start (the reason is in its "Trigger failed" notification). It counts
// until the card starts a thread, or the user dismisses it from the decision queue.
function cards(deps: ReaderDeps, limit: number, names: Names): DiagnosisProblem[] {
  const policy = deps.settings.get('scheduler.missedPolicy');
  const policyLabel = settingsRegistry['scheduler.missedPolicy'].options?.[policy]?.label ?? policy;
  const candidates = deps.db
    .select({
      card: t.calendarItems,
      failure: sql<
        string | null
      >`(select failure.body from ${t.notifications} as failure where failure.kind = 'failed' and failure.calendar_item_id = "calendar_items"."id" order by failure.at desc limit 1)`,
      offered: sql<
        number | null
      >`(select card_trigger.offer_run_now from ${t.triggers} as card_trigger where card_trigger.calendar_item_id = "calendar_items"."id" limit 1)`,
    })
    .from(t.calendarItems)
    .where(
      and(
        eq(t.calendarItems.source, 'local'),
        isNotNull(t.calendarItems.workflowId),
        isNotNull(t.calendarItems.projectId),
        or(
          and(eq(t.calendarItems.state, 'failed'), isNull(t.calendarItems.threadId)),
          eq(t.calendarItems.state, 'missed'),
        ),
        not(dismissed(sql`'missedCard:' || ${t.calendarItems.id}`)),
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
      reason = `Its thread could not start${why ? `: ${why}` : '.'}`;
    } else {
      reason = `Its start time passed without starting its thread: it was put in the past, or wow was closed or the scheduler paused then. Missed triggers are set to "${policyLabel}" in Settings → Scheduler.${offered ? ' Run now on the card starts it.' : ''}`;
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
    ...skills(deps, workflows),
    ...models(deps, workflows),
    ...cards(deps, limit, names),
  ];
  const checked = [
    instances.length === 0
      ? 'provider sign-ins: no provider instance is set up (Settings → Providers)'
      : `provider sign-ins: ${plural(instances.length, 'instance')}`,
    tested.tested.length === 0
      ? 'connection tests: no host connection is set up'
      : `connection tests: ${tested.tested.join(', ')}`,
    `skills and models of ${plural(workflows.length, 'workflow')}`,
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
      'Says what is failing in the setup and where to fix each: provider instances that are not signed in, failed connection tests of the hosts in use, workflow steps whose skill is not installed or that lack a model their provider needs, and cards that did not start and why. Use it when the user asks why something does not work, and give each place as a link.',
    input: none,
    read: (_args, deps) => diagnose(deps),
  } satisfies Reader<typeof none>,
} as const;
