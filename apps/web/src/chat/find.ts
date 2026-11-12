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
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { questionStatus, taskLine, toolLine } from './conversation-markdown';
import { compactionText, settingsChangeText } from './items';
import { withoutMentions } from './mentions';
import { openKey } from './open-state';
import { argumentList, lastLines, payloadOf, type ToolPayload } from './tools/facts';
import { sentSkillName, type ConversationEntry } from './view-model';

// Find in a chat thread's conversation (thread work spec 1 to 5). It searches the text the rows
// show, worded by the rows' own functions, so a match is never something the user cannot see;
// searching the page alone would miss closed rows, which hold most of a long thread's text. Each
// piece of text names its row and what has to open for it to show.

export interface FindPiece {
  // The row the text is drawn in (its `data-item-id`).
  readonly itemId: string;
  readonly text: string;
  // The open-state keys (open-state.ts) of what holds it, outermost first.
  readonly opens: readonly string[];
}

export interface FindSource {
  // The conversation's entries as the view draws them, and each subagent call's own work.
  readonly entries: readonly ConversationEntry[];
  readonly children: ReadonlyMap<string, readonly ThreadItem[]>;
  readonly turns: readonly Turn[];
  readonly approvals: readonly Approval[];
  readonly questions: readonly Question[];
  readonly cwd: string;
  // `chat.toolOutputLines`: an output's earlier lines show only after "Show all N lines".
  readonly outputLines: number;
  readonly modelLabel?: ((id: string) => string) | undefined;
  readonly modeLabel?: ((id: string) => string) | undefined;
}

// Containers put their children on lines of their own; a table row's cells are tab apart; a
// paragraph, a heading and inline nodes run on.
const lineContainers = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'table',
  'footnoteDefinition',
]);

function nodeText(node: Nodes): string {
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if ('value' in node) return node.value;
  if (!('children' in node)) return '';
  const children: readonly Nodes[] = node.children;
  const separator = lineContainers.has(node.type) ? '\n' : node.type === 'tableRow' ? '\t' : '';
  return children.map((child) => nodeText(child)).join(separator);
}

// A message's text as the renderer reads it: its markdown parsed with GFM, as react-markdown
// does, and turned into text, so `**bold**` is found as "bold".
export const markdownText = (markdown: string): string =>
  nodeText(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));

// Messages parsed before, by item: only the streaming one changes as find reads again.
export type MarkdownCache = Map<string, { readonly markdown: string; readonly text: string }>;

const cachedText = (cache: MarkdownCache | undefined, key: string, markdown: string): string => {
  const known = cache?.get(key);
  if (known?.markdown === markdown) return known.text;
  const text = markdownText(markdown);
  cache?.set(key, { markdown, text });
  return text;
};

// The lines a diff shows, without their +, - or space.
const diffText = (diff: string): string =>
  diff
    .split('\n')
    .filter((line) => !line.startsWith('@@') && !line.startsWith('\\'))
    .map((line) => line.slice(1))
    .join('\n');

// An output's earlier lines, shown after "Show all N lines", and its last lines, shown at once.
function outputPieces(
  itemId: string,
  output: string,
  outputLines: number,
  opens: readonly string[],
): FindPiece[] {
  if (output === '') return [];
  const { shown, total } = lastLines(output, outputLines);
  if (total <= outputLines) return [{ itemId, text: output, opens }];
  const lines = output.replace(/\n$/, '').split('\n');
  const earlier = lines.slice(0, total - outputLines).join('\n');
  return [
    { itemId, text: earlier, opens: [...opens, openKey('output', itemId)] },
    { itemId, text: shown, opens },
  ];
}

interface Walk {
  readonly source: FindSource;
  readonly turnEnded: (turnId: string) => boolean;
  readonly awaitingApproval: boolean;
  readonly pieces: FindPiece[];
  readonly cache: MarkdownCache | undefined;
}

function toolPieces(walk: Walk, item: ThreadItem, payload: ToolPayload, opens: readonly string[]) {
  const { source, pieces } = walk;
  const add = (text: string, within: readonly string[]) => {
    if (text !== '') pieces.push({ itemId: item.id, text, opens: within });
  };
  const line = toolLine(payload, {
    cwd: source.cwd,
    turnEnded: walk.turnEnded(item.turnId),
    awaitingApproval: walk.awaitingApproval,
    times: false,
  });
  if (payload.kind === 'subagent') {
    add([line, payload.agentType].filter(Boolean).join(' · '), opens);
    const inside = [...opens, openKey('agent', item.id)];
    if (payload.prompt !== undefined) add(payload.prompt, inside);
    for (const child of source.children.get(item.id) ?? []) itemPieces(walk, child, inside);
    const working = payload.status === 'running' && !walk.turnEnded(item.turnId);
    if (payload.answer !== undefined) add(cachedText(walk.cache, item.id, payload.answer), opens);
    else if (!working)
      pieces.push(...outputPieces(item.id, payload.output, source.outputLines, opens));
    return;
  }
  const args =
    payload.kind === 'mcp'
      ? argumentList(payload.input)
          .map(([key, value]) => `${key}: ${value}`)
          .join(' · ')
      : '';
  add([line, args].filter(Boolean).join(' · '), opens);
  const body = [...opens, openKey('row', item.id)];
  if (payload.kind === 'edit' && payload.diff !== undefined) {
    add(diffText(payload.diff), body);
    return;
  }
  if (payload.kind === 'mcp') add(args.replaceAll(' · ', '\n'), body);
  if (payload.kind === undefined || payload.kind === 'other' || payload.kind === 'edit') {
    add(payload.output, body);
    return;
  }
  pieces.push(...outputPieces(item.id, payload.output, source.outputLines, body));
}

function approvalPieces(walk: Walk, item: ThreadItem, payload: ApprovalItemPayload) {
  const approval = walk.source.approvals.find((row) => row.id === payload.approvalId);
  const decision = approval?.decision ?? null;
  const facts = payload.facts;
  const texts: string[] = [];
  if (payload.kind === 'plan') {
    if (payload.plan) texts.push(cachedText(walk.cache, item.id, payload.plan.text));
  } else {
    texts.push(payload.summary);
    if (facts?.command) texts.push(`$ ${facts.command}`);
    if (payload.kind === 'fileChange' && facts?.diff) texts.push(diffText(facts.diff));
    if (facts?.url) texts.push(facts.url);
    if (facts?.tool) {
      texts.push(facts.server ? `${facts.server} › ${facts.tool}` : facts.tool);
      if (typeof facts.arguments === 'object' && facts.arguments !== null) {
        texts.push(
          argumentList(facts.arguments)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n'),
        );
      }
    }
  }
  if (decision !== null && payload.note) texts.push(payload.note);
  for (const text of texts) {
    if (text !== '') walk.pieces.push({ itemId: item.id, text, opens: [] });
  }
}

function questionPieces(walk: Walk, item: ThreadItem, payload: QuestionItemPayload) {
  const status = questionStatus(payload, walk.source.questions, walk.turnEnded(item.turnId));
  const texts = [
    payload.header ?? '',
    payload.question,
    ...(status.kind === 'open'
      ? payload.options.flatMap((option) => [shownLabel(option.label), option.description ?? ''])
      : []),
    status.kind === 'answered' ? status.answer : '',
  ];
  for (const text of texts) {
    if (text !== '') walk.pieces.push({ itemId: item.id, text, opens: [] });
  }
}

function itemPieces(walk: Walk, item: ThreadItem, opens: readonly string[]) {
  const { pieces, source } = walk;
  const add = (text: string, within: readonly string[] = opens) => {
    if (text !== '') pieces.push({ itemId: item.id, text, opens: within });
  };
  switch (item.kind) {
    case 'user': {
      const parsed = TextItemPayload.safeParse(item.payload);
      if (!parsed.success) return;
      if (parsed.data.answers) {
        add('Answered the questions above.');
        return;
      }
      const files = parsed.data.files ?? [];
      add(files.join('\n'));
      add((parsed.data.skills ?? []).map(sentSkillName).join('\n'));
      add(withoutMentions(parsed.data.text, files));
      return;
    }
    case 'assistant_text': {
      const parsed = TextItemPayload.safeParse(item.payload);
      if (parsed.success) add(cachedText(walk.cache, item.id, parsed.data.text));
      return;
    }
    case 'reasoning': {
      const parsed = ReasoningItemPayload.safeParse(item.payload);
      if (parsed.success) add(parsed.data.text, [...opens, openKey('reasoning', item.id)]);
      return;
    }
    case 'tool_call': {
      const payload = payloadOf(item);
      if (payload) toolPieces(walk, item, payload, opens);
      return;
    }
    case 'approval': {
      const parsed = ApprovalItemPayload.safeParse(item.payload);
      if (parsed.success) approvalPieces(walk, item, parsed.data);
      return;
    }
    case 'question': {
      const parsed = QuestionItemPayload.safeParse(item.payload);
      if (parsed.success) questionPieces(walk, item, parsed.data);
      return;
    }
    case 'task_list': {
      const parsed = TaskListItemPayload.safeParse(item.payload);
      if (!parsed.success) return;
      const tasks = parsed.data.tasks.map((task) => task.content).join('\n');
      if (parsed.data.at === undefined) {
        add(`Tasks\n${tasks}`);
        return;
      }
      add(taskLine(parsed.data));
      add(tasks, [...opens, openKey('tasks', item.id)]);
      return;
    }
    case 'error': {
      const parsed = ErrorItemPayload.safeParse(item.payload);
      if (parsed.success) add(parsed.data.message);
      return;
    }
    case 'settings_change': {
      const parsed = SettingsChangeItemPayload.safeParse(item.payload);
      if (parsed.success) add(settingsChangeText(parsed.data, source.modelLabel, source.modeLabel));
      return;
    }
    case 'compaction': {
      const parsed = CompactionItemPayload.safeParse(item.payload);
      if (parsed.success) add(compactionText(parsed.data));
      return;
    }
    case 'usage':
      return;
  }
}

// Each shown item's text in reading order, with the row it lies in and what holds it.
export function conversationText(source: FindSource, cache?: MarkdownCache): FindPiece[] {
  const turns = new Map(source.turns.map((turn) => [turn.id, turn]));
  const walk: Walk = {
    source,
    turnEnded: (turnId) => {
      const turn = turns.get(turnId);
      return turn !== undefined && turn.state !== 'running';
    },
    awaitingApproval: source.approvals.some((approval) => approval.decision === null),
    pieces: [],
    cache,
  };
  for (const entry of source.entries) {
    if (entry.kind === 'item') itemPieces(walk, entry.item, []);
    else if (entry.kind === 'questions') {
      for (const item of entry.items) itemPieces(walk, item, []);
    } else {
      for (const item of entry.items) itemPieces(walk, item, [openKey('group', entry.id)]);
    }
  }
  return walk.pieces;
}

// Case is ignored for every letter. A letter whose lower case is longer than itself (a dotted
// capital I) stays as it is, so every match keeps its place in the text.
export const foldCase = (text: string): string => {
  let folded = '';
  for (const unit of text) {
    const lower = unit.toLowerCase();
    folded += lower.length === unit.length ? lower : unit;
  }
  return folded;
};

export interface FindMatch {
  readonly piece: number;
  readonly itemId: string;
  readonly start: number;
  readonly end: number;
  // Which match of its row it is, counted from the row's first.
  readonly nth: number;
}

export interface FindResult {
  readonly matches: readonly FindMatch[];
  // There are more than `limit` matches (`chat.findMaxMatches`).
  readonly more: boolean;
}

export function findMatches(
  pieces: readonly FindPiece[],
  query: string,
  limit: number,
): FindResult {
  const needle = foldCase(query);
  if (needle === '') return { matches: [], more: false };
  const matches: FindMatch[] = [];
  const perItem = new Map<string, number>();
  for (const [index, piece] of pieces.entries()) {
    const haystack = foldCase(piece.text);
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      if (matches.length === limit) return { matches, more: true };
      const nth = perItem.get(piece.itemId) ?? 0;
      perItem.set(piece.itemId, nth + 1);
      matches.push({
        piece: index,
        itemId: piece.itemId,
        start: from,
        end: from + needle.length,
        nth,
      });
      from = haystack.indexOf(needle, from + needle.length);
    }
  }
  return { matches, more: false };
}

// "3 of 12", "No matches", or the limit and a plus ("1000+").
export function findCountText(result: FindResult, current: number, limit: number): string {
  if (result.more) return `${limit}+`;
  if (result.matches.length === 0) return 'No matches';
  return `${current + 1} of ${result.matches.length}`;
}

// Where the current match is after the matches changed: on the same match of the same row
// while there is one (spec 5), else the row's first, else the first of all.
export function keepCurrent(
  matches: readonly FindMatch[],
  current: Pick<FindMatch, 'itemId' | 'nth'> | undefined,
): number {
  if (matches.length === 0) return -1;
  if (!current) return 0;
  const same = matches.findIndex(
    (match) => match.itemId === current.itemId && match.nth === current.nth,
  );
  if (same !== -1) return same;
  const row = matches.findIndex((match) => match.itemId === current.itemId);
  return row === -1 ? 0 : row;
}
