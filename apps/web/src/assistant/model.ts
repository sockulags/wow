import {
  settingsRegistry,
  ProjectWorkOffer,
  SecretFieldRequest,
  SecretVariableRequest,
  TokenGuide,
  ToolCallItemPayload,
  assistantProjectWorkTool,
  assistantSecretFieldTool,
  assistantSecretVariableTool,
  assistantToolOf,
  findSecret,
  secretPatterns,
  type AssistantChange,
  type AssistantProposal,
  type SecretMatch,
  type SettingDefinition,
  type ThreadItem,
} from '@wow/contracts';
import { z } from 'zod';
import { createStore } from 'zustand';

// The Assistant view's reading of the conversation (app assistant spec 7 to 17): where change
// rows and proposals go, the cards a tool call asks for, and the check before a message is sent.

// The registry by plain key, for keys that arrive as text (a tool call's input).
export const registry: Readonly<Record<string, SettingDefinition>> = settingsRegistry;

export interface Placed {
  readonly changes: readonly AssistantChange[];
  readonly proposals: readonly AssistantProposal[];
}

// What a change tool answered: the id of the row it made, if any.
const ToolAnswer = z.object({
  change: z.object({ id: z.string() }).optional(),
  proposal: z.object({ id: z.string() }).optional(),
});

function answerIds(item: ThreadItem): string[] {
  if (item.kind !== 'tool_call') return [];
  const payload = ToolCallItemPayload.safeParse(item.payload);
  if (!payload.success || assistantToolOf(payload.data.name) === null) return [];
  let output: unknown;
  try {
    output = JSON.parse(payload.data.output);
  } catch {
    return [];
  }
  const answer = ToolAnswer.safeParse(output);
  if (!answer.success) return [];
  return [answer.data.change?.id, answer.data.proposal?.id].filter(
    (id): id is string => id !== undefined,
  );
}

// Each row goes right after the tool call that made it ("inline where it happened"); a row whose
// call cannot be found (an answer the agent's provider reported differently) goes at the end,
// in the order made.
export function placeRows(
  items: readonly ThreadItem[],
  changes: readonly AssistantChange[],
  proposals: readonly AssistantProposal[],
): { readonly after: ReadonlyMap<string, Placed>; readonly rest: Placed } {
  const itemOf = new Map<string, string>();
  for (const item of items) for (const id of answerIds(item)) itemOf.set(id, item.id);
  const after = new Map<string, { changes: AssistantChange[]; proposals: AssistantProposal[] }>();
  const rest: { changes: AssistantChange[]; proposals: AssistantProposal[] } = {
    changes: [],
    proposals: [],
  };
  const slot = (id: string) => {
    const itemId = itemOf.get(id);
    if (itemId === undefined) return rest;
    let placed = after.get(itemId);
    if (!placed) {
      placed = { changes: [], proposals: [] };
      after.set(itemId, placed);
    }
    return placed;
  };
  for (const change of changes) slot(change.id).changes.push(change);
  for (const proposal of proposals) slot(proposal.id).proposals.push(proposal);
  return { after, rest };
}

export type Ask =
  | {
      readonly kind: 'secretField';
      readonly request: SecretFieldRequest;
      // The token guide the tool answered with (spec 15), shown above the field; null for a
      // secret that is not a host token.
      readonly guide: TokenGuide | null;
    }
  | { readonly kind: 'secretVariable'; readonly request: SecretVariableRequest }
  | { readonly kind: 'projectWork'; readonly offer: ProjectWorkOffer };

// What the tool answered, read from the stored tool result: wow's tools answer JSON.
function answerOf(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

const Answered = <T extends string>(outcome: T) => z.object({ outcome: z.literal(outcome) });
const FieldShown = Answered('shown').extend({ guide: z.unknown().optional() });
const WorkOffered = Answered('offered');

// The card a tool call of the agent asks for: the input says which, and only a call the server
// answered with its outcome draws it. A call it refused, or one still running, draws nothing, so
// a field the server would not show can never be saved from here.
export function askOf(item: ThreadItem): Ask | null {
  if (item.kind !== 'tool_call') return null;
  const payload = ToolCallItemPayload.safeParse(item.payload);
  if (!payload.success || payload.data.status !== 'ok') return null;
  const tool = assistantToolOf(payload.data.name);
  if (tool === assistantSecretFieldTool) {
    const request = SecretFieldRequest.safeParse(payload.data.input);
    const answer = FieldShown.safeParse(answerOf(payload.data.output));
    return request.success && answer.success
      ? {
          kind: 'secretField',
          request: request.data,
          guide: TokenGuide.safeParse(answer.data.guide).data ?? null,
        }
      : null;
  }
  if (tool === assistantSecretVariableTool) {
    const request = SecretVariableRequest.safeParse(payload.data.input);
    const answer = FieldShown.safeParse(answerOf(payload.data.output));
    return request.success && answer.success
      ? { kind: 'secretVariable', request: request.data }
      : null;
  }
  if (tool === assistantProjectWorkTool) {
    const offer = ProjectWorkOffer.safeParse(payload.data.input);
    const answer = WorkOffered.safeParse(answerOf(payload.data.output));
    return offer.success && answer.success ? { kind: 'projectWork', offer: offer.data } : null;
  }
  return null;
}

// The secret fields and variables the agent asked for in the conversation, newest last.
export const askedFields = (
  items: readonly ThreadItem[],
): (SecretFieldRequest | SecretVariableRequest)[] =>
  items.flatMap((item) => {
    const ask = askOf(item);
    return ask?.kind === 'secretField' || ask?.kind === 'secretVariable' ? [ask.request] : [];
  });

export const isVariable = (
  request: SecretFieldRequest | SecretVariableRequest,
): request is SecretVariableRequest => 'variable' in request;

// What a variable's field is called: the variable's name and its instance's.
export const variableLabel = (request: SecretVariableRequest, instanceName: string | undefined) =>
  `${request.variable} (${instanceName ?? request.providerInstanceId})`;

export type HeldField =
  | (SecretFieldRequest & { readonly label: string })
  | (SecretVariableRequest & { readonly label: string });

export interface Held {
  readonly text: string;
  readonly match: SecretMatch;
  // The field the value most likely belongs in, or null when none is known.
  readonly field: HeldField | null;
}

// A message that looks like a secret is held before it is sent (spec 17). Its field is the one
// the kind of token names (a field the agent asked for keeps its project), or else the field or
// provider variable the agent asked for last.
export function holdMessage(
  text: string,
  sources: readonly string[],
  asked: readonly (SecretFieldRequest | SecretVariableRequest)[],
  definitions: Readonly<Record<string, SettingDefinition>> = registry,
  instanceName: (providerInstanceId: string) => string | undefined = () => undefined,
): Held | null {
  const match = findSecret(text, secretPatterns(sources));
  if (match === null) return null;
  if (match.settingKey === null) {
    const latest = asked.findLast(
      (request) => isVariable(request) || definitions[request.key]?.secret === true,
    );
    if (latest && isVariable(latest)) {
      const label = variableLabel(latest, instanceName(latest.providerInstanceId));
      return { text, match, field: { ...latest, label } };
    }
    const label = latest ? definitions[latest.key]?.label : undefined;
    return { text, match, field: latest && label ? { ...latest, label } : null };
  }
  const { settingKey } = match;
  const request = asked.findLast(
    (entry): entry is SecretFieldRequest => !isVariable(entry) && entry.key === settingKey,
  ) ?? { key: settingKey };
  const label = definitions[request.key]?.label;
  return { text, match, field: label ? { ...request, label } : null };
}

// The message with the secret taken out, for the composer after the value went to its field:
// the box as it is now, which can have changed since the message was held.
export const withoutSecret = (held: Held, text: string = held.text): string =>
  text.split(held.match.value).join('').trim();

// The proposal card to bring into view and focus, from the waiting line's Show or the palette
// (agent workbench spec 96). The card that has the id takes it and clears it.
export const proposalFocus = createStore<{ readonly id: string | undefined }>(() => ({
  id: undefined,
}));

// The proposals that wait for the user, oldest first.
export const waitingProposals = (
  proposals: readonly AssistantProposal[],
): readonly AssistantProposal[] => proposals.filter((proposal) => proposal.state === 'pending');

// "1 proposal waits: Run scripts in HTML files", "2 proposals wait: …" with the oldest named.
export function waitingText(waiting: readonly AssistantProposal[]): string | undefined {
  const [first] = waiting;
  if (!first) return undefined;
  const count = waiting.length === 1 ? '1 proposal waits' : `${waiting.length} proposals wait`;
  return `${count}: ${first.title}`;
}
