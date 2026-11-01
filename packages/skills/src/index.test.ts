import { describe, expect, it } from 'vitest';
import { skillFileName } from './index.js';

describe('@wow/skills', () => {
  it('looks for SKILL.md', () => {
    expect(skillFileName).toBe('SKILL.md');
  });
});
