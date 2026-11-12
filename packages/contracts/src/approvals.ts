import { z } from 'zod';
import type { ApprovalFacts, ApprovalKind } from './provider.js';

// "Always allow in this project" (agent workbench spec 38 to 40). wow keeps the rules itself, one
// list per project in the `approvals.alwaysAllow` setting, and answers a request a rule covers
// without asking; nothing is written to a provider's own settings. A command rule matches by
// prefix, a tool rule by name. Edits and plans never get a rule.

const Timestamp = z.iso.datetime({ offset: true });

export const AlwaysAllowRule = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    // Whole words: `pnpm test` covers `pnpm test` and `pnpm test --watch`, not `pnpm tests`.
    prefix: z.string().trim().min(1),
    addedAt: Timestamp,
  }),
  z.object({
    kind: z.literal('tool'),
    // An MCP tool's server; null for one of the provider's own tools.
    server: z.string().min(1).nullable(),
    tool: z.string().min(1),
    addedAt: Timestamp,
  }),
]);
export type AlwaysAllowRule = z.infer<typeof AlwaysAllowRule>;

// A rule as an approval offers it, before it is stored.
export type ProposedRule =
  | { readonly kind: 'command'; readonly prefix: string }
  | { readonly kind: 'tool'; readonly server: string | null; readonly tool: string };

export const ProposedRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), prefix: z.string().min(1) }),
  z.object({
    kind: z.literal('tool'),
    server: z.string().min(1).nullable(),
    tool: z.string().min(1),
  }),
]);

export const toolName = (rule: { server: string | null; tool: string }): string =>
  rule.server === null ? rule.tool : `${rule.server} › ${rule.tool}`;

// The words the card and Settings show for a rule, such as "Run commands starting with
// `pnpm test`".
export const ruleText = (rule: ProposedRule | AlwaysAllowRule): string =>
  rule.kind === 'command'
    ? `Run commands starting with \`${rule.prefix}\``
    : `Use the tool \`${toolName(rule)}\``;

export const sameRule = (a: ProposedRule, b: ProposedRule): boolean =>
  a.kind === 'command'
    ? b.kind === 'command' && a.prefix === b.prefix
    : b.kind === 'tool' && a.server === b.server && a.tool === b.tool;

// A command that chains, pipes, redirects, substitutes or quotes is more than its first words, so
// no prefix rule covers it and none is offered for it.
const shellControl = /[;&|<>`$(){}\n\r\\'"]/;

const words = (command: string) =>
  command
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');

// Programs that run another command or script given to them. A rule for one of them would allow
// whatever it is handed next (`bash -lc '…'` allows every script), so they never get one.
const wrappers: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
  'wsl',
  'env',
  'sudo',
  'doas',
  'su',
  'exec',
  'eval',
  'xargs',
  'nohup',
  'nice',
  'time',
  'timeout',
  'command',
  'builtin',
  'start',
]);

const posixShells: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const programName = (word: string) =>
  (word.split(/[\\/]/).at(-1) ?? word).toLowerCase().replace(/\.exe$/, '');

const runsAnother = (command: string) => {
  const [first] = words(command);
  return first !== undefined && wrappers.has(programName(first));
};

const ruleable = (command: string) => !shellControl.test(command) && !runsAnother(command);

// The command a shell is asked to run, when the line is only that: `/bin/zsh -lc 'pnpm test'`,
// `bash -c "pnpm test"` or `powershell.exe -NoProfile -Command "pnpm test"` give `pnpm test`.
// Undefined for anything else. Codex reports a command as the shell line it runs.
export function shellInner(line: string): string | undefined {
  const match =
    /^\s*(\S+)((?:\s+-{1,2}[\w-]+)*?)\s+(-l?c|-Command|\/c)\s+(?:'([^']*)'|"([^"]*)")\s*$/i.exec(
      line,
    );
  if (!match) return undefined;
  const [, program = '', , runSwitch = '', single, double] = match;
  const name = programName(program);
  const asks = runSwitch.toLowerCase();
  const fits =
    (posixShells.has(name) && (asks === '-c' || asks === '-lc')) ||
    ((name === 'powershell' || name === 'pwsh') && (asks === '-command' || asks === '-c')) ||
    (name === 'cmd' && asks === '/c');
  const inner = (single ?? double ?? '').trim();
  return fits && inner !== '' ? inner : undefined;
}

// The rule "always allow" would store for this request, or undefined when it gets none: an edit,
// a plan, a request without a command or tool name, or a command that does more than one thing.
// A prefix the provider proposed is used when it is a prefix of the command (Claude Code's
// `Bash(pnpm test:*)`, Codex's exec policy amendment); else the first word, and the second when
// it is not an option (`pnpm test --watch` gives `pnpm test`).
export function proposeRule(
  kind: ApprovalKind,
  facts: ApprovalFacts | undefined,
): ProposedRule | undefined {
  if (!facts) return undefined;
  if (kind === 'command') {
    const command = facts.command?.trim();
    if (!command || !ruleable(command)) return undefined;
    const hint = facts.ruleHint === undefined ? undefined : words(facts.ruleHint).join(' ');
    if (hint && ruleable(hint) && coversCommand(hint, command)) {
      return { kind: 'command', prefix: hint };
    }
    const [first, second] = words(command);
    if (first === undefined) return undefined;
    const prefix =
      second !== undefined && !second.startsWith('-') && /^[\w.:@/-]+$/.test(second)
        ? `${first} ${second}`
        : first;
    return { kind: 'command', prefix };
  }
  if (kind === 'tool' && facts.tool) {
    return { kind: 'tool', server: facts.server ?? null, tool: facts.tool };
  }
  return undefined;
}

function coversCommand(prefix: string, command: string): boolean {
  const asked = words(command).join(' ');
  return asked === prefix || asked.startsWith(`${prefix} `);
}

// Whether a stored rule answers this request by itself (spec 39).
export function ruleCovers(
  rule: AlwaysAllowRule,
  kind: ApprovalKind,
  facts: ApprovalFacts | undefined,
): boolean {
  if (!facts) return false;
  if (rule.kind === 'command') {
    const command = facts.command?.trim();
    return (
      kind === 'command' &&
      command !== undefined &&
      ruleable(command) &&
      coversCommand(words(rule.prefix).join(' '), command)
    );
  }
  return kind === 'tool' && facts.tool === rule.tool && (facts.server ?? null) === rule.server;
}

// Where a plan card's text came from: the request itself, or, when the request did not carry
// it, the turn's last assistant text, which the card labels as the plan written in the
// conversation (spec Open risks).
export const ApprovalPlan = z.object({
  text: z.string(),
  from: z.enum(['request', 'conversation']),
});
export type ApprovalPlan = z.infer<typeof ApprovalPlan>;

// The modes a plan card starts the work in (spec 42), Claude Code's own ids.
export const planStartModes = ['acceptEdits', 'default'] as const;
