import {
  QuestionReply,
  TextItemPayload,
  ToolCallItemPayload,
  type ServerCommand,
} from '@wow/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDescription, ToolResult } from '../assistant/tools.js';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import {
  projects,
  providerInstances,
  questions,
  threadItems,
  threads,
  turns,
} from '../db/schema.js';
import type { Logger } from '../logger.js';
import { readSnapshotRepository, type GitRunOptions } from '../projects/git.js';
import type { HelperToolProvider } from './endpoint.js';

// wow's helper tools (agent orchestration spec 2): what a chat thread's agent can do with helper
// threads. Each call is for the thread whose token called it; a command goes to the engine with
// the `helper` origin, which decides it as the user's own thread commands.

export interface HelperToolsDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly logger: Logger;
  readonly git: () => GitRunOptions;
}

interface Tool {
  readonly description: string;
  readonly input: z.ZodObject;
  run(threadId: string, args: never): Promise<unknown>;
}

const id = z.string().min(1);

// Said in every description, so the agent reaches for a helper when it helps, not by habit.
const when =
  'Use a helper only when the task needs a second agent (another provider’s view, a review, work that can run beside yours) or the person asks for one; do the work yourself otherwise.';

const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value), isError: false });
const refusal = (message: string): ToolResult => ({
  text: JSON.stringify({ error: message }),
  isError: true,
});

export class HelperTools implements HelperToolProvider {
  readonly #deps: HelperToolsDeps;
  readonly #tools: Readonly<Record<string, Tool>>;

  constructor(deps: HelperToolsDeps) {
    this.#deps = deps;
    this.#tools = {
      start_helper: {
        description: `Starts a helper thread: another agent, on any connected Claude Code or Codex instance (list_helpers names them), that gets your brief as its first message. ${when} Write the brief as you would for a colleague: the goal, what you know, what to leave alone and what to report. By default it works in your folder, as a subagent does; isolation "copy" gives it its own working copy on a new branch (a project in Git only). It runs on its own; read_helper shows how it stands and what it answered. Its approvals are the person's.`,
        input: z
          .object({
            brief: z.string().trim().min(1),
            title: z.string().trim().min(1).max(200).optional(),
            instance: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            effort: z.string().min(1).optional(),
            isolation: z.enum(['folder', 'copy']).optional(),
          })
          .strict(),
        run: (threadId, args) => this.#start(threadId, args),
      },
      list_helpers: {
        description: `Lists your helper threads with how each stands, and the provider instances a helper can run on. ${when}`,
        input: z.object({}).strict(),
        run: (threadId) => Promise.resolve(this.#list(threadId)),
      },
      read_helper: {
        description:
          'Reads one of your helpers: its state, what it runs now, a question it waits on, and the last thing it answered.',
        input: z.object({ id }).strict(),
        run: (threadId, args: { id: string }) => Promise.resolve(this.#read(threadId, args.id)),
      },
      write_to_helper: {
        description:
          'Sends one of your helpers a message: a follow-up or a correction. While it works the message waits for its turn to end.',
        input: z.object({ id, text: z.string().trim().min(1) }).strict(),
        run: (threadId, args: { id: string; text: string }) =>
          Promise.resolve(
            this.#dispatch({
              type: 'helper.write',
              threadId: args.id,
              parentThreadId: threadId,
              text: args.text,
            }),
          ),
      },
      answer_helper_question: {
        description:
          'Answers a question one of your helpers asked (wow tells you, or read_helper shows it), when what you know settles it. If it does not, tell the person the question waits for them. Approvals are never yours to answer.',
        input: z.object({ id, questionId: id, reply: QuestionReply }).strict(),
        run: (threadId, args: { id: string; questionId: string; reply: QuestionReply }) =>
          Promise.resolve(
            this.#dispatch({
              type: 'helper.answer',
              threadId: args.id,
              parentThreadId: threadId,
              questionId: args.questionId,
              reply: args.reply,
            }),
          ),
      },
      stop_helper: {
        description: 'Stops the running turn of one of your helpers; what it did so far stays.',
        input: z.object({ id }).strict(),
        run: (threadId, args: { id: string }) =>
          Promise.resolve(
            this.#dispatch({ type: 'helper.stop', threadId: args.id, parentThreadId: threadId }),
          ),
      },
    };
  }

  tools(threadId: string) {
    return {
      list: (): ToolDescription[] =>
        Object.entries(this.#tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }),
        })),
      call: async (name: string, args: unknown): Promise<ToolResult> => {
        const tool = Object.hasOwn(this.#tools, name) ? this.#tools[name] : undefined;
        if (!tool) return refusal(`No tool ${name}`);
        const parsed = tool.input.safeParse(args ?? {});
        if (!parsed.success) return refusal(z.prettifyError(parsed.error));
        try {
          const answer = await tool.run(threadId, parsed.data as never);
          this.#deps.logger.info('helper tool', { name, outcome: 'ok' });
          return json(answer);
        } catch (error) {
          this.#deps.logger.info('helper tool', { name, outcome: 'refused' });
          if (error instanceof CommandRejected) return refusal(error.message);
          throw error;
        }
      },
    };
  }

  #dispatch(command: ServerCommand): { readonly done: true } {
    this.#deps.engine.dispatch(randomUUID(), command, 'helper');
    return { done: true };
  }

  #instances() {
    return this.#deps.db.select().from(providerInstances).all();
  }

  async #start(
    threadId: string,
    args: {
      brief: string;
      title?: string | undefined;
      instance?: string | undefined;
      model?: string | undefined;
      effort?: string | undefined;
      isolation?: 'folder' | 'copy' | undefined;
    },
  ) {
    const instance =
      args.instance === undefined
        ? undefined
        : this.#instances().find(
            (row) =>
              row.id === args.instance || row.name.toLowerCase() === args.instance?.toLowerCase(),
          );
    if (args.instance !== undefined && !instance) {
      throw new CommandRejected(
        'not_found',
        `There is no provider instance "${args.instance}". list_helpers names them.`,
      );
    }
    const isolation = args.isolation ?? 'folder';
    if (isolation === 'copy') {
      const parent = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
      const project =
        parent?.projectId == null
          ? undefined
          : this.#deps.db.select().from(projects).where(eq(projects.id, parent.projectId)).get();
      const repository = project
        ? await readSnapshotRepository(project.cwd, this.#deps.git())
        : undefined;
      if (repository?.status !== 'ok') {
        throw new CommandRejected(
          'rejected',
          repository?.message ??
            'A helper gets its own working copy only in a project; this thread has none.',
        );
      }
    }
    const helperId = randomUUID();
    const title = args.title ?? args.brief.split('\n')[0]?.slice(0, 200) ?? 'Helper';
    this.#dispatch({
      type: 'helper.start',
      threadId: helperId,
      parentThreadId: threadId,
      title,
      brief: args.brief,
      ...(instance ? { providerInstanceId: instance.id } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      isolation,
    });
    return { id: helperId, title, isolation, started: true };
  }

  #lastTurn(threadId: string) {
    return this.#deps.db
      .select()
      .from(turns)
      .where(eq(turns.threadId, threadId))
      .orderBy(desc(turns.index))
      .get();
  }

  // How a helper stands, in a few words the agent can act on.
  #standing(helper: typeof threads.$inferSelect) {
    const instance = this.#instances().find((row) => row.id === helper.providerInstanceId);
    const turn = this.#lastTurn(helper.id);
    const items = turn
      ? this.#deps.db
          .select()
          .from(threadItems)
          .where(eq(threadItems.turnId, turn.id))
          .orderBy(asc(threadItems.index))
          .all()
      : [];
    const calls = items.flatMap((item) => {
      if (item.kind !== 'tool_call') return [];
      const parsed = ToolCallItemPayload.safeParse(item.payload);
      return parsed.success ? [parsed.data] : [];
    });
    const running = calls.findLast((call) => call.status === 'running');
    const answer = TextItemPayload.safeParse(
      items.findLast((item) => item.kind === 'assistant_text')?.payload,
    );
    const question = this.#deps.db
      .select()
      .from(questions)
      .where(and(eq(questions.threadId, helper.id)))
      .all()
      .find((row) => row.answer === null);
    return {
      id: helper.id,
      title: helper.title,
      instance: instance?.name ?? helper.providerInstanceId,
      provider: instance?.kind,
      state: helper.state,
      folder: helper.cwd,
      ...(running
        ? { runsNow: running.command ?? running.tool ?? running.path ?? running.name }
        : {}),
      toolCalls: calls.length,
      ...(question ? { waitsOnQuestion: { id: question.id, asks: question.request } } : {}),
      ...(helper.state === 'needs_you' && !question
        ? { waitsOn: 'an approval, which only the person gives' }
        : {}),
      ...(answer.success ? { lastAnswer: answer.data.text } : {}),
    };
  }

  #helpers(threadId: string) {
    return this.#deps.db
      .select()
      .from(threads)
      .where(eq(threads.parentThreadId, threadId))
      .orderBy(asc(threads.createdAt))
      .all();
  }

  #list(threadId: string) {
    return {
      helpers: this.#helpers(threadId).map((helper) => {
        const { lastAnswer: _answer, folder: _folder, ...short } = this.#standing(helper);
        return short;
      }),
      instances: this.#instances().map((row) => ({
        name: row.name,
        provider: row.kind,
        connected: row.status === 'ready',
        defaultModel: row.defaultModel,
      })),
    };
  }

  #read(threadId: string, helperId: string) {
    const helper = this.#helpers(threadId).find((row) => row.id === helperId);
    if (!helper) throw new CommandRejected('not_found', `You have no helper ${helperId}.`);
    return this.#standing(helper);
  }
}
