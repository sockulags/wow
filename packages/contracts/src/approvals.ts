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

// A command that chains, pipes, redirects or substitutes is more than its first words, so no
// prefix rule covers it and none is offered for it.
const shellControl = /[;&|<>`$(){}\n\r\\]/;

const words = (command: string) =>
  command
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');

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
    if (!command || shellControl.test(command)) return undefined;
    const hint = facts.ruleHint === undefined ? undefined : words(facts.ruleHint).join(' ');
    if (hint && !shellControl.test(hint) && coversCommand(hint, command)) {
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
      !shellControl.test(command) &&
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
