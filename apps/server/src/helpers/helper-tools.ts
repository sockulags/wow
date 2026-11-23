import {
  fillTemplate,
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
import {
  projects,
  providerInstances,
  questions,
  threadItems,
  threads,
  turns,
} from '../db/schema.js';
import type { Logger } from '../logger.js';
import {
  readCommitsAhead,
  readCurrentBranch,
  readMainWorktree,
  type GitRunOptions,
} from '../projects/git.js';
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
  // `chat.mergeBrief`, read when a merge helper starts (spec 12).
  readonly mergeBrief: () => string;
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
        description: `Starts a helper thread: another agent, on any connected Claude Code or Codex instance (list_helpers names them), that gets your brief as its first message. ${when} Write the brief as you would for a colleague: the goal, what you know, what to leave alone and what to report. By default it works in your folder, as a subagent does; "folder" names another one (absolute, or relative to yours), such as another repository the task touches. Isolation "copy" gives it its own working copy on a new branch of the Git repository that holds that folder; tell it to commit its work there, since only commits are on its branch. It runs on its own and its answer comes back to you; read_helper shows how it stands and what it answered. When two or more of your helpers worked in their own copies of one repository, have their work merged with merge_helpers before you report. Its approvals are the person's.`,
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
          'Reads one of your helpers: its state, what it runs now, a question it waits on, the last thing it answered, and where its work is: its folder, the repository, its branch and how many commits it made there (`ahead`; work it did not commit is not on its branch).',
        input: z.object({ id }).strict(),
        run: (threadId, args: { id: string }) => this.#read(threadId, args.id),
      },
      merge_helpers: {
        description:
          'Has the work of two or more of your helpers, each in its own copy of the same repository, merged into one branch: starts a merge helper in a new copy of that repository that merges their branches in the order you give, resolves conflicts and reports. Use it when helpers worked side by side on one task, before you report, so the person reviews one branch; then tell them the merge helper holds the result. The helpers must be done working, and only what they committed is merged: brief a copy helper to commit its work, and check `ahead` with read_helper. The answer gives the commits on each branch.',
        input: z
          .object({
            ids: z.array(id).min(2),
            title: z.string().trim().min(1).max(200).optional(),
            instance: z.string().min(1).optional(),
            model: z.string().min(1).optional(),
            effort: z.string().min(1).optional(),
          })
          .strict(),
        run: (threadId, args) => this.#merge(threadId, args),
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

  async #read(threadId: string, helperId: string) {
    const helper = this.#helpers(threadId).find((row) => row.id === helperId);
    if (!helper) throw new CommandRejected('not_found', `You have no helper ${helperId}.`);
    return { ...this.#standing(helper), ...(await this.#whereWork(helper)) };
  }

  // Where a helper's work is (spec 6): its folder, the repository's main worktree, the branch it
  // is on, and for its own copy how many commits it made since the copy was made.
  async #whereWork(helper: typeof threads.$inferSelect) {
    const git = this.#deps.git();
    const copy = helper.workingCopy;
    const repository = await this.#repositoryOf(helper);
    const branch = (await readCurrentBranch(helper.cwd, git)) ?? helper.branch;
    const ahead = copy?.startSha ? await readCommitsAhead(helper.cwd, copy.startSha, git) : null;
    return {
      folder: helper.cwd,
      repository: repository ?? null,
      branch: branch ?? null,
      ownCopy: liveCopy(helper),
      ...(ahead === null ? {} : { ahead }),
    };
  }

  // The main worktree of the repository a helper works in. A copy made since U1 records it; an
  // older copy is of its project's repository, and a helper in a folder is in that folder's. Read
  // through Git and realpath, so two names of one repository compare equal.
  async #repositoryOf(helper: typeof threads.$inferSelect): Promise<string | undefined> {
    if (helper.workingCopy?.repository) return helper.workingCopy.repository;
    const project =
      helper.projectId === null
        ? undefined
        : this.#deps.db.select().from(projects).where(eq(projects.id, helper.projectId)).get()?.cwd;
    const folder = helper.workingCopy ? project : helper.cwd;
    if (folder === undefined) return undefined;
    const main = await readMainWorktree(folder, this.#deps.git());
    return main === undefined ? undefined : realpath(main).catch(() => main);
  }

  // A merge helper (spec 12): a helper of the caller in a new copy of the repository the named
  // helpers' copies belong to, briefed to merge their branches in the order given.
  async #merge(
    threadId: string,
    args: {
      ids: string[];
      title?: string | undefined;
      instance?: string | undefined;
      model?: string | undefined;
      effort?: string | undefined;
    },
  ) {
    const ids = [...new Set(args.ids)];
    if (ids.length < 2) {
      throw new CommandRejected('rejected', 'Name at least two different helpers to merge.');
    }
    const git = this.#deps.git();
    const mine = this.#helpers(threadId);
    const named: {
      helper: typeof threads.$inferSelect;
      branch: string;
      repository: string | undefined;
      ahead: number | null;
    }[] = [];
    for (const helperId of ids) {
      const helper = mine.find((row) => row.id === helperId);
      if (!helper) throw new CommandRejected('not_found', `You have no helper ${helperId}.`);
      if (!liveCopy(helper)) {
        throw new CommandRejected(
          'rejected',
          `"${helper.title}" has no working copy of its own, so it has no branch to merge; its work is in the folder it shares.`,
        );
      }
      if (helper.state === 'working' || this.#lastTurn(helper.id)?.state === 'running') {
        throw new CommandRejected(
          'rejected',
          `"${helper.title}" is still working. Wait for it to finish, or stop it.`,
        );
      }
      // The branch it is on now: its agent may have made and checked out a branch of its own.
      const branch = await readCurrentBranch(helper.cwd, git);
      if (branch === null) {
        throw new CommandRejected(
          'rejected',
          `"${helper.title}" is on no branch in its copy, so there is no branch to merge. Ask it to commit its work on a branch.`,
        );
      }
      const start = helper.workingCopy?.startSha;
      const ahead = start ? await readCommitsAhead(helper.cwd, start, git) : null;
      named.push({ helper, branch, repository: await this.#repositoryOf(helper), ahead });
    }
    const repositories = [...new Set(named.map((each) => each.repository))];
    const [repository] = repositories;
    if (repositories.length !== 1 || repository === undefined) {
      throw new CommandRejected(
        'rejected',
        'These helpers work in copies of different repositories; merge helpers of one repository at a time.',
      );
    }
    const template = this.#deps.mergeBrief();
    const values = {
      branches: named.map(({ branch }) => `- ${branch}`).join('\n'),
      helpers: named.map(({ helper }) => `- "${helper.title}" (id ${helper.id})`).join('\n'),
    };
    // An edited brief that forgot the branches still names them.
    const brief = template.includes('{{branches}}')
      ? fillTemplate(template, values)
      : `${fillTemplate(template, values)}\n\nBranches, in this order:\n${values.branches}`;
    const started = await this.#start(threadId, {
      brief,
      title:
        args.title ?? `Merge ${named.map(({ helper }) => helper.title).join(' + ')}`.slice(0, 200),
      instance: args.instance,
      model: args.model,
      effort: args.effort,
      folder: repository,
      isolation: 'copy',
    });
    // What each branch holds, so the caller sees a helper that committed nothing.
    return {
      ...started,
      merges: named.map(({ branch }) => branch),
      commits: Object.fromEntries(named.map(({ branch, ahead }) => [branch, ahead])),
    };
  }
}

// A copy of its own that is there to work in, or will be.
const liveCopy = (helper: typeof threads.$inferSelect) =>
  helper.workingCopy !== null &&
  helper.workingCopy.state !== 'removed' &&
  helper.workingCopy.state !== 'failed';
