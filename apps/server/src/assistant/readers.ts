import {
  repeatRuleWords,
  SecretRef,
  SettingGroup,
  TrackerConnection,
  isCardTrigger,
  inListOrder,
  skillGroupOf,
  type CalendarOccurrence,
  type ProviderModel,
  type SettingDefinition,
} from '@wow/contracts';
import type { SecretStore } from '@wow/secrets';
import { asc, desc } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';
import { CommandRejected } from '../core/orchestrator.js';
import { readCalendarRange } from '../core/series.js';
import { runPath } from '../core/workflows.js';
import type { SettingsService } from '../settings/service.js';
import type { TrackerService } from '../trackers/service.js';

// What the assistant can read of the app (app assistant spec 4 to 6). Every reader builds its
// answer field by field: nothing here returns a thread's messages, a step's final message, a
// file's content or a secret's value, and a reader added later has to choose its fields too.

export interface ReaderDeps {
  readonly db: Db;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly trackers: TrackerService;
  readonly clock: () => Date;
  readonly registry: Readonly<Record<string, SettingDefinition>>;
  // What the installed provider of an instance offers (`listModels`).
  readonly listModels: (providerInstanceId: string) => Promise<ProviderModel[]>;
}

export interface Reader<S extends z.ZodType = z.ZodType> {
  readonly description: string;
  readonly input: S;
  read(args: z.output<S>, deps: ReaderDeps): unknown;
}

const reader = <S extends z.ZodType>(definition: Reader<S>) => definition;

const none = z.object({}).strict();

// All a reader ever says about a secret.
const setOrNot = (ref: unknown, names: ReadonlySet<string>): 'set' | 'not set' => {
  const parsed = SecretRef.safeParse(ref);
  return parsed.success && names.has(parsed.data.secretRef) ? 'set' : 'not set';
};

export const skillInstalled = (skillName: string, installed: readonly string[]): boolean =>
  installed.some(
    (name) =>
      name === skillName || name.endsWith(`:${skillName}`) || skillName.endsWith(`:${name}`),
  );

const isLive = (state: string) => state === 'running' || state === 'waiting';

// What the last read of a host said, without what was read.
const lastRead = (row: {
  id: string;
  projectId: string;
  host: string;
  hostName: string;
  fetchedAt: string | null;
  error: { kind: string; message: string; setting: string | null } | null;
}) => ({
  about: row.id,
  projectId: row.projectId,
  host: row.host,
  hostName: row.hostName,
  fetchedAt: row.fetchedAt,
  ok: row.error === null,
  error: row.error
    ? { kind: row.error.kind, message: row.error.message, setting: row.error.setting }
    : null,
});

export const readers = {
  read_settings: reader({
    description:
      'Settings with their label, description, value and where the value comes from (default, global or a project). A secret setting only says "set" or "not set". Give a group to read one page of Settings; give a projectId to read the values as they apply to that project.',
    input: z
      .object({
        group: SettingGroup.optional(),
        projectId: z.string().min(1).optional(),
      })
      .strict(),
    read: async ({ group, projectId }, deps) => {
      const names = new Set(await deps.secrets.names());
      return Object.entries(deps.registry)
        .filter(([, definition]) => group === undefined || definition.group === group)
        .map(([key, definition]) => {
          const resolved = deps.settings.resolve(key, { projectId });
          return {
            key,
            group: definition.group,
            label: definition.label,
            description: definition.description,
            storedAt: definition.scope,
            source: resolved.source,
            ...(definition.secret
              ? { secret: setOrNot(resolved.value, names) }
              : { value: resolved.value, default: definition.default }),
          };
        });
    },
  }),
  read_projects: reader({
    description:
      'Projects with their folder, the git remote wow reads the repository from and the host that remote is on.',
    input: none,
    read: async (_args, deps) => {
      const git = new Map(
        (await deps.trackers.projectsGit()).map((entry) => [entry.projectId, entry]),
      );
      return deps.db
        .select()
        .from(t.projects)
        .orderBy(asc(t.projects.name))
        .all()
        .map((project) => {
          const found = git.get(project.id);
          const remote = found?.remotes.find((entry) => entry.name === found.primary);
          return {
            id: project.id,
            name: project.name,
            folder: project.cwd,
            defaultProviderInstanceId: project.defaultProviderInstanceId,
            defaultModel: project.defaultModel,
            git: found
              ? { status: found.status, branch: found.branch, message: found.message }
              : null,
            remote: remote ? { name: remote.name, url: remote.url, path: remote.path } : null,
            host: remote?.host ?? null,
          };
        });
    },
  }),
  read_providers: reader({
    description:
      'Provider instances (Claude Code, Codex) and whether each is signed in, from its last test. Environment variables are listed by name only.',
    input: none,
    read: async (_args, deps) => {
      const names = new Set(await deps.secrets.names());
      return deps.db
        .select()
        .from(t.providerInstances)
        .orderBy(asc(t.providerInstances.name))
        .all()
        .map((instance) => ({
          id: instance.id,
          kind: instance.kind,
          name: instance.name,
          signedIn: instance.status === 'ready',
          status: instance.status,
          account: instance.account,
          version: instance.version,
          statusMessage: instance.statusMessage,
          defaultModel: instance.defaultModel,
          defaultEffort: instance.defaultEffort,
          defaultPermissionMode: instance.defaultPermissionMode,
          // A plain variable can hold a key the user did not mark as secret, so no value is shown.
          environment: Object.entries(instance.env).map(([name, value]) => ({
            name,
            value: typeof value === 'string' ? 'not shown' : setOrNot(value, names),
          })),
        }));
    },
  }),
  read_workflows: reader({
    description:
      'Workflows with their steps, gates, rules and switches. Each step says whether its skill is installed.',
    input: none,
    read: (_args, deps) => {
      const installed = deps.db.select({ name: t.skills.name }).from(t.skills).all();
      const names = installed.map((skill) => skill.name);
      return deps.db
        .select()
        .from(t.workflows)
        .orderBy(asc(t.workflows.name))
        .all()
        .map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          templateKind: workflow.templateKind,
          ownWorkingCopy: workflow.ownWorkingCopy,
          forUnits: workflow.forUnits,
          maxStepVisits: workflow.maxStepVisits,
          steps: workflow.steps.map((step) => ({
            ...step,
            skillInstalled: skillInstalled(step.skillName, names),
          })),
          path: `/workflows/${encodeURIComponent(workflow.id)}`,
        }));
    },
  }),
  read_templates: reader({
    description: 'The workflow templates a new workflow can start from.',
    input: none,
    read: (_args, deps) => deps.settings.get('workflows.templates'),
  }),
  read_skills: reader({
    description:
      'Every skill a workflow step or a message can use, in list order: your own skills ("yours") first, then the skills wow ships ("wow"), then skills from folders. A wow skill (group yours or wow) is sent as its text; read it with read_skill. Your own skills can be written, changed and removed with create_skill, update_skill and delete_skill; the others cannot be changed.',
    input: none,
    read: (_args, deps) =>
      inListOrder(deps.db.select().from(t.skills).all()).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        group: skillGroupOf(skill),
        source: skill.source,
        manualOnly: skill.manualOnly,
        // A step names a wow skill with this source, so it is not taken for a folder skill of
        // the same name.
        ...(skill.source === 'wow' || skill.source === 'yours'
          ? { skillSource: skill.source }
          : {}),
      })),
  }),
  read_skill: reader({
    description:
      "The text of a wow skill: one of your own (group yours) or one wow ships (group wow). A built-in skill's {{...}} parts are filled in from the settings and the run when it is sent. Skills from folders are the provider's to read; their text is not given here.",
    input: z
      .object({ name: z.string().min(1), group: z.enum(['yours', 'wow']).optional() })
      .strict(),
    read: ({ name, group }, deps) => {
      const found = deps.db
        .select()
        .from(t.skills)
        .all()
        .filter(
          (skill) =>
            skill.name === name &&
            (skill.source === 'yours' || skill.source === 'wow') &&
            (group === undefined || skill.source === group),
        );
      // Yours before wow's, as in every list.
      const skill = inListOrder(found)[0];
      if (!skill) {
        throw new CommandRejected(
          'not_found',
          `There is no wow skill named ${name}. read_skills lists every skill; only those in the groups yours and wow have a text here.`,
        );
      }
      return {
        name: skill.name,
        description: skill.description,
        group: skillGroupOf(skill),
        text: skill.text ?? '',
        changeable: skill.source === 'yours',
      };
    },
  }),
  read_calendar: reader({
    description:
      "Calendar cards with what they start, and Outlook meetings with their times and titles only. Without a range: from now for the calendar's lookahead. A repeating card is one card: it lists its rule in words, when it fires next, the days skipped by hand and its occurrences in the range with what happened at those already reached.",
    input: z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      })
      .strict(),
    read: ({ from, to }, deps) => {
      const start = from === undefined ? deps.clock() : new Date(from);
      const end =
        to === undefined
          ? new Date(start.getTime() + deps.settings.get('calendar.lookaheadDays') * 86_400_000)
          : new Date(to);
      const rows = deps.db.select().from(t.calendarItems).orderBy(asc(t.calendarItems.start)).all();
      const range =
        end.getTime() > start.getTime()
          ? readCalendarRange(
              deps.db,
              { from: start.toISOString(), to: end.toISOString() },
              deps.settings.get('calendar.maxOccurrences'),
            )
          : { occurrences: [] as CalendarOccurrence[], more: [] as string[] };
      const inRange = new Map<string, CalendarOccurrence[]>();
      for (const occurrence of range.occurrences) {
        const kept = inRange.get(occurrence.cardId);
        if (kept) kept.push(occurrence);
        else inRange.set(occurrence.cardId, [occurrence]);
      }
      const times = (item: (typeof rows)[number]) => ({
        title: item.title,
        start: item.start,
        end: item.end,
        zone: item.zone,
      });
      return {
        from: start.toISOString(),
        to: end.toISOString(),
        cards: rows
          .filter((item) => item.source === 'local' && inRange.has(item.id))
          .map((item) => ({
            id: item.id,
            ...times(item),
            projectId: item.projectId,
            workflowId: item.workflowId,
            backlogItemId: item.backlogItemId,
            runId: item.runId,
            state: item.state,
            nextAt: item.nextAt,
            ...(item.repeat
              ? {
                  repeat: item.repeat,
                  repeats: repeatRuleWords(item.repeat, { start: item.start, zone: item.zone }),
                  skippedDates: item.skippedDates,
                  occurrences: (inRange.get(item.id) ?? []).map((occurrence) => ({
                    date: occurrence.date,
                    start: occurrence.start,
                    end: occurrence.end,
                    outcome: occurrence.record?.outcome ?? null,
                    runId: occurrence.record?.runId ?? null,
                    reason: occurrence.record?.reason ?? null,
                  })),
                  moreOccurrences: range.more.includes(item.id),
                }
              : {}),
            path: `/calendar?item=${encodeURIComponent(item.id)}`,
          })),
        meetings: rows
          .filter(
            (item) =>
              item.source === 'outlook' &&
              Date.parse(item.end) >= start.getTime() &&
              Date.parse(item.start) <= end.getTime(),
          )
          .map((item) => ({ ...times(item), allDay: item.allDay, state: item.state })),
      };
    },
  }),
  read_backlog: reader({
    description: 'Backlog items with their state, tags and the issue they were published as.',
    input: none,
    read: (_args, deps) =>
      deps.db
        .select()
        .from(t.backlogItems)
        .orderBy(asc(t.backlogItems.createdAt))
        .all()
        .map((item) => ({
          id: item.id,
          title: item.title,
          body: item.body,
          tags: item.tags,
          state: item.state,
          runId: item.runId,
          remote: item.remote,
          path: `/backlog/${encodeURIComponent(item.id)}`,
        })),
  }),
  read_runs: reader({
    description:
      'Workflow runs and plan runs with their state, newest first: each step with its state and error, never what an agent wrote. Give live to read only runs that are running or waiting, and limit to read fewer.',
    input: z
      .object({
        live: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    read: ({ live, limit }, deps) => {
      const cut = <T>(rows: T[]): T[] => (limit === undefined ? rows : rows.slice(0, limit));
      const workflows = new Map(
        deps.db
          .select()
          .from(t.workflows)
          .all()
          .map((workflow) => [workflow.id, workflow]),
      );
      const runs = deps.db
        .select()
        .from(t.workflowRuns)
        .orderBy(desc(t.workflowRuns.startedAt))
        .all()
        .filter((run) => !live || isLive(run.state));
      const planRuns = deps.db
        .select()
        .from(t.planRuns)
        .orderBy(desc(t.planRuns.startedAt))
        .all()
        .filter((run) => !live || isLive(run.state));
      return {
        runs: cut(runs).map((run) => {
          const workflow = workflows.get(run.workflowId);
          return {
            id: run.id,
            workflowId: run.workflowId,
            workflow: workflow?.name ?? null,
            projectId: run.projectId,
            calendarItemId: run.calendarItemId,
            backlogItemId: run.backlogItemId,
            state: run.state,
            currentStep: run.currentStep,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            steps: run.steps.map((step) => ({
              stepId: step.stepId,
              skill:
                workflow?.steps.find((candidate) => candidate.id === step.stepId)?.skillName ??
                null,
              state: step.state,
              attempt: step.attempt ?? 1,
              error: step.error ?? null,
              gate: step.gate?.state ?? null,
              artifactsFound: step.artifactsFound,
            })),
            unit: run.unit ? { planRunId: run.unit.planRunId, unitKey: run.unit.unitKey } : null,
            startedByEvent: run.event
              ? { triggerId: run.event.triggerId, event: run.event.event, url: run.event.url }
              : null,
            workingCopy: run.workingCopy
              ? { state: run.workingCopy.state, error: run.workingCopy.error }
              : null,
            path: runPath(run.id),
          };
        }),
        planRuns: cut(planRuns).map((planRun) => ({
          id: planRun.id,
          planId: planRun.planId,
          projectId: planRun.projectId,
          intentId: planRun.intentId,
          workflowId: planRun.workflowId,
          state: planRun.state,
          units: planRun.units,
          waitingFor: planRun.waitingFor,
          message: planRun.message,
          startedAt: planRun.startedAt,
          endedAt: planRun.endedAt,
          path: `/plans/${encodeURIComponent(planRun.projectId)}/${encodeURIComponent(planRun.intentId)}`,
        })),
      };
    },
  }),
  read_triggers: reader({
    description:
      'Triggers: the time triggers of calendar cards with their state, and event triggers with whether they are on.',
    input: none,
    read: (_args, deps) => {
      const cards = new Map(
        deps.db
          .select({ id: t.calendarItems.id, title: t.calendarItems.title })
          .from(t.calendarItems)
          .all()
          .map((card) => [card.id, card.title]),
      );
      return deps.db
        .select()
        .from(t.triggers)
        .orderBy(asc(t.triggers.runAt), asc(t.triggers.createdAt), asc(t.triggers.id))
        .all()
        .map((trigger) =>
          isCardTrigger(trigger)
            ? {
                id: trigger.id,
                kind: trigger.kind,
                workflowId: trigger.workflowId,
                cardId: trigger.calendarItemId,
                card: cards.get(trigger.calendarItemId) ?? null,
                // For a repeating card, the next occurrence it fires at.
                runAt: trigger.runAt,
                zone: trigger.zone,
                state: trigger.state,
                runId: trigger.runId,
              }
            : {
                id: trigger.id,
                kind: trigger.kind,
                workflowId: trigger.workflowId,
                projectId: trigger.projectId,
                event: trigger.event,
                enabled: trigger.enabled,
                lastRunId: trigger.runId,
              },
        );
    },
  }),
  read_notifications: reader({
    description:
      'What the app told the user: runs that started, wait or failed, newest first. Give limit to read fewer.',
    input: z.object({ limit: z.number().int().positive().optional() }).strict(),
    read: ({ limit }, deps) => {
      const rows = deps.db.select().from(t.notifications).orderBy(desc(t.notifications.at)).all();
      return (limit === undefined ? rows : rows.slice(0, limit)).map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        title: row.title,
        body: row.body,
        path: row.path,
        runId: row.runId,
      }));
    },
  }),
  read_connections: reader({
    description:
      'How the connections stand: each provider instance from its last test, and what the last read of each host said for followed plans and live runs. To test a tracker or host sign-in now, use test_connection.',
    input: none,
    read: (_args, deps) => {
      return {
        providers: deps.db
          .select()
          .from(t.providerInstances)
          .orderBy(asc(t.providerInstances.name))
          .all()
          .map((instance) => ({
            id: instance.id,
            name: instance.name,
            tested: instance.status !== 'unknown',
            ok: instance.status === 'ready',
            account: instance.account,
            message: instance.statusMessage,
          })),
        hostReads: [
          ...deps.db.select().from(t.hostReads).orderBy(asc(t.hostReads.id)).all(),
          ...deps.db.select().from(t.ticketReads).orderBy(asc(t.ticketReads.id)).all(),
          ...deps.db.select().from(t.pageReads).orderBy(asc(t.pageReads.id)).all(),
        ].map(lastRead),
      };
    },
  }),
  test_connection: reader({
    description:
      'Signs in to Jira, GitHub, GitLab or Confluence with the stored settings, as "Test connection" in Settings does, and says passed or the host\'s refusal in words, the account the host answered with, and the settings still missing. Give a projectId to test with that project\'s settings.',
    input: z
      .object({ service: TrackerConnection, projectId: z.string().min(1).optional() })
      .strict(),
    read: async ({ service, projectId }, deps) => {
      const result = await deps.trackers.test(service, projectId);
      return {
        service: result.service,
        passed: result.ok,
        account: result.account,
        version: result.version,
        message: result.message,
        missing: result.missing,
      };
    },
  }),
} as const;

export type ReaderName = keyof typeof readers;
