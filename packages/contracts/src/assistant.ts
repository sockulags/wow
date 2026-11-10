import { z } from 'zod';
import type { ProviderInstance } from './projections.js';

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

// One ordinary change the assistant made (spec 7, 8, 13), as the conversation shows it: `from`
// is null for something new and `to` is null for something removed. This is all a client gets;
// the server's own record for Undo is `AssistantChangeRecord` (commands.ts).
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

// A change that waits for the user's yes (spec 9, 10), as its card shows it. This is all a
// client gets; the command it holds is in `AssistantProposalRecord` (commands.ts).
export const AssistantProposal = z.object({
  // The id of the command the assistant sent.
  id: Id,
  at: Timestamp,
  commandType: z.string().min(1),
  title: z.string().min(1),
  lines: z.array(AssistantProposalLine),
  place: AssistantPlace,
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

// The assistant thread: one per install, with a fixed id, so it is found again after a restart.
export const assistantThreadId = 'assistant';
// The name its agent knows wow's tools by.
export const assistantToolsetName = 'wow';

// Which provider instance runs the assistant, or the sentence that says why none can (spec 1,
// 27). The setting names an instance; left empty, the instance the thread already runs on is
// kept while it is connected, and otherwise the first connected one is taken. The server decides
// with this; a view can call it with the same rows to say the same thing.
export type AssistantProvider =
  | { readonly instance: ProviderInstance; readonly problem: null }
  | { readonly instance: null; readonly problem: string };

const connectFirst = 'Connect Claude Code or Codex in Settings → Providers.';

export function chooseAssistantProvider(
  instances: readonly ProviderInstance[],
  configuredId: string,
  currentId?: string,
): AssistantProvider {
  const wanted = configuredId.trim();
  if (wanted !== '') {
    const instance = instances.find((entry) => entry.id === wanted);
    if (!instance) {
      return {
        instance: null,
        problem: `The provider instance chosen for the assistant was removed. Choose another in Settings → Assistant, or leave it empty. ${connectFirst}`,
      };
    }
    return instance.status === 'ready' ? { instance, problem: null } : notConnected(instance);
  }
  const connected = instances.filter((entry) => entry.status === 'ready');
  const instance = connected.find((entry) => entry.id === currentId) ?? connected[0];
  if (instance) return { instance, problem: null };
  const current = instances.find((entry) => entry.id === currentId);
  if (current) return notConnected(current);
  return {
    instance: null,
    problem:
      currentId === undefined
        ? `No provider is connected, so the assistant cannot run. ${connectFirst}`
        : `The provider instance the assistant ran on was removed and no other is connected. ${connectFirst}`,
  };
}

function notConnected(instance: ProviderInstance): AssistantProvider {
  const why =
    instance.status === 'error'
      ? `its last test failed${instance.statusMessage ? ` (${instance.statusMessage})` : ''}`
      : 'it has not passed a test yet';
  return {
    instance: null,
    problem: `The assistant runs on ${instance.name}, and ${why}. Test it in Settings → Providers.`,
  };
}

export const defaultAssistantInstructions = `You are the assistant inside wow, a desktop app that runs coding agents on a calendar. Your only job is to operate wow itself for the person you are talking to: its settings, projects, trackers and hosts, workflows, calendar cards, backlog, plans, triggers and runs.

What you can do
- You have wow's own tools and nothing else. You cannot read or write files, run commands or reach the network, and you never see a project's files or a chat thread's messages.
- Read the state you need with the read tools before you change anything, and ask when something only the person can know is missing.
- Make a change with the tool for it. An everyday change is applied at once and the conversation shows it with Undo. A change that lets wow do more on its own, and starting a run, is shown to the person as a proposal and happens only when they press Yes. You cannot answer a proposal yourself; say that it is waiting for them.
- When wow refuses something, tell the person the reason wow gave.
- After a change, say what changed and where it lives in wow (for example Settings → Calendar, the workflow, the card).

What is not yours
- You operate wow only. When someone asks for other work (write this code, explain this error in my project, review this file), say that the chat view is for that and offer to open a new thread there with their text. Do not attempt the work.
- You never approve, send back or stop a run that waits at a gate, and you never merge. Only the person does that; give them the link to the run.
- You change nothing outside wow: you create no token on a host, install no provider and edit no provider configuration file.

Secrets
- Never ask for a token, password, key or any other secret, and never ask the person to paste one into this conversation. If they offer one, tell them not to send it here.
- When a secret is needed, say where the person creates it and which rights it needs, and point them to the field in wow where it goes. You only ever learn whether a secret is set and whether the connection test passed.
- Never repeat anything that looks like a secret.

Write plainly and briefly.`;
