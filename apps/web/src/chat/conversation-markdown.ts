import {
  ApprovalItemPayload,
  CompactionItemPayload,
  ErrorItemPayload,
  QuestionItemPayload,
  ReasoningItemPayload,
  SettingsChangeItemPayload,
  TaskListItemPayload,
  TextItemPayload,
  shownLabel,
  type Approval,
  type Question,
  type QuestionReply,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { decisionLabels } from './approval-card';
import { compactionText, settingsChangeText } from './items';
import { startedLabels } from './plan-card';
import { taskProgress } from './task-pin';
import { editCounts } from './tools/edit';
import {
  agentTask,
  commandOutcome,
  formatDuration,
  oneLine,
  otherFolder,
  payloadOf,
  shownPath,
  toolDuration,
  type ToolPayload,
} from './tools/facts';
import { nestSubagentWork, sentSkillName } from './view-model';

// The conversation as Markdown (thread work spec 7, 8), and the words of the rows that find and
// the export share: a tool call, an approval, a question, a task list update in one line each,
// as the conversation words them. Nothing here reads tool input or output.

// How a row stands where its words depend on it.
export interface LineContext {
  readonly cwd: string;
  // The call's turn has ended, so a call still running there was not finished.
  readonly turnEnded: boolean;
  // A request of the thread waits for an approval, so a running call waits for it.
  readonly awaitingApproval: boolean;
  // With times ("exit 1 · 4.2 s"), for the export; find leaves the clock out.
  readonly times: boolean;
}

const runningWords = (context: LineContext): string =>
  context.awaitingApproval
    ? 'waiting for approval'
    : context.turnEnded
      ? 'not finished'
      : 'running';

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

const joined = (head: string, ...rest: Array<string | undefined>) =>
  [head, ...rest].filter((part): part is string => part !== undefined && part !== '').join(' · ');

// A call's line: "$ pnpm test · exit 1 · 4.2 s", "Edit src/timer.ts +4 −1", "Read README.md
// lines 1-80", "tracker › find_issue", "Agent: explore the auth code · 3 tool calls".
export function toolLine(payload: ToolPayload, context: LineContext): string {
  const running = payload.status === 'running' ? runningWords(context) : undefined;
  const failed = payload.status === 'error' ? 'failed' : undefined;
  const state = running ?? failed;
  const duration =
    context.times && running === undefined ? toolDuration(payload, Date.now()) : undefined;
  const time = duration === undefined ? [] : [formatDuration(duration)];
  switch (payload.kind) {
    case 'command': {
      const folder = otherFolder(payload, context.cwd);
      return joined(
        `$ ${payload.command ?? payload.name}`,
        folder === undefined ? undefined : `in ${folder}`,
        running ?? commandOutcome(payload),
        ...time,
      );
    }
    case 'edit': {
      const target = payload.path === undefined ? undefined : shownPath(payload.path, context.cwd);
      const counts = editCounts(payload.diff, payload.diffCounts);
      const head = `Edit ${target ?? (payload.diff ? 'files' : payload.name)}`;
      return joined(counts === undefined ? head : `${head} ${counts}`, state);
    }
    case 'mcp':
      return joined(`${payload.server ?? ''} › ${payload.tool ?? payload.name}`.trim(), state);
    case 'subagent': {
      const count = payload.toolCount;
      return joined(
        `Agent: ${agentTask(payload)}`,
        count === undefined || count === 0 ? undefined : plural(count, 'tool call'),
        state,
      );
    }
    case 'read':
    case 'search':
    case 'web':
      return joined(oneLine(payload, context.cwd), state);
    default:
      return joined(payload.name, state);
  }
}

// What an approval asked for, as its card names it.
const requested = (payload: ApprovalItemPayload, cwd: string): string => {
  const facts = payload.facts;
  if (payload.kind === 'command') {
    const command = facts?.command ?? payload.summary;
    return command.startsWith('$ ') ? command : `$ ${command}`;
  }
  if (payload.kind === 'fileChange' && facts?.path !== undefined) {
    return `Edit ${shownPath(facts.path, cwd)}`;
  }
  return payload.summary;
};

// "Allowed once: $ pnpm test", "Denied: $ rm -rf build · note: keep the build", "Plan: started,
// accepting edits".
export function approvalLine(
  payload: ApprovalItemPayload,
  approval: Approval | undefined,
  cwd: string,
): string {
  const decision = approval?.decision ?? null;
  const note = payload.note === undefined || payload.note === '' ? [] : [`note: ${payload.note}`];
  if (payload.kind === 'plan') {
    const outcome =
      decision === null
        ? approval
          ? 'waiting for you'
          : 'asked'
        : decision === 'deny'
          ? 'kept planning'
          : (startedLabels[payload.permissionMode ?? ''] ?? 'Started').toLowerCase();
    return [`Plan: ${outcome}`, ...(decision === 'deny' ? note : [])].join(' · ');
  }
  const what = requested(payload, cwd);
  if (payload.byRule) return `Allowed by rule: ${what}`;
  if (decision === null) return approval ? `Waiting for you: ${what}` : `Asked: ${what}`;
  return [`${decisionLabels[decision]}: ${what}`, ...(decision === 'deny' ? note : [])].join(' · ');
}

const answerWords = (reply: QuestionReply | string): string =>
  typeof reply === 'string'
    ? reply
    : [...reply.picked.map(shownLabel), reply.text.trim()].filter((part) => part !== '').join(', ');

// How a question stands, as its card says: answered with what, waiting, or closed when its turn
// ended without an answer.
export function questionStatus(
  payload: QuestionItemPayload,
  questions: readonly Question[],
  turnEnded: boolean,
): { readonly kind: 'answered'; readonly answer: string } | { readonly kind: 'open' | 'closed' } {
  const row = questions.find((entry) => entry.id === payload.questionId);
  if (row && row.answer !== null) {
    return { kind: 'answered', answer: answerWords(payload.reply ?? row.answer) };
  }
  return { kind: row && !turnEnded ? 'open' : 'closed' };
}

export function questionLine(
  payload: QuestionItemPayload,
  questions: readonly Question[],
  turnEnded: boolean,
): string {
  const status = questionStatus(payload, questions, turnEnded);
  const asked = `Question: ${payload.header ? `${payload.header}: ` : ''}${payload.question}`;
  return `${asked} · ${
    status.kind === 'answered'
      ? `answered: ${status.answer}`
      : status.kind === 'open'
        ? 'waiting for you'
        : 'not answered'
  }`;
}

// "Updated tasks (3/7)" as the marker says; a turn's only list from before reads "Tasks (3/7)".
export function taskLine(payload: TaskListItemPayload): string {
  const { done, total } = taskProgress(payload.tasks);
  return `${payload.at === undefined ? 'Tasks' : 'Updated tasks'} (${done}/${total})`;
}

export interface ConversationExport {
  readonly title: string;
  // The facts line: the provider instance's name, the model's label, the project and folder,
  // and the branch where the thread has one.
  readonly instanceName: string;
  readonly model: string;
  readonly project: string | undefined;
  readonly folder: string;
  readonly branch: string | null | undefined;
  readonly exportedAt: string;
  // The items the conversation shows: an edited message's earlier versions are already left out.
  readonly items: readonly ThreadItem[];
  readonly turns: readonly Turn[];
  readonly approvals: readonly Approval[];
  readonly questions: readonly Question[];
  readonly formatAt: (iso: string) => string;
  readonly modelLabel?: ((id: string) => string) | undefined;
  readonly modeLabel?: ((id: string) => string) | undefined;
  // `chat.exportReasoning`.
  readonly reasoning: boolean;
}

type Block = { readonly list: boolean; readonly text: string };

const quoted = (text: string): string =>
  text
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');

function userText(payload: TextItemPayload): string {
  if (payload.answers) return 'Answered the questions above.';
  const parts: string[] = [];
  const images = payload.images ?? [];
  if (images.length > 0) {
    parts.push(images.map((image) => `[image: ${image.name ?? 'pasted image'}]`).join(' '));
  }
  const skills = payload.skills ?? [];
  if (skills.length > 0) parts.push(`Skills: ${skills.map(sentSkillName).join(', ')}`);
  if (payload.text.trim() !== '') parts.push(payload.text.replace(/\n+$/, ''));
  return parts.join('\n\n');
}

// The conversation as Markdown: the title, the facts line, the time of export, then "You ·
// 20:41" and "<instance> · 20:42" headings with the messages as written and one list line per
// tool call, approval, plan, question, error, divider, compaction and task list update.
export function conversationMarkdown(input: ConversationExport): string {
  const { top } = nestSubagentWork(input.items);
  const turns = new Map(input.turns.map((turn) => [turn.id, turn]));
  const pendingApproval = input.approvals.some((approval) => approval.decision === null);
  const head: string[] = [
    `# ${input.title}`,
    [input.instanceName, input.model, input.project, input.folder, input.branch ?? undefined]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · '),
    `Exported ${input.formatAt(input.exportedAt)}`,
  ];
  const blocks: Block[] = [];
  const line = (text: string) => blocks.push({ list: true, text: `- ${text}` });
  const heading = (text: string) => blocks.push({ list: false, text: `## ${text}` });
  const paragraph = (text: string) => {
    if (text.trim() !== '') blocks.push({ list: false, text });
  };
  // The agent's heading opens once a turn shows something of the agent's.
  const answered = new Set<string>();
  const agent = (turn: Turn | undefined) => {
    if (!turn || answered.has(turn.id)) return;
    answered.add(turn.id);
    heading(`${input.instanceName} · ${input.formatAt(turn.endedAt ?? turn.startedAt)}`);
  };
  // A stopped turn ends with its line, as in the conversation.
  const stopped = (turn: Turn | undefined, next: ThreadItem | undefined) => {
    if (turn?.state !== 'interrupted' || next?.turnId === turn.id) return;
    line(`Stopped by you${turn.endedAt ? ` · ${input.formatAt(turn.endedAt)}` : ''}`);
  };
  for (const [index, item] of top.entries()) {
    const turn = turns.get(item.turnId);
    const turnEnded = turn !== undefined && turn.state !== 'running';
    const context: LineContext = {
      cwd: input.folder,
      turnEnded,
      awaitingApproval: pendingApproval,
      times: true,
    };
    switch (item.kind) {
      case 'user': {
        const parsed = TextItemPayload.safeParse(item.payload);
        heading(`You · ${input.formatAt(turn?.startedAt ?? input.exportedAt)}`);
        if (parsed.success) paragraph(userText(parsed.data));
        break;
      }
      case 'assistant_text': {
        const parsed = TextItemPayload.safeParse(item.payload);
        agent(turn);
        if (parsed.success) paragraph(parsed.data.text.replace(/\n+$/, ''));
        break;
      }
      case 'reasoning': {
        if (!input.reasoning) break;
        const parsed = ReasoningItemPayload.safeParse(item.payload);
        if (!parsed.success || parsed.data.text.trim() === '') break;
        agent(turn);
        paragraph(quoted(`Reasoning:\n\n${parsed.data.text}`));
        break;
      }
      case 'tool_call': {
        const payload = payloadOf(item);
        if (!payload) break;
        agent(turn);
        line(toolLine(payload, context));
        // A subagent call is its line and its answer (spec 8).
        const answer =
          payload.kind === 'subagent'
            ? (payload.answer ??
              (payload.status !== 'running' && payload.output !== '' ? payload.output : undefined))
            : undefined;
        if (answer !== undefined && answer.trim() !== '') {
          const last = blocks.pop();
          if (last) {
            blocks.push({
              list: true,
              text: `${last.text}\n\n${quoted(answer)
                .split('\n')
                .map((row) => `  ${row}`)
                .join('\n')}`,
            });
          }
        }
        break;
      }
      case 'approval': {
        const parsed = ApprovalItemPayload.safeParse(item.payload);
        if (!parsed.success) break;
        agent(turn);
        const approval = input.approvals.find((row) => row.id === parsed.data.approvalId);
        line(approvalLine(parsed.data, approval, input.folder));
        break;
      }
      case 'question': {
        const parsed = QuestionItemPayload.safeParse(item.payload);
        if (!parsed.success) break;
        agent(turn);
        line(questionLine(parsed.data, input.questions, turnEnded));
        break;
      }
      case 'task_list': {
        const parsed = TaskListItemPayload.safeParse(item.payload);
        if (!parsed.success) break;
        agent(turn);
        line(taskLine(parsed.data));
        break;
      }
      case 'error': {
        const parsed = ErrorItemPayload.safeParse(item.payload);
        if (!parsed.success) break;
        agent(turn);
        line(`Error: ${parsed.data.message}`);
        break;
      }
      case 'settings_change': {
        const parsed = SettingsChangeItemPayload.safeParse(item.payload);
        if (parsed.success)
          line(settingsChangeText(parsed.data, input.modelLabel, input.modeLabel));
        break;
      }
      case 'compaction': {
        const parsed = CompactionItemPayload.safeParse(item.payload);
        if (parsed.success) line(compactionText(parsed.data));
        break;
      }
      case 'usage':
        break;
    }
    stopped(turn, top[index + 1]);
  }
  let body = '';
  for (const [index, block] of blocks.entries()) {
    const before = blocks[index - 1];
    body += index === 0 ? block.text : `${before?.list && block.list ? '\n' : '\n\n'}${block.text}`;
  }
  return `${head.join('\n\n')}\n\n${body}\n`;
}

// Characters Windows refuses in a file name, and names it keeps for devices.
const refused = /[<>:"/\\|?*]/g;
const deviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// The thread's title as a file name: refused and control characters out, no dot or space at the
// end, no device name, and "conversation" for a title with nothing left.
export function exportFileName(title: string): string {
  const cleaned = [...title]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
    .join('')
    .replace(refused, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const name = cleaned === '' ? 'conversation' : cleaned;
  return `${deviceName.test(name) ? `${name}-conversation` : name}.md`;
}
