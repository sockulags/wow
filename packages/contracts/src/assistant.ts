import { z } from 'zod';
import type { ProviderInstance } from './projections.js';
import { TrackerConnection } from './trackers.js';

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
// kept while it is connected, and otherwise the first connected one is taken. A Codex instance
// is taken only with `allowCodex` (setting `assistant.allowCodex`), because Codex keeps its
// read-only shell tool and so could read any file on the computer. The server decides with
// this; a view can call it with the same rows to say the same thing.
export type AssistantProvider =
  | { readonly instance: ProviderInstance; readonly problem: null }
  | { readonly instance: null; readonly problem: string };

export interface AssistantProviderChoice {
  // `assistant.providerInstanceId`; empty for "the first connected one".
  readonly configuredId: string;
  // The instance the thread runs on now, if it exists.
  readonly currentId?: string | undefined;
  // `assistant.allowCodex`.
  readonly allowCodex: boolean;
}

const connectFirst = 'Connect Claude Code or Codex in Settings → Providers.';

export const assistantCodexOff =
  'The assistant does not run on Codex, because there it can run read-only shell commands and so read files on this computer, including ones that hold secrets, and wow cannot switch that off. Connect Claude Code in Settings → Providers, or turn on "Let the assistant run on Codex" in Settings → Assistant if you accept that.';

export function chooseAssistantProvider(
  instances: readonly ProviderInstance[],
  choice: AssistantProviderChoice,
): AssistantProvider {
  const { currentId, allowCodex } = choice;
  const allowed = (instance: ProviderInstance) => allowCodex || instance.kind !== 'codex';
  const wanted = choice.configuredId.trim();
  if (wanted !== '') {
    const instance = instances.find((entry) => entry.id === wanted);
    if (!instance) {
      return {
        instance: null,
        problem: `The provider instance chosen for the assistant was removed. Choose another in Settings → Assistant, or leave it empty. ${connectFirst}`,
      };
    }
    if (!allowed(instance)) return { instance: null, problem: assistantCodexOff };
    return instance.status === 'ready' ? { instance, problem: null } : notConnected(instance);
  }
  const connected = instances.filter((entry) => entry.status === 'ready' && allowed(entry));
  const instance = connected.find((entry) => entry.id === currentId) ?? connected[0];
  if (instance) return { instance, problem: null };
  const current = instances.find((entry) => entry.id === currentId);
  if (current && allowed(current)) return notConnected(current);
  // Only Codex could run it: the thread ran there, or a Codex instance is connected.
  const codexOnly =
    current !== undefined ||
    instances.some((entry) => entry.status === 'ready' && entry.kind === 'codex');
  if (codexOnly) return { instance: null, problem: assistantCodexOff };
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
- A message can start with a note from wow saying what the person answered to your proposals and which changes they undid since your last turn. Take it into account; the person did not type it.
- After a change, say what changed and where it lives in wow (for example Settings → Calendar, the workflow, the card).
- When the person asks why something does not work, run diagnose_setup and say each thing that fails, its reason and the place to fix it, as wow gave them. When it finds nothing, say so.
- When wow's note says the first-start step just finished, greet the person: say what is set up and what a first run still needs, from the note's lists. Then go through its "To fill in" list in order, one thing per answer: a secret through show_secret_field, and anything else (work hours, project folders) by asking and then making the change. Move on when the person has answered or says to skip it.

What is not yours
- You operate wow only. When someone asks for other work (write this code, explain this error in my project, review this file), say that the chat view is for that and offer to open a new thread there with their text (offer_project_work). Do not attempt the work.
- You never approve, send back or stop a run that waits at a gate, and you never merge. Only the person does that; give them the link to the run.
- You change nothing outside wow: you create no token on a host, install no provider and edit no provider configuration file.

Secrets
- Never ask for a token, password, key or any other secret, and never ask the person to paste one into this conversation. If they offer one, tell them not to send it here.
- When a secret is needed, put its field in front of them with show_secret_field. Say where the person creates it, which rights it needs and what to copy from the guide wow ships (read_token_guide; show_secret_field includes it for a host token), never from memory, and say which host versions the guide was written for. If it says the address is needed first, ask for the address. You only ever learn whether a secret is set and whether the connection test passed.
- Never repeat anything that looks like a secret.

Write plainly and briefly.`;

// Tools that put something in front of the user instead of changing the app. The conversation
// draws a card where the agent called them.

// Asks for a secret setting's field (spec 14). The value typed there goes to the secret store
// with `secrets.set`, as on the settings page; the agent only learns "set" or "not set".
export const assistantSecretFieldTool = 'show_secret_field';
export const SecretFieldRequest = z
  .object({
    // A setting marked `secret`, such as `trackers.gitlab.token`.
    key: z.string().min(1),
    // The project whose own value it is; absent for the shared value.
    projectId: Id.optional(),
  })
  .strict();
export type SecretFieldRequest = z.infer<typeof SecretFieldRequest>;

// Offers to take a request that is not about operating wow to the chat view (spec 3).
export const assistantProjectWorkTool = 'offer_project_work';
export const ProjectWorkOffer = z.object({ text: z.string().min(1) }).strict();
export type ProjectWorkOffer = z.infer<typeof ProjectWorkOffer>;

// The name of one of wow's tools, from the name a provider reports for a tool call, or null for
// any other tool. Claude Code names an MCP tool `mcp__<server>__<tool>` and Codex
// `<server>/<tool>`; wow's server is `assistantToolsetName`.
export function assistantToolOf(reported: string): string | null {
  for (const prefix of [`mcp__${assistantToolsetName}__`, `${assistantToolsetName}/`]) {
    if (reported.startsWith(prefix) && reported.length > prefix.length) {
      return reported.slice(prefix.length);
    }
  }
  return null;
}

// What a message that looks like a secret holds, for the line that holds it (spec 17): a few
// words for the kind, the matched text, and the secret setting it most likely belongs in.
export interface SecretMatch {
  readonly kind: string;
  readonly value: string;
  readonly settingKey: string | null;
}

const secretKinds: ReadonlyArray<{
  readonly test: RegExp;
  readonly kind: string;
  readonly settingKey: string | null;
}> = [
  {
    test: /^(?:gh[pousr]_|github_pat_)/i,
    kind: 'a GitHub token',
    settingKey: 'trackers.github.token',
  },
  { test: /^glpat-/i, kind: 'a GitLab token', settingKey: 'trackers.gitlab.token' },
  { test: /^ATATT/, kind: 'an Atlassian API token', settingKey: 'trackers.jira.token' },
  { test: /^sk-/i, kind: 'an API key', settingKey: null },
  { test: /^AKIA/, kind: 'an AWS access key', settingKey: null },
  { test: /^xox/i, kind: 'a Slack token', settingKey: null },
  { test: /^-----BEGIN/, kind: 'a private key', settingKey: null },
];

// The first part of `text` that the patterns of `assistant.secretPatterns` match, or null. The
// server hides the same matches with `hideSecrets`.
export function findSecret(text: string, patterns: readonly RegExp[]): SecretMatch | null {
  let first: { index: number; value: string } | null = null;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const found = pattern.exec(text);
    pattern.lastIndex = 0;
    if (found && found[0] !== '' && (first === null || found.index < first.index)) {
      first = { index: found.index, value: found[0] };
    }
  }
  if (first === null) return null;
  const known = secretKinds.find((entry) => entry.test.test(first.value));
  return {
    kind: known?.kind ?? 'a token or password',
    value: first.value,
    settingKey: known?.settingKey ?? null,
  };
}

// Where to make a host token and with which rights (spec 15). The guides ship with wow as data
// per host kind and sign-in; the links are built from the address stored in wow, and each guide
// names the host versions it was written for, since token pages move between versions.
export const assistantTokenGuideTool = 'read_token_guide';
export const TokenGuideRequest = z
  .object({ service: TrackerConnection, projectId: Id.optional() })
  .strict();
export type TokenGuideRequest = z.infer<typeof TokenGuideRequest>;

export const TokenGuideStep = z.object({
  text: z.string().min(1),
  // A page on the host, built from the stored address; null for a step without one.
  link: z.string().min(1).nullable(),
});
export type TokenGuideStep = z.infer<typeof TokenGuideStep>;

export const TokenGuide = z.object({
  service: TrackerConnection,
  // The kind of host and sign-in the guide is for, such as "GitHub Enterprise Server".
  host: z.string().min(1),
  writtenFor: z.string().min(1),
  // The secret setting the token goes in.
  tokenSetting: z.string().min(1),
  // The address the links were built from; null while none is stored.
  address: z.string().min(1).nullable(),
  // Set while the address is missing: the setting to fill in first and where it is.
  addressNeeded: z
    .object({ key: z.string().min(1), label: z.string().min(1), place: AssistantPlace })
    .nullable(),
  steps: z.array(TokenGuideStep),
  rights: z.array(z.string().min(1)),
  copy: z.string().min(1),
});
export type TokenGuide = z.infer<typeof TokenGuide>;

// What is failing in the setup, each with the setting or view to fix it in (spec 19, 20).
export const assistantDiagnosisTool = 'diagnose_setup';
export const DiagnosisKind = z.enum([
  'provider',
  'connection',
  'hostRead',
  'skill',
  'trigger',
  'run',
  'card',
]);
export type DiagnosisKind = z.infer<typeof DiagnosisKind>;

export const DiagnosisProblem = z.object({
  kind: DiagnosisKind,
  what: z.string().min(1),
  reason: z.string().min(1),
  place: AssistantPlace,
});
export type DiagnosisProblem = z.infer<typeof DiagnosisProblem>;

export const Diagnosis = z.object({
  outcome: z.literal('diagnosed'),
  summary: z.string().min(1),
  problems: z.array(DiagnosisProblem),
  // What was looked at, so "nothing is failing" says what it covers.
  checked: z.array(z.string().min(1)),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
