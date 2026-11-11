import {
  SecretRef,
  assistantDiagnosisTool,
  isCardTrigger,
  isEventTrigger,
  settingGroupTitles,
  settingsRegistry,
  trackerConnectionLabels,
  triggerEventLabels,
  type AssistantPlace,
  type Diagnosis,
  type DiagnosisProblem,
  type TrackerConnection,
} from '@wow/contracts';
import { asc, desc } from 'drizzle-orm';
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

function hostReads(deps: ReaderDeps): DiagnosisProblem[] {
  return [
    ...deps.db.select().from(t.hostReads).orderBy(asc(t.hostReads.id)).all(),
    ...deps.db.select().from(t.ticketReads).orderBy(asc(t.ticketReads.id)).all(),
    ...deps.db.select().from(t.pageReads).orderBy(asc(t.pageReads.id)).all(),
  ].flatMap((row) =>
    row.error
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

function skills(deps: ReaderDeps): { problems: DiagnosisProblem[]; workflows: number } {
  const installed = deps.db
    .select({ name: t.skills.name })
    .from(t.skills)
    .all()
    .map((skill) => skill.name);
  const workflows = deps.db.select().from(t.workflows).orderBy(asc(t.workflows.name)).all();
  return {
    workflows: workflows.length,
    problems: workflows.flatMap((workflow) =>
      workflow.steps
        .filter((step) => !skillInstalled(step.skillName, installed))
        .map((step) => ({
          kind: 'skill' as const,
          what: `Workflow ${workflow.name}, step ${step.id}`,
          reason: `It runs the skill ${step.skillName}, which is not installed on this machine. Install the skill or pick another one for the step.`,
          place: workflowPlace(workflow.id, workflow.name),
        })),
    ),
  };
}

// An event trigger that could not start its run stores a "Trigger failed" notification (see
// core/triggers.ts); it counts until the trigger starts a run after it.
function triggers(deps: ReaderDeps, limit: number): DiagnosisProblem[] {
  const rows = deps.db.select().from(t.triggers).all().filter(isEventTrigger);
  const workflows = new Map(
    deps.db
      .select()
      .from(t.workflows)
      .all()
      .map((workflow) => [workflow.id, workflow.name]),
  );
  const projects = new Map(
    deps.db
      .select()
      .from(t.projects)
      .all()
      .map((project) => [project.id, project.name]),
  );
  const started = new Map(
    deps.db
      .select()
      .from(t.workflowRuns)
      .all()
      .map((run) => [run.id, run.startedAt]),
  );
  const failures = deps.db
    .select()
    .from(t.notifications)
    .orderBy(desc(t.notifications.at))
    .all()
    .filter((row) => row.kind === 'failed' && row.runId === null && row.calendarItemId === null);
  const seen = new Set<string>();
  const problems: DiagnosisProblem[] = [];
  for (const failure of failures) {
    const trigger = rows.find((row) => failure.id.startsWith(`${row.id}:`));
    if (!trigger || seen.has(trigger.id)) continue;
    seen.add(trigger.id);
    const later = trigger.runId ? started.get(trigger.runId) : undefined;
    if (later !== undefined && Date.parse(later) > Date.parse(failure.at)) continue;
    problems.push({
      kind: 'trigger',
      what: `Trigger "${triggerEventLabels[trigger.event]}" for ${workflows.get(trigger.workflowId) ?? trigger.workflowId} in ${projects.get(trigger.projectId) ?? trigger.projectId}`,
      reason: `It could not start a run: ${failure.body}`,
      place: triggersPlace,
    });
  }
  return problems.slice(0, limit);
}

// A failed run counts until a later run of the same workflow in the same project ends done.
function runs(deps: ReaderDeps, limit: number): DiagnosisProblem[] {
  const workflows = new Map(
    deps.db
      .select()
      .from(t.workflows)
      .all()
      .map((workflow) => [workflow.id, workflow.name]),
  );
  const projects = new Map(
    deps.db
      .select()
      .from(t.projects)
      .all()
      .map((project) => [project.id, project.name]),
  );
  const all = deps.db.select().from(t.workflowRuns).orderBy(desc(t.workflowRuns.startedAt)).all();
  const failed = all
    .filter((run) => run.state === 'failed')
    .filter(
      (run) =>
        !all.some(
          (other) =>
            other.state === 'done' &&
            other.workflowId === run.workflowId &&
            other.projectId === run.projectId &&
            Date.parse(other.startedAt) > Date.parse(run.startedAt),
        ),
    )
    .slice(0, limit)
    .map((run): DiagnosisProblem => {
      const workflow = workflows.get(run.workflowId) ?? run.workflowId;
      const step = run.steps.find((entry) => entry.state === 'failed' && entry.error);
      const reason = step?.error
        ? `Step ${step.stepId} failed: ${step.error}`
        : run.workingCopy?.error
          ? `Its working copy failed: ${run.workingCopy.error}`
          : 'It failed without an error message.';
      return {
        kind: 'run',
        what: `Run of ${workflow} in ${projects.get(run.projectId) ?? run.projectId}, started ${run.startedAt}`,
        reason,
        place: { label: `The run of ${workflow}`, path: runPath(run.id) },
      };
    });
  const planRuns = deps.db
    .select()
    .from(t.planRuns)
    .orderBy(desc(t.planRuns.startedAt))
    .all()
    .filter((run) => run.state === 'failed')
    .slice(0, limit)
    .map((run): DiagnosisProblem => ({
      kind: 'run',
      what: `Plan run of ${run.intentId} in ${projects.get(run.projectId) ?? run.projectId}, started ${run.startedAt}`,
      reason: run.message ?? 'It failed without an error message.',
      place: {
        label: `Plans → ${run.intentId}`,
        path: `/plans/${encodeURIComponent(run.projectId)}/${encodeURIComponent(run.intentId)}`,
      },
    }));
  return [...failed, ...planRuns];
}

// A card with a workflow whose start passed without a run: missed, or failed before its run
// could start (the reason is in its "Trigger failed" notification).
function cards(deps: ReaderDeps, limit: number): DiagnosisProblem[] {
  const policy = deps.settings.get('scheduler.missedPolicy');
  const policyLabel = settingsRegistry['scheduler.missedPolicy'].options?.[policy]?.label ?? policy;
  const triggerOf = new Map(
    deps.db
      .select()
      .from(t.triggers)
      .all()
      .filter(isCardTrigger)
      .map((trigger) => [trigger.calendarItemId, trigger]),
  );
  const failures = deps.db
    .select()
    .from(t.notifications)
    .orderBy(desc(t.notifications.at))
    .all()
    .filter((row) => row.kind === 'failed' && row.runId === null && row.calendarItemId !== null);
  return deps.db
    .select()
    .from(t.calendarItems)
    .orderBy(desc(t.calendarItems.start))
    .all()
    .filter(
      (card) =>
        card.source === 'local' &&
        card.workflowId !== null &&
        card.projectId !== null &&
        ((card.state === 'failed' && card.runId === null) || card.state === 'missed'),
    )
    .slice(0, limit)
    .map((card) => {
      let reason: string;
      if (card.state === 'failed') {
        const failure = failures.find((row) => row.calendarItemId === card.id);
        const prefix = `${card.title}: `;
        const why = failure?.body.startsWith(prefix)
          ? failure.body.slice(prefix.length)
          : failure?.body;
        reason = `Its run could not start${why ? `: ${why}` : '.'}`;
      } else {
        const offered = triggerOf.get(card.id)?.offerRunNow === true;
        reason = `Its start time passed without a run: it was put in the past, or wow was closed or the scheduler paused then. Missed triggers are set to "${policyLabel}" in Settings → Scheduler.${offered ? ' Run now on the card starts it.' : ''}`;
      }
      return {
        kind: 'card' as const,
        what: `Card "${card.title}" at ${card.start}`,
        reason,
        place: {
          label: `Calendar → ${card.title}`,
          path: `/calendar?item=${encodeURIComponent(card.id)}`,
        },
      };
    });
}

export async function diagnose(deps: ReaderDeps): Promise<Diagnosis> {
  const limit = deps.settings.get('assistant.diagnosisLimit');
  const projects = deps.db
    .select({ id: t.projects.id, name: t.projects.name })
    .from(t.projects)
    .orderBy(asc(t.projects.name))
    .all();
  const instances = deps.db.select({ id: t.providerInstances.id }).from(t.providerInstances).all();
  const tested = await connections(deps, projects);
  const steps = skills(deps);
  const problems = [
    ...providers(deps),
    ...tested.problems,
    ...hostReads(deps),
    ...steps.problems,
    ...triggers(deps, limit),
    ...runs(deps, limit),
    ...cards(deps, limit),
  ];
  const checked = [
    instances.length === 0
      ? 'provider sign-ins: no provider instance is set up (Settings → Providers)'
      : `provider sign-ins: ${plural(instances.length, 'instance')}`,
    tested.tested.length === 0
      ? 'connection tests: no host connection is set up'
      : `connection tests: ${tested.tested.join(', ')}`,
    'the last read of each host',
    `skills of ${plural(steps.workflows, 'workflow')}`,
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
      'Says what is failing in the setup and where to fix each: provider instances that are not signed in, failed connection tests of the hosts in use, failed host reads, workflow steps whose skill is not installed, event triggers that failed, failed runs with their error, and cards that did not start and why. Use it when the user asks why something does not work, and give each place as a link.',
    input: none,
    read: (_args, deps) => diagnose(deps),
  } satisfies Reader<typeof none>,
} as const;
