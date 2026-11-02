import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eProjectsHome as home, e2eProjectsTrackerPort } from './env';

// Owner decision F-4 against the projects copy of the e2e server: a project whose folder is an
// invented git repository gets its GitHub owner and repository from the remote, a folder without
// one says so, and publishing a backlog item for that project names its repository in the preview.

const trackers = `http://127.0.0.1:${e2eProjectsTrackerPort}`;
const folder = path.join(home, 'trackers-e2e-widgets');
const projectName = 'Widgets e2e';

const git = (...args: string[]) =>
  execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe', encoding: 'utf8' });

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
}

async function received(): Promise<Received[]> {
  return (await (await fetch(`${trackers}/requests`)).json()) as Received[];
}

test.beforeAll(async () => {
  // An invented repository: a GitHub remote, a branch and a commit that name Jira issues.
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  git('checkout', '-q', '-b', 'feature/WID-7-dark-mode');
  git(
    '-c',
    'user.name=Invented',
    '-c',
    'user.email=invented@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'WID-8 Add the toggle',
  );
});

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const projectList = (page: Page) => page.getByRole('region', { name: 'Projects' });

test('reads GitHub from the git remote and publishes there for the chosen project', async ({
  page,
}) => {
  test.slow();
  await page.goto('/settings/projects');
  await projectList(page).getByRole('button', { name: 'Add project' }).click();
  const create = page.getByRole('dialog', { name: 'New project' });
  await create.getByLabel('Folder').fill(folder);
  await create.getByLabel('Name').fill(projectName);
  await create.getByRole('button', { name: 'Add project' }).click();
  await expect(create).toBeHidden();

  // Each row says what its folder is (audit E-12): the remote, or that there is no repository.
  const row = projectList(page).getByRole('listitem', { name: projectName });
  await expect(row.getByTestId(/^project-git-/)).toContainText('origin · github.com/acme/widgets');
  await expect(row.getByTestId(/^project-git-/)).toContainText('feature/WID-7-dark-mode');
  const demo = projectList(page).getByRole('listitem', { name: 'Demo' });
  await expect(demo.getByTestId(/^project-git-/)).toHaveAttribute('data-status', 'noRepository');
  await expect(demo.getByTestId(/^project-git-/)).toContainText('No git repository');

  await row.getByRole('button', { name: 'Trackers' }).click();
  const panel = page.getByRole('region', { name: `Trackers for ${projectName}` });
  const github = panel.getByRole('region', { name: 'GitHub' });
  await expect(github.getByLabel('Owner')).toHaveValue('acme');
  await expect(github.getByLabel('Repository')).toHaveValue('widgets');
  await expect(github.getByTestId(/trackers\.github\.repo-source$/)).toHaveText('From git remote');
  // The shared GitHub token is not saved on this server yet.
  await expect(github.getByTestId(/-github-signin$/)).toContainText('No GitHub token yet');
  // The Jira key is only a suggestion from the history until confirmed.
  const jira = panel.getByRole('region', { name: 'Jira' });
  await expect(jira.getByTestId(/trackers\.jira\.projectKey-suggestion$/)).toContainText(
    'Suggested: WID',
  );
  await expect(jira.getByLabel('Project key')).toHaveValue('DEMO');
  await jira.getByRole('button', { name: 'Use WID' }).click();
  await expect(jira.getByLabel('Project key')).toHaveValue('WID');
  await expect(jira.getByTestId(/trackers\.jira\.projectKey-source$/)).toHaveText(
    'Set for this project',
  );

  // The mock GitHub stands in for github.com: this project's API URL points at it.
  await github.getByLabel('API URL').fill(`${trackers}/github`);
  await github.getByLabel('API URL').press('Enter');
  await expect(github.getByTestId(/trackers\.github\.baseUrl-source$/)).toHaveText(
    'Set for this project',
  );

  // A backlog item with no card: the dialog asks for the project first.
  await page.goto('/backlog');
  await page.getByRole('navigation', { name: 'Backlog' }).getByText('New item').click();
  const form = page.getByRole('form', { name: 'New backlog item' });
  await form.getByLabel('Title').fill('Widgets dark mode e2e');
  await form.getByLabel('Body (markdown)').fill('Follow the system theme.');
  await form.getByRole('button', { name: 'Add item' }).click();
  await expect(page).toHaveURL(/\/backlog\/[0-9a-f-]{36}$/);
  await page.getByRole('toolbar', { name: 'Item actions' }).getByText('Publish to GitHub').click();
  const dialog = page.getByRole('dialog', { name: 'Publish to GitHub' });
  await expect(dialog.getByText('Choose the project the issue is for')).toBeVisible();
  await choose(dialog.getByLabel('Project'), projectName);

  const setUp = dialog.getByRole('form', { name: 'Set up GitHub' });
  await setUp.getByLabel('GitHub token').fill('github-widgets-token');
  await setUp.getByRole('button', { name: 'Set up GitHub' }).click();
  await expect(dialog.getByTestId('preview-target')).toHaveText('acme/widgets');
  await expect(dialog.getByTestId('preview-target-source')).toHaveText('From git remote');
  await expect(dialog.getByTestId('preview-summary')).toContainText(
    `Publishes to acme/widgets on 127.0.0.1:${e2eProjectsTrackerPort} for ${projectName}`,
  );

  const before = (await received()).length;
  await dialog.getByRole('button', { name: 'Publish issue' }).click();
  await expect(dialog.getByTestId('publish-created')).toContainText(/Created acme\/widgets#\d+/);
  const [sent] = (await received()).slice(before);
  expect(sent).toMatchObject({
    path: '/github/repos/acme/widgets/issues',
    authorization: 'Bearer github-widgets-token',
  });
});
