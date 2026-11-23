import {
  QuestionReply,
  TextItemPayload,
  ToolCallItemPayload,
  type ServerCommand,
} from '@wow/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDescription, ToolResult } from '../assistant/tools.js';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { providerInstances, questions, threadItems, threads, turns } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { readMainWorktree, type GitRunOptions } from '../projects/git.js';
import type { HelperToolProvider } from './endpoint.js';

// wow's helper tools (agent orchestration spec 2): what a chat thread's agent can do with helper
// threads. Each call is for the thread whose token called it; a command goes to the engine with
// the `helper` origin, which decides it as the user's own thread commands.

export interface HelperToolsDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly logger: Logger;
  readonly git: () => GitRunOptions;
  // wow's own home, where no helper may work (orchestrator threads, Security).
  readonly home: string;
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

// Whether `folder` is `parent` or inside it; a name such as "..x" is inside.
function within(parent: string, folder: string): boolean {
  const inside = path.relative(parent, folder);
  return (
    inside === '' ||
    (inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))
  );
}

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
        description: `Starts a helper thread: another agent, on any connected Claude Code or Codex instance (list_helpers names them), that gets your brief as its first message. ${when} Write the brief as you would for a colleague: the goal, what you know, what to leave alone and what to report. By default it works in your folder, as a subagent does; "folder" names another one (absolute, or relative to yours), such as another repository the task touches. Isolation "copy" gives it its own working copy on a new branch of the Git repository that holds that folder. It runs on its own and its answer comes back to you; read_helper shows how it stands and what it answered. Its approvals are the person's.`,
        input: z
          .object({
            brief: z.string().trim().min(1),
            title: z.string().trim().min(1).max(200).optional(),
            instance: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            effort: z.string().min(1).optional(),
            folder: z.string().trim().min(1).optional(),
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
      folder?: string | undefined;
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
    const parent = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!parent) throw new CommandRejected('not_found', `There is no thread ${threadId}.`);
    let folder =
      args.folder === undefined ? undefined : await this.#folder(parent.cwd, args.folder);
    if (isolation === 'copy') {
      // A copy is a worktree of the repository that holds the named folder, else this thread's
      // own (spec 5). It is made from, and comes home to, that repository's main worktree: not a
      // subfolder, and not another thread's worktree, which goes away when that thread is done.
      const base = folder ?? parent.cwd;
      const main = await readMainWorktree(base, this.#deps.git());
      const real = main === undefined ? undefined : await realpath(main).catch(() => undefined);
      if (real === undefined) {
        throw new CommandRejected(
          'rejected',
          `${base} is not in a Git repository, so no working copy can be made of it.`,
        );
      }
      folder = real;
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
      ...(folder === undefined ? {} : { folder }),
      isolation,
    });
    return { id: helperId, title, isolation, started: true };
  }

  // The folder a helper is to work in (spec 5, Security): absolute or relative to the starting
  // thread's own, an existing folder, and not in wow's home unless it is in the starting
  // thread's own folder (a working copy or a thread folder that wow keeps there).
  async #folder(from: string, named: string): Promise<string> {
    const resolved = path.resolve(from, named);
    const real = await realpath(resolved).catch(() => undefined);
    const kind = real === undefined ? undefined : await stat(real).catch(() => undefined);
    if (real === undefined || !kind?.isDirectory()) {
      throw new CommandRejected('rejected', `There is no folder ${resolved}.`);
    }
    const home = await realpath(this.#deps.home).catch(() => path.resolve(this.#deps.home));
    const own = await realpath(from).catch(() => path.resolve(from));
    if (within(home, real) && !(within(home, own) && within(own, real))) {
      throw new CommandRejected('rejected', `A helper does not work in wow's own folder ${home}.`);
    }
    return real;
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
