import { z } from 'zod';

// The app assistant (intent 2026-11-app-assistant): what it changed, what it proposed, and the
// net that hides secret-looking text. The assistant's commands are the ones the views send; these
// are the records the server keeps beside them.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// Who sent a command. Everything that arrives over the app's own connection is the user's; only
// the assistant's tools send as the assistant.
export const CommandOrigin = z.enum(['user', 'assistant']);
export type CommandOrigin = z.infer<typeof CommandOrigin>;

// What the server does with a command the assistant sends: apply it at once and keep its
// inverse, hold it as a proposal until the user says yes, or refuse it.
export const CommandClass = z.enum(['ordinary', 'proposal', 'refused']);
export type CommandClass = z.infer<typeof CommandClass>;

// Where a changed thing lives in the app: a label such as "Settings → Calendar" and the path
// the web app opens for it.
export const AssistantPlace = z.object({ label: z.string().min(1), path: z.string().min(1) });
export type AssistantPlace = z.infer<typeof AssistantPlace>;

export const AssistantTargetKind = z.enum([
  'setting',
  'project',
  'card',
  'backlogItem',
  'workflow',
  'plan',
  'trigger',
]);
export type AssistantTargetKind = z.infer<typeof AssistantTargetKind>;

// The thing a change was made to. A setting's id is `<key>:<scope>`.
export const AssistantTarget = z.object({ kind: AssistantTargetKind, id: Id });
export type AssistantTarget = z.infer<typeof AssistantTarget>;

export const AssistantChangeState = z.enum(['applied', 'undone']);
export type AssistantChangeState = z.infer<typeof AssistantChangeState>;

// One ordinary change the assistant made (spec 7, 8, 13). `what`, `from` and `to` are the row
// the conversation shows; `from` is null for something new and `to` is null for something
// removed. `expect` and `inverse` are the server's own record for Undo: the values the change
// left behind (null when it removed the thing) and the commands that take it back. Undo is
// refused when the thing no longer holds `expect`.
export const AssistantChange = z.object({
  // The id of the command that made the change.
  id: Id,
  at: Timestamp,
  commandType: z.string().min(1),
  what: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  place: AssistantPlace,
  target: AssistantTarget,
  expect: z.record(z.string(), z.unknown()).nullable(),
  inverse: z.array(z.unknown()),
  state: AssistantChangeState,
  undoneAt: Timestamp.nullable(),
});
export type AssistantChange = z.infer<typeof AssistantChange>;

// One line of a proposal: exactly one thing that would change.
export const AssistantProposalLine = z.object({
  what: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type AssistantProposalLine = z.infer<typeof AssistantProposalLine>;

export const AssistantProposalState = z.enum(['pending', 'accepted', 'declined']);
export type AssistantProposalState = z.infer<typeof AssistantProposalState>;

// A change that waits for the user's yes (spec 9, 10). `command` is the command the assistant
// sent, kept as it was; nothing of it is applied until `assistant.proposal.accept` arrives with
// the user's origin.
export const AssistantProposal = z.object({
  // The id of the command the assistant sent.
  id: Id,
  at: Timestamp,
  commandType: z.string().min(1),
  title: z.string().min(1),
  lines: z.array(AssistantProposalLine),
  place: AssistantPlace,
  command: z.unknown(),
  state: AssistantProposalState,
  answeredAt: Timestamp.nullable(),
  // What the user wrote with a No, for the assistant's next turn.
  reason: z.string().nullable(),
});
export type AssistantProposal = z.infer<typeof AssistantProposal>;

// What stands in for text that looks like a secret (spec 18).
export const hiddenText = '[hidden]';

// A pattern of `assistant.secretPatterns`: a regular expression that compiles and cannot match
// nothing (such a pattern would hide every position of every text).
export const SecretPattern = z
  .string()
  .min(1)
  .refine(
    (source) => {
      try {
        return !new RegExp(source, 'i').test('');
      } catch {
        return false;
      }
    },
    { message: 'Use a regular expression that does not match empty text' },
  );

// Known token prefixes, private key blocks, and a long random-looking string after "token",
// "password", "secret" or "key" (spec 17). A net, not the mechanism: secrets go through their
// field and never enter the conversation.
export const defaultSecretPatterns: readonly string[] = [
  '\\bgh[pousr]_[A-Za-z0-9]{20,}',
  '\\bgithub_pat_[A-Za-z0-9_]{20,}',
  '\\bglpat-[A-Za-z0-9_-]{20,}',
  '\\bATATT[A-Za-z0-9_=-]{20,}',
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
  '\\bsk-[A-Za-z0-9_-]{20,}',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)',
  '(?<=\\b(?:token|password|passwd|secret|key)\\b["\']?\\s*(?:[:=]|is)?\\s*["\']?)(?=[A-Za-z0-9+/_=-]*\\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_-][A-Za-z0-9+/_=-]{23,}',
];

// Compiles the setting's patterns, leaving out one that does not compile (a stored value from
// before a pattern was refused must not take the net away).
export function secretPatterns(sources: readonly string[]): RegExp[] {
  return sources.flatMap((source) => {
    try {
      return [new RegExp(source, 'gi')];
    } catch {
      return [];
    }
  });
}

export function hideSecrets(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((hidden, pattern) => hidden.replace(pattern, hiddenText), text);
}

export const looksLikeSecret = (text: string, patterns: readonly RegExp[]): boolean =>
  hideSecrets(text, patterns) !== text;

// The same for every string inside a JSON value, keys included.
export function hideSecretsDeep(value: unknown, patterns: readonly RegExp[]): unknown {
  if (typeof value === 'string') return hideSecrets(value, patterns);
  if (Array.isArray(value)) return value.map((inner) => hideSecretsDeep(inner, patterns));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        hideSecrets(key, patterns),
        hideSecretsDeep(inner, patterns),
      ]),
    );
  }
  return value;
}
