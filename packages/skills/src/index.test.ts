import { defaultSkillDirectories } from '@wow/contracts';
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claudePluginRoots,
  parseCodexPolicy,
  parseSkillFile,
  scanSkills,
  skillRoots,
  watchSkillRoots,
  type WatchFactory,
} from './index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

// The fixture tree stores `.claude`, `.codex` and `.agents` as `dot-claude` and so on, so agents
// working in this repository do not pick the invented skills up as their own. Each test run
// copies it to a temporary folder and restores the dots.
async function restoreDots(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let full = path.join(dir, entry.name);
    if (entry.name.startsWith('dot-')) {
      const renamed = path.join(dir, `.${entry.name.slice('dot-'.length)}`);
      await rename(full, renamed);
      full = renamed;
    }
    await restoreDots(full);
  }
}

let root: string;
let home: string;
let project: string;

const inFixture = (...parts: string[]) => path.join(root, ...parts);
const ignoreChange = (): void => undefined;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-skills-'));
  await cp(fixtures, root, { recursive: true });
  await restoreDots(root);
  home = path.join(root, 'home');
  project = path.join(root, 'project');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skill roots', () => {
  it('expands the default directories with their sources', () => {
    const roots = skillRoots(defaultSkillDirectories, {
      userHome: '/u',
      projectDirs: ['/w/a', '/w/b'],
    });
    expect(roots).toEqual([
      { dir: path.resolve('/u/.claude/skills'), source: 'user-claude' },
      { dir: path.resolve('/u/.codex/skills'), source: 'user-codex' },
      { dir: path.resolve('/w/a/.claude/skills'), source: 'project-claude' },
      { dir: path.resolve('/w/b/.claude/skills'), source: 'project-claude' },
      { dir: path.resolve('/w/a/.agents/skills'), source: 'project-agents' },
      { dir: path.resolve('/w/b/.agents/skills'), source: 'project-agents' },
    ]);
  });

  it('marks other folders custom, accepts backslashes and drops duplicates', () => {
    const roots = skillRoots(['~\\.claude\\skills\\', '/opt/skills', '/opt/skills', '  '], {
      userHome: '/u',
      projectDirs: [],
    });
    expect(roots).toEqual([
      { dir: path.resolve('/u/.claude/skills'), source: 'user-claude' },
      { dir: path.resolve('/opt/skills'), source: 'custom' },
    ]);
  });

  it('has no project folders without projects', () => {
    expect(skillRoots(['<project>/.agents/skills'], { userHome: '/u', projectDirs: [] })).toEqual(
      [],
    );
  });
});

describe('scanning the fixture tree', () => {
  it('finds every SKILL.md with its invocations and manual-only flag', async () => {
    const roots = skillRoots(defaultSkillDirectories, { userHome: home, projectDirs: [project] });
    const { skills, problems } = await scanSkills(roots);

    expect(skills).toEqual([
      {
        id: inFixture('home', '.claude', 'skills', 'capture-intent'),
        name: 'capture-intent',
        description: 'Turn a rough idea into an intent and a spec.',
        dir: inFixture('home', '.claude', 'skills', 'capture-intent'),
        source: 'user-claude',
        manualOnly: false,
        invocations: { claude: '/capture-intent', codex: '$capture-intent' },
      },
      {
        id: inFixture('home', '.codex', 'skills', 'lint'),
        name: 'lint',
        description: 'Run the linters.',
        dir: inFixture('home', '.codex', 'skills', 'lint'),
        source: 'user-codex',
        manualOnly: false,
        invocations: { claude: '/lint', codex: '$lint' },
      },
      {
        // agents/openai.yaml with allow_implicit_invocation: false.
        id: inFixture('home', '.codex', 'skills', 'review'),
        name: 'review',
        description: 'Review a change: correctness first.',
        dir: inFixture('home', '.codex', 'skills', 'review'),
        source: 'user-codex',
        manualOnly: true,
        invocations: { claude: '/review', codex: '$review' },
      },
      {
        id: inFixture('project', '.agents', 'skills', 'shape-work'),
        name: 'shape-work',
        description: '',
        dir: inFixture('project', '.agents', 'skills', 'shape-work'),
        source: 'project-agents',
        manualOnly: false,
        invocations: { claude: '/shape-work', codex: '$shape-work' },
      },
      {
        // disable-model-invocation: true is still offered, marked manual only.
        id: inFixture('home', '.claude', 'skills', 'ship'),
        name: 'ship',
        description: 'Publish a release. Only when asked.',
        dir: inFixture('home', '.claude', 'skills', 'ship'),
        source: 'user-claude',
        manualOnly: true,
        invocations: { claude: '/ship', codex: '$ship' },
      },
    ]);
    expect(problems).toEqual([
      {
        file: inFixture('project', '.claude', 'skills', 'broken', 'SKILL.md'),
        message: expect.any(String),
      },
    ]);
  });

  it('skips folders that do not exist', async () => {
    expect(await scanSkills([{ dir: path.join(root, 'missing'), source: 'custom' }])).toEqual({
      skills: [],
      problems: [],
    });
  });
});

describe('Claude plugin skills', () => {
  it('takes the newest cached version and the plugin name from its manifest', async () => {
    const roots = await claudePluginRoots(path.join(home, '.claude'));
    expect(roots).toEqual([
      {
        dir: path.join(
          home,
          '.claude',
          'plugins',
          'cache',
          'agent-os',
          'agent-os-dev',
          '1.10.0',
          'skills',
        ),
        source: 'user-claude',
        plugin: 'agent-os-dev',
      },
    ]);
    const { skills } = await scanSkills(roots);
    expect(skills.map((skill) => [skill.name, skill.description, skill.invocations])).toEqual([
      [
        'deliver-work',
        'Deliver one unit of work.',
        { claude: '/agent-os-dev:deliver-work', codex: '$deliver-work' },
      ],
    ]);
  });

  it('follows installed_plugins.json when it exists', async () => {
    const claudeDir = path.join(root, 'installed', '.claude');
    const install = path.join(root, 'installed', 'elsewhere', 'tools');
    await mkdir(path.join(claudeDir, 'plugins'), { recursive: true });
    await mkdir(path.join(install, 'skills', 'tidy'), { recursive: true });
    await writeFile(path.join(install, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\n---\n');
    await writeFile(
      path.join(claudeDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'tools@market': [{ scope: 'user', installPath: install, version: '1.0.0' }] },
      }),
    );
    const roots = await claudePluginRoots(claudeDir);
    expect(roots).toEqual([
      { dir: path.join(install, 'skills'), source: 'user-claude', plugin: 'tools' },
    ]);
    const { skills } = await scanSkills(roots);
    expect(skills[0]?.invocations.claude).toBe('/tools:tidy');
  });

  it('finds nothing without a plugins folder', async () => {
    expect(await claudePluginRoots(path.join(root, 'nowhere'))).toEqual([]);
  });
});

describe('parsing', () => {
  it('reads frontmatter with a byte order mark and Windows line endings', () => {
    expect(
      parseSkillFile(
        '﻿---\r\nname: x\r\ndescription: y\r\ndisable-model-invocation: true\r\n---\r\nbody',
      ),
    ).toEqual({ name: 'x', description: 'y', disableModelInvocation: true });
  });

  it('treats a file without frontmatter as unnamed', () => {
    expect(parseSkillFile('# Title')).toEqual({
      name: undefined,
      description: '',
      disableModelInvocation: false,
    });
  });

  it('reads the Codex implicit invocation policy', () => {
    expect(parseCodexPolicy('policy:\n  allow_implicit_invocation: false\n')).toBe(false);
    expect(parseCodexPolicy('interface: {}\n')).toBeUndefined();
  });
});

describe('watching', () => {
  it('watches every root and reports changes', () => {
    const changes: string[] = [];
    let watched: readonly string[] = [];
    let trigger: () => void = ignoreChange;
    let closed = false;
    const factory: WatchFactory = (dirs, onChange) => {
      watched = dirs;
      trigger = onChange;
      return {
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      };
    };
    const watcher = watchSkillRoots(
      [
        { dir: '/a', source: 'custom' },
        { dir: '/b', source: 'custom' },
      ],
      () => changes.push('changed'),
      factory,
    );
    trigger();
    void watcher.close();
    expect(watched).toEqual(['/a', '/b']);
    expect(changes).toEqual(['changed']);
    expect(closed).toBe(true);
  });
});
