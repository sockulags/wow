import type { Skill, SkillSource } from '@wow/contracts';
import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { codexPolicyFile, parseCodexPolicy, parseSkillFile, skillFileName } from './parse.js';

export interface SkillRoot {
  readonly dir: string;
  readonly source: SkillSource;
  // Set for skills of a Claude plugin: Claude invokes them as /plugin:skill.
  readonly plugin?: string | undefined;
}

export interface RootContext {
  readonly userHome: string;
  // Folders of the known projects; "<project>" entries repeat for each of them.
  readonly projectDirs: readonly string[];
}

export interface ScanProblem {
  readonly file: string;
  readonly message: string;
}

export interface ScanResult {
  readonly skills: Skill[];
  readonly problems: ScanProblem[];
}

const knownSources: Record<string, SkillSource> = {
  '~/.claude/skills': 'user-claude',
  '~/.codex/skills': 'user-codex',
  '<project>/.claude/skills': 'project-claude',
  '<project>/.agents/skills': 'project-agents',
};

const normalizeEntry = (entry: string): string =>
  entry.trim().replaceAll('\\', '/').replace(/\/+$/, '');

// Turns the `skills.directories` setting into absolute folders. The default entries keep their
// source; anything else the user adds is 'custom'.
export function skillRoots(directories: readonly string[], context: RootContext): SkillRoot[] {
  const roots = new Map<string, SkillRoot>();
  for (const entry of directories) {
    const normalized = normalizeEntry(entry);
    if (normalized === '') continue;
    const source = knownSources[normalized] ?? 'custom';
    const expanded = normalized.startsWith('<project>')
      ? context.projectDirs.map((dir) => path.join(dir, normalized.slice('<project>'.length)))
      : [expandHome(normalized, context.userHome)];
    for (const dir of expanded) {
      const resolved = path.resolve(dir);
      if (!roots.has(resolved)) roots.set(resolved, { dir: resolved, source });
    }
  }
  return [...roots.values()];
}

const expandHome = (entry: string, userHome: string): string =>
  entry === '~' || entry.startsWith('~/') ? path.join(userHome, entry.slice(1)) : entry;

async function childDirectories(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(full);
    else if (entry.isSymbolicLink() && (await stat(full).catch(() => undefined))?.isDirectory()) {
      found.push(full);
    }
  }
  return found.toSorted();
}

const readOptional = (file: string): Promise<string | undefined> =>
  readFile(file, 'utf8').catch(() => undefined);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function readSkill(dir: string, root: SkillRoot): Promise<Skill | ScanProblem | undefined> {
  const file = path.join(dir, skillFileName);
  const content = await readOptional(file);
  if (content === undefined) return undefined;
  let frontmatter: ReturnType<typeof parseSkillFile>;
  try {
    frontmatter = parseSkillFile(content);
  } catch (error) {
    return { file, message: message(error) };
  }
  let allowImplicit: boolean | undefined;
  const policyFile = path.join(dir, ...codexPolicyFile);
  const policy = await readOptional(policyFile);
  if (policy !== undefined) {
    try {
      allowImplicit = parseCodexPolicy(policy);
    } catch (error) {
      return { file: policyFile, message: message(error) };
    }
  }
  const name = frontmatter.name ?? path.basename(dir);
  return {
    id: dir,
    name,
    description: frontmatter.description,
    dir,
    source: root.source,
    // Behavior 27: such skills are still offered, because the app invokes them explicitly.
    manualOnly: frontmatter.disableModelInvocation || allowImplicit === false,
    invocations: {
      claude: root.plugin ? `/${root.plugin}:${name}` : `/${name}`,
      codex: `$${name}`,
    },
  };
}

// Reads every <root>/<skill>/SKILL.md. Missing roots are skipped; files that cannot be parsed are
// reported as problems instead of failing the scan.
export async function scanSkills(roots: readonly SkillRoot[]): Promise<ScanResult> {
  const skills = new Map<string, Skill>();
  const problems: ScanProblem[] = [];
  for (const root of roots) {
    for (const dir of await childDirectories(root.dir)) {
      const result = await readSkill(dir, root);
      if (result === undefined) continue;
      if ('message' in result) problems.push(result);
      else if (!skills.has(result.id)) skills.set(result.id, result);
    }
  }
  const sorted = [...skills.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir),
  );
  return { skills: sorted, problems };
}
