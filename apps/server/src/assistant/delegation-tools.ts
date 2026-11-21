import { QuestionReply } from '@wow/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { built, type BuiltTool } from './built.js';

// The assistant's tools for delegated work (chief of staff spec 9 to 14). Each builds one of the
// delegation commands; whether it is done is the standing permissions' to say on the server.

export const delegationTools: Readonly<Record<string, BuiltTool>> = {
  start_thread: built({
    description:
      "Starts a chat thread in a project and sends its agent your first message, when the person gave you the Start threads permission for that project (read_permissions). Write the message as a brief for the agent from what the person asked: the goal, what they said, what to leave alone, and what to report. In a Git project the thread works in its own working copy, so the person's folder is untouched. Provider, model and effort default to the project's. Without the permission it is refused: offer the thread with offer_project_work instead.",
    input: z
      .object({
        projectId: z.string().min(1),
        title: z.string().trim().min(1).max(200),
        message: z.string().trim().min(1),
        providerInstanceId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        effort: z.string().min(1).optional(),
      })
      .strict(),
    build: async (args, deps) => {
      const git = (await deps.trackers.projectsGit()).find(
        (entry) => entry.projectId === args.projectId,
      );
      return {
        type: 'assistant.startThread',
        threadId: randomUUID(),
        ...args,
        ownWorkingCopy:
          git !== undefined &&
          git.status !== 'noRepository' &&
          git.status !== 'folderMissing' &&
          git.status !== 'gitUnavailable',
      };
    },
  }),
  write_to_thread: built({
    description:
      "Sends a follow-up to a thread you started, when the person gave you Drive threads for its project. Stay within what the person asked: a new piece of work is a new question to them, not a message here. You cannot write in the person's own threads.",
    input: z.object({ threadId: z.string().min(1), text: z.string().trim().min(1) }).strict(),
    build: ({ threadId, text }) => ({ type: 'assistant.sendToThread', threadId, text }),
  }),
  answer_agent_question: built({
    description:
      "Answers the question an agent asks in a thread you started (read_thread shows it), when the person gave you Drive threads and their own words in this conversation already answer it. because quotes those words; the question card shows it. If the person's words do not settle it, do not answer: tell them the question waits for them. Approvals are never yours to answer.",
    input: z
      .object({
        threadId: z.string().min(1),
        questionId: z.string().min(1),
        reply: QuestionReply,
        because: z.string().trim().min(1).max(500),
      })
      .strict(),
    build: (args) => ({ type: 'assistant.answerQuestion', ...args }),
  }),
  write_brief: built({
    description:
      'Writes the brief of a decision wow asked you about (its message names the decision id): text says what the agent did, what the decision is and what to look at, in a few sentences; recommendation is what you would do, in one sentence. The person sees it in their queue beside Approve, Send back or Allow. You never answer the decision itself.',
    input: z
      .object({
        decisionId: z.string().min(1),
        text: z.string().trim().min(1).max(1500),
        recommendation: z.string().trim().min(1).max(300),
      })
      .strict(),
    build: (args) => ({ type: 'assistant.writeBrief', ...args }),
  }),
};
