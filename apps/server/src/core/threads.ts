import type {
  DomainEvent,
  ProviderEvent,
  QueuedMessage,
  SentImage,
  SentSkill,
  SkillRef,
  ServerCommand,
  Thread,
  ThreadChanges,
  ThreadItem,
  ThreadItemKind,
  ThreadState,
  Turn,
} from '@wow/contracts';
import {
  AttachmentId,
  QuestionOption,
  askAnswerPrompt,
  attachmentMediaType,
  askAnswerText,
  askedQuestionsOf,
  assistantThreadId,
  replyProblem,
  replyText,
  type QuestionReply,
} from '@wow/contracts';
import { z } from 'zod';
import {
  assistantAnswersNote,
  assistantThreadEvents,
  firstStartNote,
  setupAppliedNote,
  storedGreeting,
} from '../assistant/thread.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import { messageWithSkills } from './skills.js';

// Decisions for provider instances, threads, turns, approvals and questions. Provider events
// arrive as `provider.events` commands from the provider service and become thread items here, so
// the history and the projections only ever hold the normalized shapes.

type ThreadCommand = Extract<
  ServerCommand,
  {
    type:
      | 'providerInstance.create'
      | 'providerInstance.recordTest'
      | 'providerInstance.recordUpdate'
      | 'thread.create'
      | 'thread.openAssistant'
      | 'thread.greetAssistant'
      | 'thread.sendMessage'
      | 'thread.sendPrepared'
      | 'thread.cancelQueued'
      | 'thread.sendQueued'
      | 'thread.handedOver'
      | 'thread.retry'
      | 'thread.answerQuestions'
      | 'thread.interrupt'
      | 'thread.configure'
      | 'thread.setPinned'
      | 'thread.setDone'
      | 'approval.answer'
      | 'question.answer'
      | 'provider.events';
  }
>;

export const isThreadCommand = (command: ServerCommand): command is ThreadCommand =>
  command.type.startsWith('providerInstance.') ||
  command.type.startsWith('thread.') ||
  command.type.startsWith('approval.') ||
  command.type.startsWith('question.') ||
  command.type === 'provider.events';

// Provider ids are only unique per provider session, so stored ids carry the thread or turn.
export const turnId = (threadId: string, index: number) => `${threadId}:turn:${index}`;
export const approvalRowId = (threadId: string, providerId: string) => `${threadId}:${providerId}`;
export const questionRowId = approvalRowId;
const providerIdOf = (threadId: string, rowId: string) => rowId.slice(threadId.length + 1);

// What a question row keeps of the question, to check an answer against its choices.
const StoredQuestion = z.object({
  question: z.string(),
  options: z.array(QuestionOption),
  multiSelect: z.boolean(),
});

// A turn with the user's line as its first item. The prompt can carry a note from wow before the
// line; the conversation shows only the line.
// The greeting turn: wow's note of what is set up, then the user's line.
function greetingEvents(read: ReadModel, context: DecideContext, thread: Thread): DomainEvent[] {
  const text = storedGreeting(read, context);
  const note = firstStartNote(read, context, thread.providerInstanceId);
  return [
    turnStarted(read, thread, context.now, {
      text,
      prompt: `${note}\n\n${text}`,
      assistant: true,
    }),
    { kind: 'assistant.greetingSent', aggregate: assistantThreadId, payload: { at: context.now } },
  ];
}

function turnStarted(
  read: ReadModel,
  thread: Thread,
  now: string,
  {
    text,
    prompt,
    assistant,
    answers,
    skills,
    queued: mark,
    files,
    images,
  }: {
    text: string;
    prompt: string;
    assistant: boolean;
    answers?: { askItemId: string; replies: QuestionReply[] };
    skills?: SentSkill[] | undefined;
    queued?: 'afterTurn';
    files?: readonly string[] | undefined;
    images?: readonly SentImage[] | undefined;
  },
): DomainEvent {
  const index = read.turnCount(thread.id);
  const id = turnId(thread.id, index);
  return {
    kind: 'turn.started',
    aggregate: thread.id,
    payload: {
      turn: {
        id,
        threadId: thread.id,
        index,
        state: 'running',
        startedAt: now,
        endedAt: null,
        usage: null,
      },
      item: {
        id: `${id}:user`,
        threadId: thread.id,
        turnId: id,
        index: read.nextItemIndex(thread.id),
        kind: 'user',
        payload: {
          text,
          ...(answers ? { answers } : {}),
          ...(skills && skills.length > 0 ? { skills } : {}),
          ...(mark ? { queued: mark } : {}),
          ...(files && files.length > 0 ? { files: [...files] } : {}),
          ...(images && images.length > 0 ? { images: [...images] } : {}),
        },
        streaming: false,
      },
      providerInstanceId: thread.providerInstanceId,
      start: {
        cwd: thread.cwd,
        prompt,
        model: thread.model,
        effort: thread.effort,
        permissionMode: thread.permissionMode,
        resumeId: thread.providerSessionId,
        ...(images && images.length > 0 ? { images: images.map((image) => image.id) } : {}),
        ...(assistant ? { kind: 'assistant' as const } : {}),
      },
    },
  };
}

// A message needs text, a skill or an image; the assistant takes no skills (wow skills spec 20)
// and no images (agent workbench spec 61), and a workflow step's thread takes no images either.
function checkMessage(
  thread: Thread,
  text: string,
  picked: readonly SkillRef[],
  images: readonly SentImage[] = [],
): void {
  if (text.trim() === '' && picked.length === 0 && images.length === 0) {
    throw new CommandRejected('rejected', 'A message needs text, a skill or an image');
  }
  if (thread.kind === 'assistant' && picked.length > 0) {
    throw new CommandRejected('rejected', 'The assistant takes no skills');
  }
  if (thread.kind === 'assistant' && images.length > 0) {
    throw new CommandRejected('rejected', 'The assistant takes no images');
  }
  if (thread.stepId !== null && images.length > 0) {
    throw new CommandRejected('rejected', 'A workflow step takes no images');
  }
}

// The images a message names, with their type, which the id carries.
const sentImages = (
  attachments: readonly { readonly id: string; readonly name?: string | undefined }[] = [],
): SentImage[] => {
  const seen = new Set<string>();
  return attachments.flatMap(({ id, name }) => {
    const parsed = AttachmentId.safeParse(id);
    if (!parsed.success || seen.has(parsed.data)) return [];
    seen.add(parsed.data);
    return [
      {
        id: parsed.data,
        mediaType: attachmentMediaType(parsed.data),
        ...(name !== undefined ? { name } : {}),
      },
    ];
  });
};

const queueChanged = (
  threadId: string,
  queued: QueuedMessage | null,
  handOver?: { providerInstanceId: string; prompt: string },
): DomainEvent => ({
  kind: 'thread.queueChanged',
  aggregate: threadId,
  payload: { threadId, queued, ...(handOver ? { handOver } : {}) },
});

// A message written while a turn runs waits with the server (agent workbench spec 50); one that
// already waits takes it in after its own text. A chat or step thread offers it to the running
// turn as well (spec 51); the assistant's prompt carries notes made when its turn starts, so its
// message always waits.
function queueMessage(
  read: ReadModel,
  context: DecideContext,
  thread: Thread,
  running: Turn,
  text: string,
  picked: readonly SkillRef[],
  added: readonly SentImage[] = [],
): DomainEvent {
  const before = thread.queued ?? undefined;
  const images = [...(before?.images ?? [])];
  for (const image of added) {
    if (!images.some((entry) => entry.id === image.id)) images.push(image);
  }
  const skills = [...(before?.skills ?? [])];
  for (const ref of picked) {
    if (!skills.some((skill) => skill.name === ref.name && skill.source === ref.source))
      skills.push(ref);
  }
  const message: QueuedMessage = {
    id: before ? `${before.id}+` : `${running.id}:queued:${context.now}`,
    text: before
      ? [before.text, text.trim()].filter((part) => part.trim() !== '').join('\n\n')
      : text,
    ...(skills.length > 0 ? { skills } : {}),
    ...(images.length > 0 ? { images } : {}),
    queuedAt: before?.queuedAt ?? context.now,
  };
  // A hand-over carries text only, so a message with images waits for the turn's end.
  if (thread.kind === 'assistant' || images.length > 0) return queueChanged(thread.id, message);
  const prompt =
    skills.length > 0
      ? messageWithSkills(read, context, thread, skills, message.text).prompt
      : message.text;
  return queueChanged(thread.id, message, {
    providerInstanceId: thread.providerInstanceId,
    prompt,
  });
}

// A message as the next turn: on the assistant's thread on the instance the settings name now,
// with wow's notes before it (app assistant spec 27); the skills go in front of the text.
function messageTurn(
  read: ReadModel,
  context: DecideContext,
  stored: Thread,
  text: string,
  picked: readonly SkillRef[],
  mark?: 'afterTurn',
  files?: readonly string[],
  images: readonly SentImage[] = [],
): DomainEvent[] {
  checkMessage(stored, text, picked, images);
  const assistant = stored.kind === 'assistant' ? assistantThreadEvents(read, context) : undefined;
  const thread = assistant?.thread ?? stored;
  const notes = assistant
    ? [assistantAnswersNote(read, context), setupAppliedNote(read, context)].filter(
        (entry): entry is string => entry !== null,
      )
    : [];
  const note = notes.length === 0 ? null : notes.join('\n\n');
  const withSkills =
    picked.length > 0
      ? messageWithSkills(read, context, thread, picked, text)
      : { prompt: text, skills: undefined };
  return [
    ...(assistant?.events ?? []),
    turnStarted(read, thread, context.now, {
      text,
      prompt: note ? `${note}\n\n${withSkills.prompt}` : withSkills.prompt,
      assistant: assistant !== undefined,
      skills: withSkills.skills,
      ...(mark ? { queued: mark } : {}),
      files,
      images,
    }),
  ];
}

function requireThread(read: ReadModel, threadId: string) {
  const thread = read.thread(threadId);
  if (!thread) throw new CommandRejected('not_found', `No thread ${threadId}`);
  return thread;
}

export function decideThread(
  command: ThreadCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const now = context.now;
  switch (command.type) {
    case 'providerInstance.create': {
      if (read.providerInstanceExists(command.providerInstanceId)) {
        throw new CommandRejected(
          'conflict',
          `Provider instance ${command.providerInstanceId} already exists`,
        );
      }
      return [
        {
          kind: 'providerInstance.created',
          aggregate: command.providerInstanceId,
          payload: {
            id: command.providerInstanceId,
            kind: command.kind,
            name: command.name,
            binaryPath: command.binaryPath,
            configDir: command.configDir,
            env: command.env,
            launchArgs: command.launchArgs,
            defaultModel: command.defaultModel ?? null,
            defaultEffort: command.defaultEffort ?? null,
            defaultPermissionMode: command.defaultPermissionMode ?? null,
            status: 'unknown',
            account: null,
            version: null,
            statusMessage: null,
            update: null,
            updateRun: null,
          },
        },
      ];
    }
    case 'providerInstance.recordTest': {
      if (!read.providerInstanceExists(command.providerInstanceId)) {
        throw new CommandRejected(
          'not_found',
          `No provider instance ${command.providerInstanceId}`,
        );
      }
      const { result } = command;
      return [
        {
          kind: 'providerInstance.tested',
          aggregate: command.providerInstanceId,
          payload: {
            providerInstanceId: command.providerInstanceId,
            status: result.ok ? 'ready' : 'error',
            account: result.account,
            version: result.version,
            statusMessage: result.message,
            update: result.update ?? null,
          },
        },
      ];
    }
    case 'providerInstance.recordUpdate': {
      const instance = read.providerInstance(command.providerInstanceId);
      if (!instance) {
        throw new CommandRejected(
          'not_found',
          `No provider instance ${command.providerInstanceId}`,
        );
      }
      const running = instance.updateRun?.state === 'running';
      if (command.progress.phase === 'started' ? running : !running) {
        throw new CommandRejected(
          'conflict',
          running
            ? `An update of ${instance.name} is already running`
            : `No update of ${instance.name} is running`,
        );
      }
      return [
        {
          kind: 'providerInstance.updateProgressed',
          aggregate: command.providerInstanceId,
          payload: { providerInstanceId: command.providerInstanceId, progress: command.progress },
        },
      ];
    }
    case 'thread.create': {
      if (read.thread(command.threadId)) {
        throw new CommandRejected('conflict', `Thread ${command.threadId} already exists`);
      }
      if (command.threadId === assistantThreadId) {
        throw new CommandRejected('rejected', `The id ${assistantThreadId} is the assistant's`);
      }
      if (!read.providerInstanceExists(command.providerInstanceId)) {
        throw new CommandRejected(
          'not_found',
          `No provider instance ${command.providerInstanceId}`,
        );
      }
      if (command.projectId !== undefined && !read.project(command.projectId)) {
        throw new CommandRejected('not_found', `No project ${command.projectId}`);
      }
      return [
        {
          kind: 'thread.created',
          aggregate: command.threadId,
          payload: {
            id: command.threadId,
            projectId: command.projectId ?? null,
            cwd: command.cwd,
            branch: command.branch ?? null,
            providerInstanceId: command.providerInstanceId,
            providerSessionId: null,
            title: command.title ?? '',
            model: command.model,
            effort: command.effort,
            permissionMode: command.permissionMode,
            state: 'idle',
            pinned: false,
            runId: null,
            stepId: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ];
    }
    case 'thread.openAssistant': {
      // A running turn goes on as it started; the thread is brought in line before the next one.
      if (read.runningTurn(assistantThreadId)) return [];
      const opened = assistantThreadEvents(read, context, {
        model: command.fallbackModel,
        effort: command.fallbackEffort,
      });
      return read.greetingOwed()
        ? [...opened.events, ...greetingEvents(read, context, opened.thread)]
        : opened.events;
    }
    case 'thread.greetAssistant': {
      // The greeting is owed until the assistant can run it, so a reload or a restart between
      // the first-start step and the greeting does not lose it (spec 26).
      const owe: DomainEvent[] = read.greetingOwed()
        ? []
        : [{ kind: 'assistant.greetingOwed', aggregate: assistantThreadId, payload: { at: now } }];
      if (!read.thread(assistantThreadId) || read.runningTurn(assistantThreadId)) return owe;
      let opened: ReturnType<typeof assistantThreadEvents>;
      try {
        opened = assistantThreadEvents(read, context);
      } catch (error) {
        if (error instanceof CommandRejected) return owe;
        throw error;
      }
      return [...opened.events, ...greetingEvents(read, context, opened.thread)];
    }
    case 'thread.sendMessage': {
      const stored = requireThread(read, command.threadId);
      const picked = command.skills ?? [];
      const images = sentImages(command.attachments);
      checkMessage(stored, command.text, picked, images);
      if (stored.kind === 'assistant' && (command.files ?? []).length > 0) {
        throw new CommandRejected('rejected', 'The assistant takes no file mentions');
      }
      const running = read.runningTurn(stored.id);
      // A queued message keeps its text, which names the files; the chips go with a message
      // sent at once.
      if (running) {
        return [queueMessage(read, context, stored, running, command.text, picked, images)];
      }
      return messageTurn(
        read,
        context,
        stored,
        command.text,
        picked,
        undefined,
        command.files,
        images,
      );
    }
    case 'thread.cancelQueued': {
      const thread = requireThread(read, command.threadId);
      if (!thread.queued) {
        throw new CommandRejected(
          'conflict',
          'No message waits in this thread any more; it was sent or taken off the queue.',
        );
      }
      return [queueChanged(thread.id, null)];
    }
    case 'thread.sendQueued': {
      const thread = requireThread(read, command.threadId);
      const waiting = thread.queued;
      if (!waiting || waiting.id !== command.queuedId) return [];
      // Refused rather than a no-op, so no receipt is kept and the next turn end sends it.
      if (read.runningTurn(thread.id)) {
        throw new CommandRejected('conflict', 'A turn runs in this thread; the message waits.');
      }
      return [
        queueChanged(thread.id, null),
        ...messageTurn(
          read,
          context,
          thread,
          waiting.text,
          waiting.skills ?? [],
          'afterTurn',
          undefined,
          waiting.images ?? [],
        ),
      ];
    }
    case 'thread.handedOver': {
      const thread = requireThread(read, command.threadId);
      const waiting = thread.queued;
      if (!waiting || waiting.id !== command.queuedId) return [];
      // The provider has it, so it shows in the turn it went into, or the one that just ended.
      const turn = read.runningTurn(thread.id) ?? read.lastTurn(thread.id);
      if (!turn) return [queueChanged(thread.id, null)];
      const picked = waiting.skills ?? [];
      const skills =
        picked.length > 0
          ? messageWithSkills(read, context, thread, picked, waiting.text).skills
          : undefined;
      const index = read.nextItemIndex(thread.id);
      return [
        queueChanged(thread.id, null),
        {
          kind: 'threadItem.added',
          aggregate: thread.id,
          payload: {
            id: `${turn.id}:handedOver:${index}`,
            threadId: thread.id,
            turnId: turn.id,
            index,
            kind: 'user',
            payload: {
              text: waiting.text,
              ...(skills && skills.length > 0 ? { skills } : {}),
              queued: 'duringTurn',
            },
            streaming: false,
          },
        },
      ];
    }
    case 'thread.sendPrepared': {
      const thread = requireThread(read, command.threadId);
      if (thread.kind === 'assistant') {
        throw new CommandRejected('rejected', 'Workflow steps do not run in the assistant thread');
      }
      if (read.runningTurn(thread.id)) {
        throw new CommandRejected('rejected', `Thread ${thread.id} already has a running turn`);
      }
      return [
        turnStarted(read, thread, now, {
          text: command.text,
          prompt: command.prompt,
          assistant: false,
          skills: command.skills,
        }),
      ];
    }
    case 'thread.retry': {
      const thread = requireThread(read, command.threadId);
      if (thread.stepId === null) {
        throw new CommandRejected(
          'rejected',
          "Only a workflow step's thread is retried this way; send the message again instead.",
        );
      }
      if (read.runningTurn(thread.id)) {
        throw new CommandRejected('rejected', `Thread ${thread.id} already has a running turn`);
      }
      const sent = read.lastSent(thread.id);
      if (!sent) throw new CommandRejected('rejected', 'This thread has no message to send again');
      return [
        turnStarted(read, thread, now, {
          text: sent.text,
          prompt: sent.prompt,
          assistant: false,
          skills: sent.skills,
        }),
      ];
    }
    case 'thread.answerQuestions': {
      const stored = requireThread(read, command.threadId);
      if (stored.kind !== 'assistant') {
        throw new CommandRejected(
          'rejected',
          "Only the assistant's questions are answered this way; an agent's question is answered on its card.",
        );
      }
      if (read.runningTurn(stored.id)) {
        throw new CommandRejected(
          'rejected',
          'The assistant is still working. Answer its questions when its turn has ended.',
        );
      }
      const item = read.threadItem(command.itemId);
      const ask = item && item.threadId === stored.id ? askedQuestionsOf(item) : null;
      if (!item || !ask) {
        throw new CommandRejected(
          'not_found',
          `The assistant asked no questions in ${command.itemId}`,
        );
      }
      // The next message ends the questions: answered, or left for something the user wrote.
      const asked = read.lastTurn(stored.id);
      if (asked?.id !== item.turnId) {
        throw new CommandRejected(
          'conflict',
          'These questions were not answered before the next message, so they can no longer be answered.',
        );
      }
      // A stopped turn takes no answer, as an agent's question in a stopped turn (spec 5).
      if (asked.state === 'interrupted') {
        throw new CommandRejected(
          'conflict',
          'The turn that asked these questions was stopped, so they can no longer be answered.',
        );
      }
      if (command.replies.length !== ask.questions.length) {
        throw new CommandRejected(
          'rejected',
          `Answer every question: ${ask.questions.length} asked, ${command.replies.length} answered.`,
        );
      }
      ask.questions.forEach((question, index) => {
        const problem = replyProblem(question, command.replies[index] ?? { picked: [], text: '' });
        if (problem) throw new CommandRejected('rejected', `"${question.question}": ${problem}`);
      });
      const opened = assistantThreadEvents(read, context);
      const notes = [assistantAnswersNote(read, context), setupAppliedNote(read, context)].filter(
        (entry): entry is string => entry !== null,
      );
      const answer = askAnswerPrompt(ask, command.replies);
      return [
        ...opened.events,
        turnStarted(read, opened.thread, now, {
          text: askAnswerText(ask, command.replies),
          prompt: [...notes, answer].join('\n\n'),
          assistant: true,
          answers: { askItemId: item.id, replies: command.replies },
        }),
      ];
    }
    case 'thread.interrupt': {
      const thread = requireThread(read, command.threadId);
      const turn = read.runningTurn(thread.id);
      if (!turn) throw new CommandRejected('rejected', `Thread ${thread.id} has no running turn`);
      return [
        {
          kind: 'turn.interruptRequested',
          aggregate: thread.id,
          payload: {
            threadId: thread.id,
            turnId: turn.id,
            providerInstanceId: thread.providerInstanceId,
          },
        },
      ];
    }
    case 'thread.configure': {
      const thread = requireThread(read, command.threadId);
      if (thread.kind === 'assistant') {
        throw new CommandRejected(
          'rejected',
          "The assistant's model and effort are set in Settings → Assistant",
        );
      }
      const changes: ThreadChanges = {};
      if (command.model !== undefined && command.model !== thread.model)
        changes.model = command.model;
      if (command.effort !== undefined && command.effort !== thread.effort)
        changes.effort = command.effort;
      if (command.permissionMode !== undefined && command.permissionMode !== thread.permissionMode)
        changes.permissionMode = command.permissionMode;
      if (Object.keys(changes).length === 0) return [];
      return [
        {
          kind: 'thread.configured',
          aggregate: thread.id,
          payload: {
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            changes,
            updatedAt: now,
          },
        },
      ];
    }
    case 'thread.setPinned': {
      const thread = requireThread(read, command.threadId);
      if (thread.pinned === command.pinned) return [];
      return [
        {
          kind: 'thread.pinned',
          aggregate: thread.id,
          payload: { threadId: thread.id, pinned: command.pinned },
        },
      ];
    }
    case 'thread.setDone': {
      const thread = requireThread(read, command.threadId);
      if (!command.done) {
        if (thread.state !== 'done') return [];
        // Reopening keeps the failed marker of a thread whose last turn failed.
        const state = read.lastTurn(thread.id)?.state === 'failed' ? 'failed' : 'idle';
        return [stateChanged(thread.id, state, now)];
      }
      if (thread.state === 'done') return [];
      if (
        thread.state === 'working' ||
        thread.state === 'needs_you' ||
        read.runningTurn(thread.id)
      ) {
        throw new CommandRejected(
          'rejected',
          `Thread ${thread.id} is ${thread.state === 'needs_you' ? 'waiting for you' : 'working'}`,
        );
      }
      return [stateChanged(thread.id, 'done', now)];
    }
    case 'approval.answer': {
      const approval = read.approval(command.approvalId);
      if (!approval) throw new CommandRejected('not_found', `No approval ${command.approvalId}`);
      if (approval.decision !== null) {
        throw new CommandRejected('conflict', `Approval ${approval.id} was already answered`);
      }
      const thread = requireThread(read, approval.threadId);
      return [
        {
          kind: 'approval.answered',
          aggregate: thread.id,
          payload: {
            approvalId: approval.id,
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            providerApprovalId: providerIdOf(thread.id, approval.id),
            decision: command.decision,
            decidedAt: now,
          },
        },
        ...resumeWork(read, thread.id, thread.state, now),
      ];
    }
    case 'question.answer': {
      const ids = command.answers.map((entry) => entry.questionId);
      if (new Set(ids).size !== ids.length) {
        throw new CommandRejected('rejected', 'A question is answered twice');
      }
      const answered = command.answers.map(({ questionId, reply }) => {
        const question = read.question(questionId);
        if (!question) throw new CommandRejected('not_found', `No question ${questionId}`);
        if (question.answer !== null) {
          throw new CommandRejected('conflict', `Question ${question.id} was already answered`);
        }
        const asked = StoredQuestion.safeParse(question.request);
        const problem = replyProblem(
          asked.success ? asked.data : { options: [], multiSelect: true },
          reply,
        );
        if (problem) throw new CommandRejected('rejected', problem);
        return { question, reply, text: asked.data?.question ?? question.id };
      });
      const threadIds = new Set(answered.map((entry) => entry.question.threadId));
      const [threadId] = threadIds;
      if (threadIds.size !== 1 || threadId === undefined) {
        throw new CommandRejected('rejected', 'Questions of different threads are answered apart');
      }
      const thread = requireThread(read, threadId);
      // Once its turn has ended (or was stopped), nobody waits for the answer (spec 5).
      const running = read.runningTurn(thread.id);
      for (const { question, text } of answered) {
        if (!running || read.threadItem(question.itemId)?.turnId !== running.id) {
          throw new CommandRejected(
            'rejected',
            `"${text}" was not answered before its turn ended, so it can no longer be answered.`,
          );
        }
      }
      return [
        ...answered.map(({ question, reply }): DomainEvent => ({
          kind: 'question.answered',
          aggregate: thread.id,
          payload: {
            questionId: question.id,
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            providerQuestionId: providerIdOf(thread.id, question.id),
            answer: replyText(reply),
            reply,
            answeredAt: now,
          },
        })),
        ...resumeWork(read, thread.id, thread.state, now, answered.length),
      ];
    }
    case 'provider.events':
      return decideProviderEvents(command.threadId, command.events, read, now);
  }
}

const stateChanged = (threadId: string, state: ThreadState, now: string): DomainEvent => ({
  kind: 'thread.stateChanged',
  aggregate: threadId,
  payload: { threadId, state, updatedAt: now },
});

// After the last open request of a thread is answered, the agent works again.
function resumeWork(
  read: ReadModel,
  threadId: string,
  state: ThreadState,
  now: string,
  answered = 1,
): DomainEvent[] {
  if (state !== 'needs_you' || read.openRequests(threadId) > answered) return [];
  return [stateChanged(threadId, 'working', now)];
}

const endedThreadState = {
  completed: 'idle',
  interrupted: 'idle',
  failed: 'failed',
} as const satisfies Record<string, ThreadState>;

// Turns a batch of provider events for one thread into domain events. The read model shows the
// state before the batch, so items created earlier in the same batch are tracked here.
function decideProviderEvents(
  threadId: string,
  events: readonly ProviderEvent[],
  read: ReadModel,
  now: string,
): DomainEvent[] {
  const thread = read.thread(threadId);
  // A thread deleted while its provider was still talking; nothing to record.
  if (!thread) return [];
  let turn: Turn | undefined = read.runningTurn(threadId);
  let turnCount = read.turnCount(threadId);
  let background = thread.backgroundTasks ?? [];
  let state = thread.state;
  let nextIndex = read.nextItemIndex(threadId);
  const created = new Set<string>();
  const out: DomainEvent[] = [];
  const exists = (id: string) => created.has(id) || read.itemExists(id);

  const item = (
    current: Turn,
    id: string,
    kind: ThreadItemKind,
    payload: unknown,
    streaming: boolean,
  ): ThreadItem => {
    created.add(id);
    return { id, threadId, turnId: current.id, index: nextIndex++, kind, payload, streaming };
  };
  const add = (
    current: Turn,
    id: string,
    kind: ThreadItemKind,
    payload: unknown,
    streaming: boolean,
  ) =>
    out.push({
      kind: 'threadItem.added',
      aggregate: threadId,
      payload: item(current, id, kind, payload, streaming),
    });
  const patch = (
    current: Turn,
    id: string,
    kind: ThreadItemKind,
    values: Record<string, unknown>,
    streaming?: boolean,
  ) => {
    if (exists(id)) {
      out.push({
        kind: 'threadItem.patched',
        aggregate: threadId,
        payload:
          streaming === undefined
            ? { itemId: id, patch: values }
            : { itemId: id, patch: values, streaming },
      });
    } else {
      add(current, id, kind, values, streaming ?? false);
    }
  };
  const setState = (next: ThreadState) => {
    if (next === state) return;
    state = next;
    out.push({
      kind: 'thread.stateChanged',
      aggregate: threadId,
      payload: { threadId, state: next, updatedAt: now },
    });
  };

  for (const event of events) {
    if (event.type === 'session') {
      if (event.providerSessionId !== thread.providerSessionId) {
        out.push({
          kind: 'thread.sessionStarted',
          aggregate: threadId,
          payload: { threadId, providerSessionId: event.providerSessionId, updatedAt: now },
        });
      }
      continue;
    }
    if (event.type === 'backgroundTasks') {
      if (JSON.stringify(event.tasks) !== JSON.stringify(background)) {
        background = event.tasks;
        out.push({
          kind: 'thread.backgroundChanged',
          aggregate: threadId,
          payload: { threadId, tasks: event.tasks, updatedAt: now },
        });
      }
      continue;
    }
    if (event.type === 'turnStartedByProvider') {
      // While a turn wow started still runs, what the provider does belongs to that turn.
      if (turn) continue;
      const index = turnCount++;
      turn = {
        id: turnId(threadId, index),
        threadId,
        index,
        state: 'running',
        startedAt: now,
        endedAt: null,
        usage: null,
      };
      out.push({ kind: 'turn.startedByProvider', aggregate: threadId, payload: { turn } });
      state = 'working';
      continue;
    }
    // Events after the turn ended (late output of an interrupted turn) are dropped.
    if (!turn) continue;
    const current = turn;
    const itemId = (providerItemId: string) => `${current.id}:${providerItemId}`;
    switch (event.type) {
      case 'textDelta':
      case 'reasoningDelta': {
        const id = itemId(event.itemId);
        if (exists(id)) {
          out.push({
            kind: 'threadItem.appended',
            aggregate: threadId,
            payload: { itemId: id, field: 'text', delta: event.delta },
          });
        } else {
          add(
            current,
            id,
            event.type === 'textDelta' ? 'assistant_text' : 'reasoning',
            { text: event.delta },
            true,
          );
        }
        break;
      }
      case 'toolCallStarted': {
        const id = itemId(event.itemId);
        if (!exists(id)) {
          add(
            current,
            id,
            'tool_call',
            { name: event.name, input: event.input ?? null, output: '', status: 'running' },
            true,
          );
        }
        break;
      }
      case 'toolCallOutput': {
        const id = itemId(event.itemId);
        if (exists(id)) {
          out.push({
            kind: 'threadItem.appended',
            aggregate: threadId,
            payload: { itemId: id, field: 'output', delta: event.output },
          });
        }
        break;
      }
      case 'toolCallCompleted': {
        const id = itemId(event.itemId);
        if (exists(id)) patch(current, id, 'tool_call', { status: event.status }, false);
        break;
      }
      case 'approvalRequested': {
        const id = approvalRowId(threadId, event.approvalId);
        if (read.approval(id)) break;
        out.push({
          kind: 'approval.requested',
          aggregate: threadId,
          payload: {
            approval: {
              id,
              threadId,
              itemId: itemId(`approval:${event.approvalId}`),
              kind: event.kind,
              request: { summary: event.summary, details: event.request ?? null },
              decision: null,
              decidedAt: null,
            },
            item: item(
              current,
              itemId(`approval:${event.approvalId}`),
              'approval',
              {
                approvalId: id,
                kind: event.kind,
                summary: event.summary,
              },
              false,
            ),
          },
        });
        setState('needs_you');
        break;
      }
      case 'questionAsked': {
        const id = questionRowId(threadId, event.questionId);
        if (read.question(id)) break;
        const request = {
          question: event.question,
          ...(event.header === undefined ? {} : { header: event.header }),
          ...(event.askId === undefined ? {} : { askId: event.askId }),
          options: event.options,
          multiSelect: event.multiSelect,
        };
        out.push({
          kind: 'question.asked',
          aggregate: threadId,
          payload: {
            question: {
              id,
              threadId,
              itemId: itemId(`question:${event.questionId}`),
              request,
              answer: null,
              answeredAt: null,
            },
            item: item(
              current,
              itemId(`question:${event.questionId}`),
              'question',
              { questionId: id, ...request },
              false,
            ),
          },
        });
        setState('needs_you');
        break;
      }
      case 'taskListUpdated':
        patch(current, itemId('tasks'), 'task_list', { tasks: event.tasks });
        break;
      case 'usage': {
        const usage =
          event.costUsd === undefined
            ? {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cachedInputTokens: event.cachedInputTokens,
              }
            : {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cachedInputTokens: event.cachedInputTokens,
                costUsd: event.costUsd,
              };
        out.push({
          kind: 'turn.usageRecorded',
          aggregate: threadId,
          payload: { turnId: current.id, usage },
        });
        patch(current, itemId('usage'), 'usage', usage);
        break;
      }
      case 'contextUsage':
        patch(current, itemId('usage'), 'usage', {
          context: { usedTokens: event.usedTokens, maxTokens: event.maxTokens },
        });
        break;
      case 'turnCompleted':
      case 'turnFailed':
      case 'turnInterrupted': {
        const ended =
          event.type === 'turnCompleted'
            ? 'completed'
            : event.type === 'turnFailed'
              ? 'failed'
              : 'interrupted';
        if (event.type === 'turnFailed') {
          add(current, itemId('error'), 'error', { message: event.error }, false);
        }
        out.push({
          kind: 'turn.ended',
          aggregate: threadId,
          payload: {
            threadId,
            turnId: current.id,
            state: ended,
            threadState: endedThreadState[ended],
            endedAt: now,
          },
        });
        state = endedThreadState[ended];
        turn = undefined;
        break;
      }
    }
  }
  return out;
}
