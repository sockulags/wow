import {
  Command,
  hideSecrets,
  hideSecretsDeep,
  secretPatterns,
  type AssistantChangeRecord,
  type AssistantProposalRecord,
  type CommandType,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import { assistantChanges, assistantProposals } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { checkProjectFolder } from '../rpc/handlers.js';
import { RpcFault } from '../rpc/router.js';
import { asks } from './asks.js';
import { alwaysRefused } from './classes.js';
import { diagnosisReaders } from './diagnosis.js';
import { guideReaders } from './guides.js';
import { readers, type Reader, type ReaderDeps } from './readers.js';

// The assistant's tools (app assistant spec 4 to 13). A read tool is a reader. A change tool
// builds one command a view could send and dispatches it with the assistant's origin; what
// happens to it (applied, held as a proposal, refused) is the server's class table's to say,
// not the tool's.

interface ChangeTool {
  readonly type: CommandType;
  readonly description: string;
  // The id of the thing the command makes. The tool makes it up, as a view does.
  readonly newId?: string;
  // Fields of the command the assistant never fills in.
  readonly withheld?: readonly string[];
}

const waits = 'This waits for the user: it becomes a proposal with Yes and No.';

export const changeTools = {
  set_setting: {
    type: 'setting.set',
    description:
      'Sets a setting. scope is "global" or "project:<id>". Read the setting first for its allowed values. Secret settings cannot be set here. A few settings that let the app do more on its own become a proposal, and so does the address of a tracker whose token is set.',
  },
  reset_setting: {
    type: 'setting.reset',
    description: 'Takes a stored setting value away, so the default (or the global value) applies.',
  },
  create_project: {
    type: 'project.create',
    newId: 'projectId',
    description: 'Adds a project: a name and the full path of a folder that exists.',
  },
  update_project: {
    type: 'project.update',
    description: "Changes a project's name, folder, default provider instance or default model.",
  },
  create_card: {
    type: 'card.create',
    newId: 'cardId',
    withheld: ['skippedDates'],
    description:
      'Puts a card on the calendar. Times are instants with an offset; zone is the IANA zone they were meant in. With a project and a workflow the card starts that workflow at its start time. For anything that recurs, give repeat and make one card: start and end are the first occurrence, and every later one has the same local time and length in zone. repeat is {frequency: "daily"|"weekly"|"monthly", interval (1 = every day, week or month), weekdays (weekly only, e.g. ["mon","tue","wed","thu","fri"]), end: {kind: "never"} | {kind: "on", date: "YYYY-MM-DD"} | {kind: "after", count}}. Monthly falls on the start\'s day of the month. Never make one card per day.',
  },
  update_card: {
    type: 'card.update',
    description:
      'Moves, renames or relinks a card, or changes how it repeats. Give only what changes; null takes a link away, and repeat: null makes a repeating card happen once. On a repeating card a change applies to every occurrence that has not started; the ones that ran keep their runs.',
  },
  skip_card_occurrence: {
    type: 'card.skipOccurrence',
    description:
      "Skips one occurrence of a repeating card: date is its day (YYYY-MM-DD) in the card's zone. The rest of the series is untouched. read_calendar lists the occurrences and when each card fires next.",
  },
  delete_card: {
    type: 'card.delete',
    withheld: ['stopRun'],
    description:
      'Removes a card; a repeating card goes with its whole series. To leave out one occurrence, use skip_card_occurrence. Refused while its run is live.',
  },
  start_card_run: {
    type: 'card.runNow',
    newId: 'runId',
    description: `Starts a card's workflow now. ${waits}`,
  },
  create_workflow: {
    type: 'workflow.create',
    newId: 'workflowId',
    description:
      'Creates a workflow from steps. A step with a permission mode, a gate condition or rules, and the switches "for units" and "own working copy", make it a proposal.',
  },
  update_workflow: {
    type: 'workflow.update',
    description:
      'Changes a workflow. Give steps as the whole new list. Changing a permission mode, a gate, a gate condition, rules, "for units" or "own working copy" makes it a proposal; so does changing the skill, extra prompt, provider, model or skills of a step that has a permission mode or a gate that passes by itself. A step names its skill with skillName and, for a wow skill, skillSource ("yours" or "wow"); alsoFollow lists more skills ({name, source?}, source as read_skills gives it) whose texts or invocations go after its own; leaveOut names built-in skills wow would attach by itself (wow-verdict, wow-artifacts, wow-pull-request) that this step goes without.',
  },
  delete_workflow: {
    type: 'workflow.delete',
    description: 'Deletes a workflow. Refused while a run of it is live.',
  },
  start_run: {
    type: 'workflowRun.start',
    newId: 'runId',
    description: `Starts a workflow in a project now. ${waits}`,
  },
  create_backlog_item: {
    type: 'backlog.create',
    newId: 'backlogItemId',
    description: 'Adds a backlog item.',
  },
  update_backlog_item: {
    type: 'backlog.update',
    description: "Changes a backlog item's title, body, tags or state.",
  },
  delete_backlog_item: {
    type: 'backlog.delete',
    description: 'Deletes a backlog item. Refused while a run of it is live.',
  },
  plan_backlog_item: {
    type: 'backlog.plan',
    newId: 'cardId',
    description:
      'Plans a backlog item on the calendar: a card with a workflow, a project and a time, and the item becomes planned.',
  },
  follow_plan: {
    type: 'plan.follow',
    description:
      'Follows or stops following a plan (planId is "<projectId>:<intentId>"), so its pull requests are read from the host.',
  },
  start_plan_run: {
    type: 'planRun.start',
    newId: 'planRunId',
    description: `Runs the ready units of a plan with a workflow marked "for units". ${waits}`,
  },
  create_trigger: {
    type: 'trigger.create',
    newId: 'triggerId',
    description: `Makes an event trigger: a workflow starts when a pull request in the project is merged, its checks fail or a review comment arrives. ${waits}`,
  },
  set_trigger_enabled: {
    type: 'trigger.setEnabled',
    description: 'Turns an event trigger on or off. Turning one on becomes a proposal.',
  },
  delete_trigger: { type: 'trigger.delete', description: 'Deletes an event trigger.' },
  create_skill: {
    type: 'skill.create',
    description: `Writes one of your own skills: skill is {name, description, text}. The name has lower case letters, digits and single hyphens, does not start with wow- and is not taken by another wow skill; description says when to use it; text is what the agent is told. ${waits}`,
  },
  update_skill: {
    type: 'skill.update',
    description: `Changes one of your own skills: skill is {name, description, text}, the whole new skill under its name. Built-in skills and skills from folders cannot be changed. ${waits}`,
  },
  delete_skill: {
    type: 'skill.delete',
    description: `Removes one of your own skills by name. Built-in skills and skills from folders cannot be removed. ${waits}`,
  },
} as const satisfies Record<string, ChangeTool>;

export type ChangeToolName = keyof typeof changeTools;

function commandShape(type: CommandType) {
  const option = Command.options.find((candidate) => candidate.shape.type.value === type);
  if (!option) throw new Error(`No command ${type}`);
  return option;
}

// A change tool takes its command's own fields, without the type and what the tool fills in.
function inputOf(tool: ChangeTool): z.ZodType {
  const hidden = ['type', ...(tool.newId ? [tool.newId] : []), ...(tool.withheld ?? [])];
  const shape = Object.fromEntries(
    Object.entries(commandShape(tool.type).shape).filter(([key]) => !hidden.includes(key)),
  );
  return z.object(shape).strict();
}

export interface ToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  // JSON, with anything that looks like a secret already hidden.
  readonly text: string;
  readonly isError: boolean;
}

export interface AssistantToolsDeps extends ReaderDeps {
  readonly engine: Engine;
  readonly logger: Logger;
}

const changeRow = ({ id, what, from, to, place }: AssistantChangeRecord) => ({
  id,
  what,
  from,
  to,
  place,
});

const proposalRow = ({ id, title, lines, place }: AssistantProposalRecord) => ({
  id,
  title,
  lines,
  place,
});

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'It failed without saying why.';

const problems = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');

// Tools that only read, whatever file they live in.
const looks: Readonly<Record<string, Reader>> = {
  ...readers,
  ...guideReaders,
  ...diagnosisReaders,
  ...asks,
};

const failed = (outcome: string, reason: string) => ({
  content: { outcome, reason },
  isError: true,
});

export class AssistantTools {
  readonly #deps: AssistantToolsDeps;
  readonly #inputs = new Map<string, z.ZodType>();

  constructor(deps: AssistantToolsDeps) {
    this.#deps = deps;
    for (const [name, tool] of Object.entries(looks)) {
      this.#inputs.set(name, tool.input);
    }
    for (const [name, tool] of Object.entries<ChangeTool>(changeTools)) {
      // The table has the last word either way; a tool for a command it always refuses would
      // only offer something that cannot happen.
      if (alwaysRefused(tool.type))
        throw new Error(`${name} offers ${tool.type}, which is refused`);
      this.#inputs.set(name, inputOf(tool));
    }
  }

  list(): ToolDescription[] {
    const described: Record<string, { description: string }> = { ...looks, ...changeTools };
    return [...this.#inputs].map(([name, input]) => ({
      name,
      description: described[name]?.description ?? name,
      inputSchema: z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }),
    }));
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    const { content, isError } = await this.#run(name, args);
    // The log says which tool ran and how it ended, never what went in or came out. A name
    // that is not a tool's is something that went in.
    this.#deps.logger.debug('assistant tool', {
      tool: this.#inputs.has(name) ? name : 'unknown',
      outcome: isError ? 'failed' : ((content as { outcome?: string }).outcome ?? 'read'),
    });
    return { text: JSON.stringify(hideSecretsDeep(content, this.#patterns())), isError };
  }

  #patterns(): RegExp[] {
    return secretPatterns(this.#deps.settings.get('assistant.secretPatterns'));
  }

  async #run(name: string, args: unknown): Promise<{ content: unknown; isError: boolean }> {
    const input = this.#inputs.get(name);
    if (!input) return failed('unknown tool', `There is no tool ${name}.`);
    const parsed = input.safeParse(args ?? {});
    if (!parsed.success) return failed('invalid input', problems(parsed.error));
    try {
      const look = Object.hasOwn(looks, name) ? looks[name] : undefined;
      if (look) return { content: await look.read(parsed.data, this.#deps), isError: false };
      const tool: ChangeTool = changeTools[name as ChangeToolName];
      return await this.#change(tool, parsed.data as Record<string, unknown>);
    } catch (error) {
      // The app's own reason, as it would tell the user (spec 12).
      if (error instanceof CommandRejected || error instanceof RpcFault) {
        return failed('refused', error.message);
      }
      if (error instanceof z.ZodError) return failed('invalid input', problems(error));
      // The error's own words can quote what the tool was given, so the log gets them through
      // the same net as the result.
      const reason = hideSecrets(reasonOf(error), this.#patterns());
      this.#deps.logger.error(`assistant tool ${name} failed`, reason);
      return failed('failed', reason);
    }
  }

  async #change(
    tool: ChangeTool,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> {
    const made = tool.newId ? { [tool.newId]: randomUUID() } : {};
    const command = Command.parse({ ...args, ...made, type: tool.type });
    await checkProjectFolder(command);
    const commandId = `assistant-${randomUUID()}`;
    this.#deps.engine.dispatch(commandId, command, 'assistant');
    const { db } = this.#deps;
    const change = db
      .select()
      .from(assistantChanges)
      .where(eq(assistantChanges.id, commandId))
      .get();
    if (change) {
      return {
        content: { outcome: 'changed', ...made, change: changeRow(change) },
        isError: false,
      };
    }
    const proposal = db
      .select()
      .from(assistantProposals)
      .where(eq(assistantProposals.id, commandId))
      .get();
    if (proposal) {
      return {
        content: {
          outcome: 'proposed',
          note: 'Nothing has changed. The user sees this proposal and answers Yes or No; you cannot answer it. If the user says yes, these ids are the ones that will exist.',
          ...made,
          proposal: proposalRow(proposal),
        },
        isError: false,
      };
    }
    return {
      content: { outcome: 'unchanged', note: 'It is already so; nothing changed.' },
      isError: false,
    };
  }
}
