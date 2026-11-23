import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanWorkflows, workflowRoots } from './workflows.js';

// Workflow files (orchestrator threads spec 19): every `*.md` in wow's own folder and in a
// project's `.wow/workflows` is listed as a workflow. All invented.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow workflows '));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanWorkflows', () => {
  it('lists each workflow file with its name, description and whole text, and skips a missing folder', async () => {
    const home = path.join(root, 'wow home');
    const project = path.join(root, 'tea');
    await mkdir(path.join(home, 'workflows'), { recursive: true });
    await mkdir(path.join(project, '.wow', 'workflows'), { recursive: true });
    const release =
      '---\nname: release\ndescription: Ship the tea timer\n---\n\n## Build\n\ngate: after\n';
    await writeFile(path.join(home, 'workflows', 'release.md'), release);
    await writeFile(path.join(home, 'workflows', 'notes.txt'), 'Not a workflow');
    await writeFile(path.join(project, '.wow', 'workflows', 'Review the bell.md'), '## Review\n');
    const { skills, problems } = await scanWorkflows(
      workflowRoots(home, [project, path.join(root, 'missing')]),
    );
    expect(problems).toEqual([]);
    expect(skills).toEqual([
      expect.objectContaining({
        id: path.join(home, 'workflows', 'release.md'),
        name: 'release',
        description: 'Ship the tea timer',
        source: 'workflow',
        manualOnly: true,
        text: release.trim(),
      }),
      expect.objectContaining({
        name: 'Review the bell',
        description: '',
        source: 'project-workflow',
        dir: path.resolve(project, '.wow', 'workflows'),
        text: '## Review',
      }),
    ]);
  });

  it('reports a file whose front matter cannot be read instead of failing', async () => {
    const home = path.join(root, 'wow home');
    await mkdir(path.join(home, 'workflows'), { recursive: true });
    await writeFile(path.join(home, 'workflows', 'broken.md'), '---\nname: [\n---\n\n## Step\n');
    const { skills, problems } = await scanWorkflows(workflowRoots(home, []));
    expect(skills).toEqual([]);
    expect(problems).toEqual([
      expect.objectContaining({ file: path.join(home, 'workflows', 'broken.md') }),
    ]);
  });
});
