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
  TurnState,
} from '@wow/contracts';
import {
  AlwaysAllowRule,
  ApprovalItemPayload,
  ChatNotifications,
  diffCounts,
  planStartModes,
  proposeRule,
  AttachmentId,
  QuestionOption,
  ruleCovers,
  sameRule,
  type ApprovalFacts,
  type ApprovalPlan,
  type ProposedRule,
  askAnswerPrompt,
  attachmentMediaType,
  askAnswerText,
  askedQuestionsOf,
  assistantThreadId,
  replyProblem,
  replyText,
  TaskListItemPayload,
  toolFactsOf,
  type QuestionReply,
} from '@wow/contracts';
import { z } from 'zod';
import { resolveStored } from '../settings/service.js';
import {
  assistantAnswersNote,
  assistantThreadEvents,
  firstStartNote,
  setupAppliedNote,
  storedGreeting,
} from '../assistant/thread.js';
import {
  CommandRejected,
  settingAggregate,
  type DecideContext,
  type ReadModel,
} from './orchestrator.js';
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
      | 'thread.changesMarked'
      | 'thread.retry'
      | 'thread.answerQuestions'
      | 'thread.interrupt'
      | 'thread.configure'
      | 'thread.setPinned'
      | 'thread.setDone'
      | 'thread.rename'
      | 'thread.setArchived'
      | 'thread.markSeen'
      | 'thread.markUnread'
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

// A turn starting or a request arriving brings an archived thread back to the list, so what it
// does next is not hidden from the user (coordinator decision on spec 68).
const unarchived = (threadId: string): DomainEvent => ({
  kind: 'thread.archived',
  aggregate: threadId,
  payload: { threadId, archived: false },
});

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
  mentioned: readonly string[] = [],
): DomainEvent {
  const before = thread.queued ?? undefined;
  const files = [...new Set([...(before?.files ?? []), ...mentioned])];
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
    ...(files.length > 0 ? { files } : {}),
    queuedAt: before?.queuedAt ?? context.now,
  };
  if (thread.kind === 'assistant') return queueChanged(thread.id, message);
  return offerQueued(read, context, thread, message);
}

function offerQueued(
  read: ReadModel,
  context: DecideContext,
  thread: Thread,
  message: QueuedMessage,
): DomainEvent {
  // A hand-over carries text only, so a message with images waits for the turn's end.
  if ((message.images ?? []).length > 0) return queueChanged(thread.id, message);
  const skills = message.skills ?? [];
  const prompt =
    skills.length > 0
      ? messageWithSkills(read, context, thread, skills, message.text).prompt
      : message.text;
  return queueChanged(thread.id, message, {
    providerInstanceId: thread.providerInstanceId,
    prompt,
  });
}

// The user item of a message the provider took into `turn`.
function handedOverItem(
  read: ReadModel,
  context: DecideContext,
  thread: Thread,
  turn: Turn,
  text: string,
  picked: readonly SkillRef[],
  files: readonly string[],
): DomainEvent {
  const skills =
    picked.length > 0 ? messageWithSkills(read, context, thread, picked, text).skills : undefined;
  const index = read.nextItemIndex(thread.id);
  return {
    kind: 'threadItem.added',
    aggregate: thread.id,
    payload: {
      id: `${turn.id}:handedOver:${index}`,
      threadId: thread.id,
      turnId: turn.id,
      index,
      kind: 'user',
      payload: {
        text,
        ...(skills && skills.length > 0 ? { skills } : {}),
        ...(files.length > 0 ? { files: [...files] } : {}),
        queued: 'duringTurn',
      },
      streaming: false,
    },
  };
}

// The provider took an older version of the queue (agent workbench spec 51): it shows in the
// running turn it was offered to, and of a message joined since only the rest stays queued.
function handedOverEarlier(
  read: ReadModel,
  context: DecideContext,
  thread: Thread,
  queuedId: string,
  offered: {
    readonly text: string;
    readonly skills?: readonly SkillRef[] | undefined;
    readonly files?: readonly string[] | undefined;
  },
): DomainEvent[] {
  const running = read.runningTurn(thread.id);
  if (!running || !queuedId.startsWith(`${running.id}:queued:`)) return [];
  const given = offered.skills ?? [];
  const givenFiles = offered.files ?? [];
  const events = [handedOverItem(read, context, thread, running, offered.text, given, givenFiles)];
  const waiting = thread.queued;
  if (!waiting) return events;
  if (!waiting.id.startsWith(`${queuedId}+`) || !waiting.text.startsWith(offered.text)) {
    return [...events, offerQueued(read, context, thread, waiting)];
  }
  const text = waiting.text.slice(offered.text.length).replace(/^\n\n/, '');
  const skills = (waiting.skills ?? []).filter(
    (skill) => !given.some((ref) => ref.name === skill.name && ref.source === skill.source),
  );
  const files = (waiting.files ?? []).filter((file) => !givenFiles.includes(file));
  const images = waiting.images ?? [];
  if (text.trim() === '' && skills.length === 0 && images.length === 0) {
    return [...events, queueChanged(thread.id, null)];
  }
  const rest: QueuedMessage = {
    id: waiting.id,
    text,
    ...(skills.length > 0 ? { skills } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
    queuedAt: waiting.queuedAt,
  };
  return [...events, offerQueued(read, context, thread, rest)];
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
    ...(thread.archived ? [unarchived(thread.id)] : []),
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
      if (running) {
        return [
          queueMessage(read, context, stored, running, command.text, picked, images, command.files),
          ...(stored.archived ? [unarchived(stored.id)] : []),
        ];
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
          waiting.files,
          waiting.images ?? [],
        ),
      ];
    }
    case 'thread.handedOver': {
      const thread = requireThread(read, command.threadId);
      const waiting = thread.queued;
      if (!waiting || waiting.id !== command.queuedId) {
        return command.offered
          ? handedOverEarlier(read, context, thread, command.queuedId, command.offered)
          : [];
      }
      // The provider has it, so it shows in the turn it went into, or the one that just ended.
      const turn = read.runningTurn(thread.id) ?? read.lastTurn(thread.id);
      if (!turn) return [queueChanged(thread.id, null)];
      return [
        queueChanged(thread.id, null),
        handedOverItem(
          read,
          context,
          thread,
          turn,
          waiting.text,
          waiting.skills ?? [],
          waiting.files ?? [],
        ),
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
    case 'thread.rename': {
      const thread = requireThread(read, command.threadId);
      const title = command.title.trim();
      if (title === '') throw new CommandRejected('rejected', 'A thread needs a title');
      const longest = settingValue('chat.threadTitleMaxLength', read, context);
      if (typeof longest === 'number' && title.length > longest) {
        throw new CommandRejected(
          'rejected',
          `A thread title can have at most ${longest} characters; this one has ${title.length}.`,
        );
      }
      if (thread.title === title) return [];
      return [
        {
          kind: 'thread.renamed',
          aggregate: thread.id,
          payload: { threadId: thread.id, title },
        },
      ];
    }
    case 'thread.setArchived': {
      const thread = requireThread(read, command.threadId);
      if ((thread.archived ?? false) === command.archived) return [];
      if (command.archived && thread.runId !== null) {
        throw new CommandRejected(
          'rejected',
          "A workflow step's thread belongs to its run, so it is not archived on its own.",
        );
      }
      return [
        {
          kind: 'thread.archived',
          aggregate: thread.id,
          payload: { threadId: thread.id, archived: command.archived },
        },
      ];
    }
    case 'thread.markSeen':
    case 'thread.markUnread': {
      const thread = requireThread(read, command.threadId);
      const seen = command.type === 'thread.markSeen';
      if ((thread.seen ?? true) === seen) return [];
      return [seenChanged(thread.id, seen)];
    }
    case 'approval.answer':
      return answerApproval(command, read, context);
    case 'thread.changesMarked': {
      const thread = requireThread(read, command.threadId);
      if (!command.base && !command.mark) return [];
      return [
        {
          kind: 'thread.changesMarked',
          aggregate: thread.id,
          payload: {
            threadId: thread.id,
            turnId: command.turnId,
            base: command.base,
            mark: command.mark,
          },
        },
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
      return decideProviderEvents(command.threadId, command.events, read, context);
  }
}

const seenChanged = (threadId: string, seen: boolean): DomainEvent => ({
  kind: 'thread.seenChanged',
  aggregate: threadId,
  payload: { threadId, seen },
});

const settingValue = (key: string, read: ReadModel, context: DecideContext): unknown => {
  const definition = context.registry[key];
  if (!definition) return undefined;
  return resolveStored(key, definition, {}, (scope) => read.setting(key, scope)).value;
};

// What the user asked to hear about chat threads (spec 65).
const chatNotifications = (read: ReadModel, context: DecideContext): ChatNotifications => {
  const parsed = ChatNotifications.safeParse(settingValue('chat.notifications', read, context));
  return parsed.success ? parsed.data : 'needsYouAndFinished';
};

const finishedAfterMs = (read: ReadModel, context: DecideContext): number => {
  const value = settingValue('chat.finishedAfterSeconds', read, context);
  return typeof value === 'number' ? value * 1000 : Number.POSITIVE_INFINITY;
};

// The rules stored for a project (agent workbench spec 38 to 40); a value that no longer parses
// gives none, so a broken list asks again rather than allowing.
export function projectRules(read: ReadModel, projectId: string): AlwaysAllowRule[] {
  const parsed = AlwaysAllowRule.array().safeParse(
    read.setting('approvals.alwaysAllow', `project:${projectId}`)?.value,
  );
  return parsed.success ? parsed.data : [];
}

const approvalPayloadOf = (read: ReadModel, itemId: string) => {
  const parsed = ApprovalItemPayload.safeParse(read.threadItem(itemId)?.payload);
  return parsed.success ? parsed.data : undefined;
};

const ruleOf = (rule: ProposedRule): ProposedRule =>
  rule.kind === 'command'
    ? { kind: 'command', prefix: rule.prefix }
    : { kind: 'tool', server: rule.server, tool: rule.tool };

function answerApproval(
  command: Extract<ThreadCommand, { type: 'approval.answer' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const now = context.now;
  const approval = read.approval(command.approvalId);
  if (!approval) throw new CommandRejected('not_found', `No approval ${command.approvalId}`);
  if (approval.decision !== null) {
    throw new CommandRejected('conflict', `Approval ${approval.id} was already answered`);
  }
  const thread = requireThread(read, approval.threadId);
  const payload = approvalPayloadOf(read, approval.itemId);
  const kind = read.providerInstance(thread.providerInstanceId)?.kind;
  const note = command.decision === 'deny' ? command.note?.trim() || undefined : undefined;
  const out: DomainEvent[] = [];
  let permissionMode: string | undefined;
  if (command.permissionMode !== undefined) {
    if (approval.kind !== 'plan' || command.decision === 'deny') {
      throw new CommandRejected('rejected', 'Only a plan is started in a mode');
    }
    if (!(planStartModes as readonly string[]).includes(command.permissionMode)) {
      throw new CommandRejected('rejected', `A plan does not start in "${command.permissionMode}"`);
    }
    permissionMode = command.permissionMode;
    // The bar shows the mode the work goes on in (spec 42); the adapter is already in it.
    if (permissionMode !== thread.permissionMode) {
      out.push({
        kind: 'thread.configured',
        aggregate: thread.id,
        payload: {
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          changes: { permissionMode },
          updatedAt: now,
        },
      });
    }
  }
  if (command.decision === 'allowAlways') {
    const rule = payload?.rule;
    if (!rule || thread.projectId === null) {
      throw new CommandRejected(
        'rejected',
        thread.projectId === null
          ? 'A thread without a project has no rules to keep.'
          : 'This request has no rule to keep; allow it once or for the session.',
      );
    }
    const rules = projectRules(read, thread.projectId);
    if (!rules.some((stored) => sameRule(stored, rule))) {
      const scope = `project:${thread.projectId}` as const;
      out.push({
        kind: 'setting.changed',
        aggregate: settingAggregate('approvals.alwaysAllow', scope),
        payload: {
          key: 'approvals.alwaysAllow',
          scope,
          value: [...rules, { ...ruleOf(rule), addedAt: now }],
        },
      });
    }
  }
  out.push({
    kind: 'approval.answered',
    aggregate: thread.id,
    payload: {
      approvalId: approval.id,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      providerApprovalId: providerIdOf(thread.id, approval.id),
      decision: command.decision,
      decidedAt: now,
      ...(note === undefined ? {} : { note }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
    },
  });
  if (note !== undefined || permissionMode !== undefined) {
    out.push({
      kind: 'threadItem.patched',
      aggregate: thread.id,
      payload: {
        itemId: approval.itemId,
        patch: {
          ...(note === undefined ? {} : { note }),
          ...(permissionMode === undefined ? {} : { permissionMode }),
        },
      },
    });
  }
  // Codex takes no message with a decline (spec 37): the turn stops and the note is the next
  // message, as Codex's own "tell it what to do instead" does. A step's turn is not stopped, since
  // that would stop the step; its note waits for the turn to end.
  const running = read.runningTurn(thread.id);
  if (note !== undefined && kind === 'codex' && running) {
    out.push(queueMessage(read, context, thread, running, note, []));
    if (thread.runId === null) {
      out.push({
        kind: 'turn.interruptRequested',
        aggregate: thread.id,
        payload: {
          threadId: thread.id,
          turnId: running.id,
          providerInstanceId: thread.providerInstanceId,
        },
      });
    }
  }
  out.push(...resumeWork(read, thread.id, thread.state, now));
  return out;
}

const textOf = (item: ThreadItem | undefined): string | undefined => {
  const payload = item?.payload;
  return typeof payload === 'object' && payload !== null && 'text' in payload
    ? typeof payload.text === 'string'
      ? payload.text
      : undefined
    : undefined;
};

// A plan approval's plan (spec 42): the request's own, else the turn's last assistant text,
// labelled as written in the conversation (spec Open risks).
function planOf(
  facts: ApprovalFacts | undefined,
  turn: Turn,
  batch: { id: string; text: string } | undefined,
  read: ReadModel,
): ApprovalPlan {
  const asked = facts?.plan?.trim();
  if (asked) return { text: asked, from: 'request' };
  const text = batch?.id.startsWith(`${turn.id}:`)
    ? batch.text
    : textOf(read.lastAssistantText(turn.id));
  return { text: text?.trim() ?? '', from: 'conversation' };
}

function approvalFactsOf(
  facts: ApprovalFacts | undefined,
  read: ReadModel,
  context: DecideContext,
): { facts?: ApprovalFacts; diffCut?: true } {
  if (!facts) return {};
  const { diff, ...rest } = facts;
  const cut = cutDiff(diff, read, context);
  return {
    facts: { ...rest, ...(cut.diff === undefined ? {} : { diff: cut.diff }) },
    ...(cut.diffCut ? { diffCut: true } : {}),
  };
}

// An edit's diff, cut to `chat.editDiffMaxLines` lines.
function cutDiff(
  diff: string | undefined,
  read: ReadModel,
  context: DecideContext,
): { diff?: string; diffCut?: true } {
  if (diff === undefined) return {};
  const longest = settingValue('chat.editDiffMaxLines', read, context);
  const lines = diff.split('\n');
  if (typeof longest !== 'number' || lines.length <= longest) return { diff };
  return { diff: lines.slice(0, longest).join('\n'), diffCut: true };
}

// A tool row's diff with the counts of the whole of it, which a cut diff no longer gives.
function cutToolDiff(diff: string | undefined, read: ReadModel, context: DecideContext) {
  return diff === undefined
    ? {}
    : { ...cutDiff(diff, read, context), diffCounts: diffCounts(diff) };
}

// Only a thread the user started notifies; a step's thread tells through its run, and the
// assistant has its own view.
const threadTitleOf = (thread: Thread) =>
  thread.title.trim() === '' ? 'New thread' : thread.title;

const notifiesAsChat = (thread: Thread) => thread.runId === null && thread.kind !== 'assistant';

export const threadPath = (threadId: string) => `/chat/${threadId}`;

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

type Tasks = TaskListItemPayload['tasks'];

const sameTasks = (a: Tasks, b: Tasks) =>
  a.length === b.length &&
  a.every(
    (task, index) =>
      task.id === b[index]?.id &&
      task.content === b[index]?.content &&
      task.status === b[index]?.status,
  );

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
  context: DecideContext,
): DomainEvent[] {
  const now = context.now;
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
  // The task lists of each turn, as stored and as added in this batch.
  const taskLists = new Map<string, { count: number; last: Tasks | undefined }>();
  const turnTaskLists = (ofTurn: string) => {
    const stored = read.turnTaskLists(ofTurn);
    const last = TaskListItemPayload.safeParse(stored.last);
    return { count: stored.count, last: last.success ? last.data.tasks : undefined };
  };
  let seen = thread.seen ?? true;
  let archived = thread.archived ?? false;
  const unarchive = () => {
    if (!archived) return;
    archived = false;
    out.push(unarchived(threadId));
  };
  // The assistant thread is not in the thread list, so it has nothing to mark.
  const markUnseen = () => {
    if (!seen || thread.kind === 'assistant') return;
    seen = false;
    out.push(seenChanged(threadId, false));
  };
  // The newest assistant text this batch wrote, for a plan request without its plan.
  let lastText: { id: string; text: string } | undefined;
  const told = new Set<string>();
  const notifications = notifiesAsChat(thread) ? chatNotifications(read, context) : 'off';
  const needsYou = (key: string, summary: string, approvalId: string | null) => {
    markUnseen();
    if (notifications === 'off') return;
    const id = `${threadId}:needs-you:${key}`;
    // The questions of one ask arrive one by one and are told once.
    if (told.has(id)) return;
    told.add(id);
    out.push({
      kind: 'notification.sent',
      aggregate: id,
      payload: {
        id,
        at: now,
        kind: 'waiting',
        title: `Needs you: ${threadTitleOf(thread)}`,
        body: summary,
        path: threadPath(threadId),
        runId: null,
        calendarItemId: null,
        threadId,
        approvalId,
      },
    });
  };
  const finished = (ended: Turn, how: TurnState) => {
    markUnseen();
    // The user stopped it themselves, so there is nothing to tell.
    if (notifications !== 'needsYouAndFinished' || how === 'interrupted') return;
    const ran = Date.parse(now) - Date.parse(ended.startedAt);
    if (!(ran > finishedAfterMs(read, context))) return;
    const id = `${ended.id}:finished`;
    out.push({
      kind: 'notification.sent',
      aggregate: id,
      payload: {
        id,
        at: now,
        kind: 'finished',
        title: `Finished: ${threadTitleOf(thread)}`,
        body: how === 'failed' ? 'The turn failed.' : '',
        path: threadPath(threadId),
        runId: null,
        calendarItemId: null,
        threadId,
        approvalId: null,
      },
    });
  };

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
      unarchive();
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
        if (event.type === 'textDelta') {
          lastText =
            lastText?.id === id
              ? { id, text: lastText.text + event.delta }
              : { id, text: (textOf(read.threadItem(id)) ?? '') + event.delta };
        }
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
          // The server's clock stamps the start, so a reload shows the same time (spec 30).
          add(
            current,
            id,
            'tool_call',
            {
              ...toolFactsOf(event),
              ...cutToolDiff(event.diff, read, context),
              name: event.name,
              input: event.input ?? null,
              output: '',
              status: 'running',
              startedAt: now,
            },
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
        if (exists(id)) {
          patch(
            current,
            id,
            'tool_call',
            {
              status: event.status,
              endedAt: now,
              ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
              ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
              ...(event.diff === undefined
                ? {}
                : {
                    diffCut: false,
                    diffWithoutFile: false,
                    ...cutToolDiff(event.diff, read, context),
                  }),
            },
            false,
          );
        }
        break;
      }
      case 'approvalRequested': {
        const id = approvalRowId(threadId, event.approvalId);
        if (read.approval(id)) break;
        const rowItemId = itemId(`approval:${event.approvalId}`);
        const facts = approvalFactsOf(event.facts, read, context);
        // A rule is only kept for a project, and the assistant is never offered one (spec 38).
        const projectId = thread.kind === 'assistant' ? null : thread.projectId;
        const rule = projectId === null ? undefined : proposeRule(event.kind, facts.facts);
        const covering =
          projectId === null
            ? undefined
            : projectRules(read, projectId).find((stored) =>
                ruleCovers(stored, event.kind, facts.facts),
              );
        const plan =
          event.kind === 'plan' ? planOf(event.facts, current, lastText, read) : undefined;
        const payload: ApprovalItemPayload = {
          approvalId: id,
          kind: event.kind,
          summary: event.summary,
          ...(facts.facts === undefined ? {} : { facts: facts.facts }),
          ...(facts.diffCut ? { diffCut: true } : {}),
          ...(rule === undefined ? {} : { rule }),
          ...(plan === undefined ? {} : { plan }),
          ...(covering === undefined ? {} : { byRule: ruleOf(covering) }),
        };
        out.push({
          kind: 'approval.requested',
          aggregate: threadId,
          payload: {
            approval: {
              id,
              threadId,
              itemId: rowItemId,
              kind: event.kind,
              request: { summary: event.summary, details: event.request ?? null },
              decision: null,
              decidedAt: null,
            },
            item: item(current, rowItemId, 'approval', payload, false),
          },
        });
        // A stored rule answers by itself (spec 39): nobody is asked or told.
        if (covering) {
          out.push({
            kind: 'approval.answered',
            aggregate: threadId,
            payload: {
              approvalId: id,
              threadId,
              providerInstanceId: thread.providerInstanceId,
              providerApprovalId: event.approvalId,
              decision: 'allowOnce',
              decidedAt: now,
              byRule: true,
            },
          });
          break;
        }
        setState('needs_you');
        unarchive();
        needsYou(event.approvalId, event.summary, id);
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
        unarchive();
        needsYou(`question:${event.askId ?? event.questionId}`, event.question, null);
        break;
      }
      case 'taskListUpdated': {
        // Each change is an item of its own, so the conversation marks where the list changed
        // (spec 31). Codex sends its plan again unchanged and Claude Code's adapter sends the
        // list on every task tool call, so a list equal to the last one adds nothing. The first
        // keeps the id a turn's only list had before.
        const lists = taskLists.get(current.id) ?? turnTaskLists(current.id);
        if (lists.last !== undefined && sameTasks(lists.last, event.tasks)) break;
        add(
          current,
          itemId(lists.count === 0 ? 'tasks' : `tasks:${lists.count}`),
          'task_list',
          { tasks: event.tasks, at: now },
          false,
        );
        taskLists.set(current.id, { count: lists.count + 1, last: event.tasks });
        break;
      }
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
        finished(current, ended);
        turn = undefined;
        break;
      }
    }
  }
  return out;
}
