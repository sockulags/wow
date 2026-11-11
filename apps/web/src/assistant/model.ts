import {
  settingsRegistry,
  ProjectWorkOffer,
  SecretFieldRequest,
  TokenGuide,
  ToolCallItemPayload,
  assistantProjectWorkTool,
  assistantSecretFieldTool,
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
      // secret that is not a host token, or an answer that is not in yet.
      readonly guide: TokenGuide | null;
    }
  | { readonly kind: 'projectWork'; readonly offer: ProjectWorkOffer };

const GuideAnswer = z.object({ guide: TokenGuide });

// The guide in what the secret field tool answered, read from the stored tool result.
function guideOf(output: string): TokenGuide | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const answer = GuideAnswer.safeParse(parsed);
  return answer.success ? answer.data.guide : null;
}

// The card a tool call of the agent asks for, read from what it called the tool with.
export function askOf(item: ThreadItem): Ask | null {
  if (item.kind !== 'tool_call') return null;
  const payload = ToolCallItemPayload.safeParse(item.payload);
  if (!payload.success) return null;
  const tool = assistantToolOf(payload.data.name);
  if (tool === assistantSecretFieldTool) {
    const request = SecretFieldRequest.safeParse(payload.data.input);
    return request.success
      ? { kind: 'secretField', request: request.data, guide: guideOf(payload.data.output) }
      : null;
  }
  if (tool === assistantProjectWorkTool) {
    const offer = ProjectWorkOffer.safeParse(payload.data.input);
    return offer.success ? { kind: 'projectWork', offer: offer.data } : null;
  }
  return null;
}

// The secret fields the agent asked for in the conversation, newest last.
export const askedFields = (items: readonly ThreadItem[]): SecretFieldRequest[] =>
  items.flatMap((item) => {
    const ask = askOf(item);
    return ask?.kind === 'secretField' ? [ask.request] : [];
  });

export interface Held {
  readonly text: string;
  readonly match: SecretMatch;
  // The field the value most likely belongs in, or null when none is known.
  readonly field: (SecretFieldRequest & { readonly label: string }) | null;
}

// A message that looks like a secret is held before it is sent (spec 17). Its field is the one
// the kind of token names (a field the agent asked for keeps its project), or else the field
// the agent asked for last.
export function holdMessage(
  text: string,
  sources: readonly string[],
  asked: readonly SecretFieldRequest[],
  definitions: Readonly<Record<string, SettingDefinition>> = registry,
): Held | null {
  const match = findSecret(text, secretPatterns(sources));
  if (match === null) return null;
  const latest = asked.findLast((request) => definitions[request.key]?.secret === true);
  const request: SecretFieldRequest | undefined =
    match.settingKey === null
      ? latest
      : (asked.findLast((entry) => entry.key === match.settingKey) ?? { key: match.settingKey });
  const label = request ? definitions[request.key]?.label : undefined;
  return { text, match, field: request && label ? { ...request, label } : null };
}

// The message with the secret taken out, for the composer after the value went to its field.
export const withoutSecret = (held: Held): string =>
  held.text.split(held.match.value).join('').trim();
