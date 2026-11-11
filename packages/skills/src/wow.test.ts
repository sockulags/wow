import { builtInSkillNames, type BuiltInSkillValues } from '@wow/contracts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtInSkillsDir,
  fillBuiltInSkill,
  ownSkillDir,
  ownSkillFile,
  removeOwnSkill,
  scanSkills,
  wowSkillRoots,
  writeOwnSkill,
} from './index.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'wow-own-skills-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const noValues: BuiltInSkillValues = {
  approvedLine: 'APPROVED',
  changesRequestedLine: 'CHANGES_REQUESTED',
  blockedLine: 'BLOCKED',
  expectedArtifacts: '',
  intentId: '',
  unitKey: '',
  unitTitle: '',
  intentUnitLine: '',
};

const builtIn = async (name: string) =>
  (await scanSkills(wowSkillRoots(home))).skills.find(
    (skill) => skill.source === 'wow' && skill.name === name,
  );

describe('built-in skills (wow skills spec 1, 4)', () => {
  it('ships the four skills as files with the package, in the group wow', async () => {
    const { skills, problems } = await scanSkills(wowSkillRoots(home));
    expect(problems).toEqual([]);
    expect(skills.map((skill) => [skill.name, skill.source])).toEqual(
      builtInSkillNames.toSorted().map((name) => [name, 'wow']),
    );
    for (const skill of skills) {
      expect(path.dirname(skill.dir)).toBe(path.resolve(builtInSkillsDir));
      expect(skill.description).not.toBe('');
      expect(skill.text).not.toBe('');
    }
  });

  it('reads own skills from the skills folder under wow home', () => {
    expect(wowSkillRoots(home)).toEqual([
      { dir: path.resolve(builtInSkillsDir), source: 'wow' },
      { dir: path.resolve(home, 'skills'), source: 'yours' },
    ]);
  });
});

describe('filling a built-in text (spec 2)', () => {
  it('names the verdict lines from the settings', async () => {
    const template = (await builtIn('wow-verdict'))?.text ?? '';
    const text = fillBuiltInSkill(template, {
      ...noValues,
      approvedLine: 'SHIP IT',
      changesRequestedLine: 'FIX IT',
      blockedLine: 'STUCK',
    });
    expect(text).toContain('SHIP IT when the work is done');
    expect(text).toContain('FIX IT when it needs changes');
    expect(text).toContain('STUCK when it cannot go on');
    expect(text).not.toContain('{{');
  });

  it('names the expected artifacts, and leaves their sentence out without any', async () => {
    const template = (await builtIn('wow-artifacts'))?.text ?? '';
    const filled = fillBuiltInSkill(template, {
      ...noValues,
      expectedArtifacts: '- docs/plan.md\n- docs/notes.md',
    });
    expect(filled).toContain(
      'The expected paths (a * stands for any name):\n\n- docs/plan.md\n- docs/notes.md',
    );
    const without = fillBuiltInSkill(template, noValues);
    expect(without).not.toContain('expected paths');
    expect(without).toBe(
      'Before you end, write every artifact this step is expected to produce, each at the path it is expected at. A missing file counts as not done.',
    );
  });

  it('names the Intent-Unit line of a unit, and leaves the unit sentence out without one', async () => {
    const template = (await builtIn('wow-pull-request'))?.text ?? '';
    expect(
      fillBuiltInSkill(template, { ...noValues, intentUnitLine: 'Intent-Unit: demo/U2' }),
    ).toContain('For this run that line is:\n\nIntent-Unit: demo/U2');
    expect(fillBuiltInSkill(template, noValues)).not.toContain('For this run');
  });
});

describe('own skill files (spec 5, 6)', () => {
  const tidy = {
    name: 'tidy',
    description: 'When: imports are messy',
    text: 'Tidy the imports.\n',
  };

  it('writes one file per skill in the SKILL.md format, read back as a skill of Yours', async () => {
    const dir = ownSkillDir(home, 'tidy');
    writeOwnSkill(dir, tidy);
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(ownSkillFile(tidy));
    const { skills } = await scanSkills(wowSkillRoots(home));
    expect(skills.find((skill) => skill.source === 'yours')).toEqual({
      id: dir,
      name: 'tidy',
      description: 'When: imports are messy',
      dir,
      source: 'yours',
      manualOnly: false,
      invocations: { claude: '/tidy', codex: '$tidy' },
      text: 'Tidy the imports.',
    });
  });

  it('removes the file and leaves files the user put beside it', async () => {
    const dir = ownSkillDir(home, 'tidy');
    writeOwnSkill(dir, tidy);
    await writeFile(path.join(dir, 'notes.txt'), 'mine');
    removeOwnSkill(dir);
    expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    await rm(path.join(dir, 'notes.txt'));
    removeOwnSkill(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('reports a file added by hand with a name starting with wow- instead of listing it', async () => {
    await mkdir(path.join(home, 'skills', 'wow-mine'), { recursive: true });
    await writeFile(
      path.join(home, 'skills', 'wow-mine', 'SKILL.md'),
      '---\nname: wow-mine\n---\nHi\n',
    );
    const { skills, problems } = await scanSkills(wowSkillRoots(home));
    expect(skills.some((skill) => skill.name === 'wow-mine')).toBe(false);
    expect(problems).toEqual([
      {
        file: path.join(home, 'skills', 'wow-mine', 'SKILL.md'),
        message: 'Names starting with wow- are kept for the skills wow ships',
      },
    ]);
  });
});
