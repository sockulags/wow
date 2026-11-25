import { z } from 'zod';
import { ProposedRuleSchema } from './approvals.js';
import { AskedQuestion } from './questions.js';
import { TrackerConnection } from './trackers.js';

// The app assistant (intent 2026-11-app-assistant): what it changed, what it proposed, and the
// net that hides secret-looking text. The assistant's commands are the ones the views send; these
// are the records the server keeps beside them.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// Who sent a command. Everything that arrives over the app's own connection is the user's; only
// the assistant's tools send as the assistant.
// `helper`: a chat thread's agent through wow's helper tools (agent orchestration spec 2).
export const CommandOrigin = z.enum(['user', 'assistant', 'helper']);
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
  // An own skill, by its name (wow skills spec 8, 22).
  'skill',
]);
export type AssistantTargetKind = z.infer<typeof AssistantTargetKind>;

// The thing a change was made to. A setting's id is `<key>:<scope>`; an own skill's is its name.
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
  // The whole value when `from` or `to` had to be shortened, so the card can show all of it.
  // Absent in proposals stored before they were kept.
  fromFull: z.string().min(1).optional(),
  toFull: z.string().min(1).optional(),
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

// A user name and password written into a web address (https://reader:pass@host). They are taken
// out of every address the net sees whatever the patterns say: a password there has no prefix a
// pattern could know.
const addressAccount = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>`]*@/gi;

export const withoutAddressAccount = (text: string): string => text.replace(addressAccount, '$1');

export function hideSecrets(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (hidden, pattern) => hidden.replace(pattern, hiddenText),
    withoutAddressAccount(text),
  );
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

// The Assistant thread: one per install, with a fixed id, so it is found again after a restart.
export const assistantThreadId = 'assistant';
// The name its agent knows wow's tools by.
export const assistantToolsetName = 'wow';

// What every main thread's agent is told after its provider's own instructions (orchestrator
// threads spec 25): how to use wow's app tools beside its work. The `chat.instructions` default.
export const defaultChatInstructions = `You run inside wow, a desktop app that runs coding agents on a calendar. Beside your own tools you have wow's tools: the helper tools, and the app tools for wow's settings, projects, trackers, workflows, calendar cards, backlog and the readers of mail and calendar.

Using wow's app tools
- Read the state you need with the read tools before you change anything, and ask when something only the person can know is missing.
- An everyday change is applied at once and shown with Undo. A change that lets wow do more on its own is shown as a proposal and happens only when the person presses Yes. You cannot answer a proposal yourself; say that it is waiting for them. When wow refuses something, tell the person the reason wow gave.
- After a change, say what changed and where it lives in wow (for example Settings → Calendar, the card).
- For anything that recurs, make one repeating card with a repeat rule, never a card per occurrence.
- When a few answers are likely, ask with ask_questions and end your turn: the answer comes as the person's next message. Ask one thing at a time unless the questions belong together. Never ask for a secret with it.
- You never approve a request for the person and you never merge.

Secrets
- Never ask for a token, password, key or any other secret, and never ask the person to paste one into the conversation. When a secret is needed, put its field in front of them with show_secret_field. You only ever learn whether a secret is set.
- Never repeat anything that looks like a secret.`;

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

// Asks for a provider instance's secret environment variable (spec 14). The value goes to the
// secret store as `provider:<id>:env:<name>` and the instance holds its reference, as the
// instance editor stores it.
export const assistantSecretVariableTool = 'show_secret_variable';
export const SecretVariableRequest = z
  .object({
    providerInstanceId: Id,
    // The variable's name as the CLI reads it, such as ANTHROPIC_API_KEY.
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name'),
  })
  .strict();
export type SecretVariableRequest = z.infer<typeof SecretVariableRequest>;

// Where a provider instance's secret variable is kept in the secret store.
export const providerSecretName = (providerInstanceId: string, variable: string) =>
  `provider:${providerInstanceId}:env:${variable}`;

// Asks the user one to four questions with the question card (questions spec 9 to 11). The
// assistant's turn ends there; the answer arrives as the user's next message.
export const assistantAskTool = 'ask_questions';
export const AskQuestionsRequest = z
  .object({ questions: z.array(AskedQuestion).min(1).max(4) })
  .strict();
export type AskQuestionsRequest = z.infer<typeof AskQuestionsRequest>;

// The words in a question that make the tool refuse it (spec 11), each matched as a whole word
// or phrase without regard to case. A net, not a proof.
export function askedSecretWord(
  request: AskQuestionsRequest,
  words: readonly string[],
): string | null {
  const texts = request.questions.flatMap((question) => [
    question.question,
    question.header,
    ...question.options.flatMap((option) => [option.label, option.description ?? '']),
  ]);
  for (const word of words) {
    const trimmed = word.trim();
    if (trimmed === '') continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    if (texts.some((text) => pattern.test(text))) return trimmed;
  }
  return null;
}

export const defaultAskRefusedWords: readonly string[] = [
  'token',
  'tokens',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'secret',
  'secrets',
  'key',
  'keys',
  'api key',
  'credential',
  'credentials',
];

// Offers to take a request that is not about operating wow to the chat view (spec 3).
export const assistantProjectWorkTool = 'offer_project_work';
export const ProjectWorkOffer = z.object({ text: z.string().min(1) }).strict();
export type ProjectWorkOffer = z.infer<typeof ProjectWorkOffer>;

// Proposes an "always allow" rule for a project (agent workbench spec 41): a command rule by
// its first words or a tool rule by its name. It is always a proposal; the rule is stored only
// when the user says yes.
export const assistantRuleTool = 'propose_always_allow_rule';
export const AlwaysAllowRuleRequest = z
  .object({ projectId: Id, rule: ProposedRuleSchema })
  .strict();
export type AlwaysAllowRuleRequest = z.infer<typeof AlwaysAllowRuleRequest>;

// Each of wow's tools in words, for the tool row of a call that no change row, proposal card,
// secret field or question card already shows (agent workbench spec 82). The server's tests
// check that every tool it offers is here.
export const assistantToolWords: Readonly<Record<string, string>> = {
  read_settings: 'Read your settings',
  read_projects: 'Read your projects',
  read_providers: 'Read your providers',
  read_workflows: 'Read your workflows',
  read_templates: 'Read the workflow templates',
  read_skills: 'Read your skills',
  read_skill: 'Read a skill',
  read_calendar: 'Read your calendar',
  read_backlog: 'Read your backlog',
  read_thread: "Read a thread's latest messages",
  read_free_slots: 'Looked for free time',
  read_triggers: 'Read your triggers',
  read_notifications: 'Read your notifications',
  read_connections: 'Read your connections',
  test_connection: 'Tested a connection',
  read_token_guide: 'Read the token guide',
  diagnose_setup: 'Checked what does not work',
  read_models: 'Read the models your providers offer',
  read_model_guidance: 'Read the model guidance',
  show_secret_field: 'Showed a secret field',
  show_secret_variable: 'Showed a secret variable field',
  ask_questions: 'Asked you',
  offer_project_work: 'Offered to open it in Chat',
  set_setting: 'Set a setting',
  reset_setting: 'Reset a setting',
  create_project: 'Added a project',
  update_project: 'Changed a project',
  create_card: 'Put a card on the calendar',
  update_card: 'Changed a card',
  skip_card_occurrence: 'Skipped an occurrence of a card',
  delete_card: 'Removed a card',
  start_card_run: "Started a card's workflow",
  create_workflow: 'Created a workflow',
  update_workflow: 'Changed a workflow',
  delete_workflow: 'Deleted a workflow',
  create_backlog_item: 'Added a backlog item',
  update_backlog_item: 'Changed a backlog item',
  delete_backlog_item: 'Deleted a backlog item',
  plan_backlog_item: 'Planned a backlog item',
  create_skill: 'Wrote a skill',
  update_skill: 'Changed a skill',
  delete_skill: 'Removed a skill',
  [assistantRuleTool]: 'Proposed an always-allow rule',
};

// A tool name in words; one this table lacks reads as its own words ("read_x" → "Read x").
export const assistantToolText = (tool: string): string =>
  assistantToolWords[tool] ??
  tool.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());

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

// Why text that looks like a secret was not sent: a held message (spec 17) and a No's reason.
export const heldSecretSentence = (kind: string): string =>
  `Not sent: this looks like ${kind}. Secrets go in their field, where the assistant never sees them.`;

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
  'skill',
  'card',
  // A workflow step without a model its provider needs (questions and models spec 19).
  'model',
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
