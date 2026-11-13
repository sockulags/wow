import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { branchIdOf, branchName, sameBranchName, sha256Hex, titleSlug } from './branch-name.js';

const template = 'wow/{{title}}-{{id}}';

// Git itself is the judge of a branch name (`git check-ref-format --branch`); it needs no
// repository for that.
const gitTakes = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

describe('sha256Hex', () => {
  it('agrees with Node for empty, short, multi-block and non-ASCII text', () => {
    for (const text of ['', 'abc', 'thread-1', 'x'.repeat(55), 'y'.repeat(64), 'ü€😀'.repeat(40)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });
});

describe('branchName (thread work spec 11, Interface)', () => {
  it('fills the title as a slug of at most 32 characters and six hex of the id', () => {
    const id = createHash('sha256').update('t-1').digest('hex').slice(0, 6);
    expect(branchName(template, 'Ring the bell twice!', 't-1')).toBe(
      `wow/ring-the-bell-twice-${id}`,
    );
    expect(titleSlug('Écrire une très longue phrase pour le thé du matin')).toBe(
      'ecrire-une-tres-longue-phrase-po',
    );
    expect(branchIdOf('t-1')).toBe(id);
  });

  it('leaves no dangling dash without a title and falls back when nothing is left', () => {
    expect(branchName(template, '', 't-1')).toBe(`wow/${branchIdOf('t-1')}`);
    expect(branchName('///', 'x', 't-1')).toBe(`wow/${branchIdOf('t-1')}`);
    expect(branchName('@', '', 't-1')).toBe(`wow/${branchIdOf('t-1')}`);
  });

  it('makes every template and title one Git takes as a branch', () => {
    const templates = [
      template,
      'feature/{{title}}',
      '-{{title}}.lock',
      '.hidden/{{title}}..{{id}}',
      'a b~c^d:e?f*g[h\\i/{{id}}',
      'x/@{y}/{{id}}.',
      'deep//nested/./{{title}}/',
      'wow/{{title}}.lock.lock',
      'ctl\u0001/{{id}}',
    ];
    const titles = ['Ring the bell', '..', '-start', 'Tab\there', 'Ünïcödé ✓', ''];
    const names = templates.flatMap((each) =>
      titles.map((title) => branchName(each, title, 'thread-x')),
    );
    expect(names.filter((name) => !gitTakes(name))).toEqual([]);
  });

  it('gives threads names that differ in more than case', () => {
    const names = Array.from({ length: 200 }, (_, index) =>
      branchName(template, 'Same title', `thread-${index}`),
    );
    const folded = new Set(names.map((name) => name.toLowerCase()));
    expect(folded.size).toBe(names.length);
    expect(sameBranchName('wow/Bell-1a2b3c', 'wow/bell-1A2B3C')).toBe(true);
    expect(sameBranchName('wow/bell-1a2b3c', 'wow/bell-1a2b3d')).toBe(false);
    expect(branchName(template, 'Same', 'thread-0', 10)).toMatch(/-[0-9a-f]{10}$/);
  });
});
