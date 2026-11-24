import type { Skill } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { skillRefOf } from './model';
import { skillsForProject } from './view-model';

// Workflows in the composer's `/` list (orchestrator threads spec 19, 20). All invented.

const skill = (name: string, source: Skill['source'], dir: string): Skill => ({
  id: `${dir}/${name}.md`,
  name,
  description: '',
  dir,
  source,
  manualOnly: true,
  invocations: { claude: `/${name}`, codex: `$${name}` },
  text: `## ${name}`,
});

const mine = skill('release', 'workflow', '/home/ada/.wow/workflows');
const tea = skill('release', 'project-workflow', '/home/ada/tea/.wow/workflows');
const kettle = skill('brew', 'project-workflow', '/home/ada/kettle/.wow/workflows');
const review = skill('review', 'workflow', '/home/ada/.wow/workflows');
const folderSkill = skill('plan-work', 'user-claude', '/home/ada/.claude/skills/plan-work');

describe('skillsForProject', () => {
  it("offers a project's own workflow in place of yours of the same name, and no other project's", () => {
    expect(skillsForProject([mine, tea, kettle, review, folderSkill], '/home/ada/tea')).toEqual([
      tea,
      review,
      folderSkill,
    ]);
  });

  it('offers only your own workflows outside a project', () => {
    expect(skillsForProject([mine, tea, kettle, review, folderSkill], undefined)).toEqual([
      mine,
      review,
      folderSkill,
    ]);
  });

  it('matches the project folder whichever slashes it has', () => {
    const windows = skill(
      'release',
      'project-workflow',
      String.raw`C:\Users\ada\tea\.wow\workflows`,
    );
    expect(skillsForProject([mine, windows], 'C:\\Users\\ada\\tea\\')).toEqual([windows]);
  });
});

describe('skillRefOf', () => {
  it('names a workflow by its source, so the server sends it as a workflow', () => {
    expect(skillRefOf(mine)).toEqual({ name: 'release', source: 'workflow' });
    expect(skillRefOf(tea)).toEqual({ name: 'release', source: 'project-workflow' });
  });
});
