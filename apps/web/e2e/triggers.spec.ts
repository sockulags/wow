import { expect, test, type Page } from '@playwright/test';
import type { Command, MissedTriggerPolicy } from '@wow/contracts';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  e2eProjectId,
  e2eProviderInstanceId,
  e2eTriggersHome,
  e2eTriggersOutlookControlPort,
  e2eTriggersPort,
  e2eTriggersTrackerPort,
} from './env';

// U11 ground truth against the scripted mock provider: a trigger set a few seconds ahead fires
// into a run that stops at its gate, and server restarts with the clock moved past a trigger's
// time exercise each missed-trigger policy (behaviors 6, 8, 9, 12, 13). This file owns its server,
// because it stops and starts it.

test.describe.configure({ mode: 'serial' });

interface ServerInfo {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
}

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflowId = 'e2e-trigger-workflow';
let child: ChildProcess | undefined;
let info: ServerInfo;
// How far the server's clock runs ahead of the real one; each restart moves it on.
let offsetSeconds = 0;
let commandCount = 0;

async function startWowServer(fresh: boolean): Promise<void> {
  const started = spawn(process.execPath, ['--import', 'tsx', 'e2e/server.ts'], {
    cwd: webDir,
    env: {
      ...process.env,
      WOW_E2E_HOME: e2eTriggersHome,
      WOW_E2E_PORT: String(e2eTriggersPort),
      WOW_E2E_OUTLOOK_CONTROL_PORT: String(e2eTriggersOutlookControlPort),
      WOW_E2E_TRACKER_PORT: String(e2eTriggersTrackerPort),
      WOW_E2E_KEEP_HOME: fresh ? '0' : '1',
      WOW_E2E_CLOCK_OFFSET_SECONDS: String(offsetSeconds),
      WOW_OUTLOOK: 'mock',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child = started;
  const exited = once(started, 'exit').then(([code]) => {
    throw new Error(`The wow server exited with ${String(code)} before it was ready`);
  });
  const lines = createInterface({ input: started.stdout });
  const ready = (async () => {
    for await (const line of lines) if (line === 'wow e2e server ready') return;
  })();
  await Promise.race([ready, exited]);
  exited.catch(() => undefined);
  info = JSON.parse(
    await readFile(path.join(e2eTriggersHome, 'server.json'), 'utf8'),
  ) as ServerInfo;
}

async function stopWowServer(): Promise<void> {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null) return;
  const exited = once(running, 'exit');
  running.kill('SIGTERM');
  await exited;
}

async function restart(secondsLater: number): Promise<void> {
  await stopWowServer();
  offsetSeconds += secondsLater;
  await startWowServer(false);
}

// One request over the server's WebSocket.
async function request(method: string, params: unknown): Promise<unknown> {
  const socket = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const answer = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
    socket.addEventListener(
      'message',
      (event) => resolve(JSON.parse(String(event.data)) as { result?: unknown }),
      { once: true },
    ),
  );
  socket.send(JSON.stringify({ id: '1', method, params }));
  const response = await answer;
  socket.close();
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

const dispatch = (command: Command) =>
  request('dispatch', { commandId: `e2e-triggers-${(commandCount += 1)}`, command });

const setSetting = (key: string, value: unknown) =>
  dispatch({ type: 'setting.set', key, scope: 'global', value });

const serverNow = () => Date.now() + offsetSeconds * 1000;

// A card whose trigger is `secondsAhead` from the server's clock.
async function createCard(title: string, secondsAhead: number): Promise<Date> {
  const start = new Date(serverNow() + secondsAhead * 1000);
  await dispatch({
    type: 'card.create',
    cardId: `card-${title.toLowerCase().replaceAll(' ', '-')}`,
    title,
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    projectId: e2eProjectId,
    workflowId,
  });
  return start;
}

// What the desktop preload injects: the running server's `server.json`. A later script wins, so
// after a restart the page is pointed at the new token.
const useServer = (page: Page) =>
  page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);

// The day view that shows the card.
async function openDay(page: Page, start: Date): Promise<void> {
  await useServer(page);
  await page.goto(`/calendar?view=day&date=${start.toLocaleDateString('sv-SE')}`);
}

const cardBlock = (page: Page, title: string) =>
  page.getByRole('button', { name: new RegExp(`^${title}, `) });

test.beforeAll(async () => {
  await startWowServer(true);
  await setSetting('scheduler.tickSeconds', 1);
  await dispatch({
    type: 'workflow.create',
    workflowId,
    name: 'Bug e2e',
    steps: [
      {
        id: 'deliver',
        skillName: 'deliver-work',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'high',
        permissionMode: 'default',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: [],
      },
    ],
  });
});

test.afterAll(async () => {
  await stopWowServer();
});

test.describe('triggers', () => {
  test('a trigger a few seconds ahead starts the run and the card waits for you', async ({
    page,
  }) => {
    const start = await createCard('Fix login', 3);
    await openDay(page, start);
    const card = cardBlock(page, 'Fix login');
    await expect(card.getByTestId('card-state')).toHaveText('scheduled');

    // The mock provider finishes step 1 at once, so the run goes straight to its gate.
    await expect(card.getByTestId('card-state')).toHaveText('waiting', { timeout: 15_000 });
    await expect(
      page.getByRole('list', { name: 'Notifications' }).getByText('Waiting for you'),
    ).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Chat' })
      .click();
    await expect(
      page.getByRole('region', { name: 'Needs you' }).getByText('Bug e2e: deliver-work'),
    ).toBeVisible();

    // Deleting the card asks whether to stop the run; the thread stays.
    await page.goBack();
    await cardBlock(page, 'Fix login').click();
    const dialog = page.getByRole('dialog', { name: 'Edit card' });
    await expect(dialog.getByText('Workflow run waiting for you.')).toBeVisible();
    const runHref = await dialog.getByRole('link', { name: 'Open run' }).getAttribute('href');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await dialog
      .getByRole('alertdialog', { name: 'Stop the run?' })
      .getByRole('button', { name: 'Stop run and delete' })
      .click();
    await expect(cardBlock(page, 'Fix login')).toHaveCount(0);
    await page.goto(runHref ?? '/workflows');
    await expect(page.getByTestId('run-state')).toHaveText('Stopped');
    await expect(page.getByRole('link', { name: 'Open thread' })).toBeVisible();
  });

  const policies: readonly [MissedTriggerPolicy, string][] = [
    ['run', 'Missed run'],
    ['mark', 'Missed mark'],
    ['skip', 'Missed skip'],
  ];
  for (const [policy, title] of policies) {
    test(`a restart after the trigger's time applies the "${policy}" policy`, async ({ page }) => {
      await setSetting('scheduler.missedPolicy', policy);
      const start = await createCard(title, 120);
      await restart(600);
      await openDay(page, start);
      const card = cardBlock(page, title);
      const runNow = card.getByRole('button', { name: `Run now: ${title}` });
      if (policy === 'run') {
        await expect(card.getByTestId('card-state')).toHaveText('waiting');
        await expect(runNow).toHaveCount(0);
      } else if (policy === 'mark') {
        await expect(card.getByTestId('card-state')).toHaveText('missed');
        await runNow.click();
        await expect(card.getByTestId('card-state')).toHaveText('waiting');
      } else {
        await expect(card.getByTestId('card-state')).toHaveText('missed');
        await expect(runNow).toHaveCount(0);
      }
    });
  }

  test('moving a card with a workflow moves its trigger', async ({ page }) => {
    await setSetting('scheduler.missedPolicy', 'mark');
    const start = await createCard('Moved card', 120);
    await openDay(page, start);
    await cardBlock(page, 'Moved card').click();
    const dialog = page.getByRole('dialog', { name: 'Edit card' });
    const nextDay = new Date(start.getTime() + 24 * 60 * 60_000).toLocaleDateString('sv-SE');
    await dialog.getByLabel('Date').fill(nextDay);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(cardBlock(page, 'Moved card')).toHaveCount(0);

    // The old time passes while the server is down; the trigger went with the card, so nothing
    // is missed.
    await restart(600);
    await useServer(page);
    await page.goto(`/calendar?view=day&date=${nextDay}`);
    const card = cardBlock(page, 'Moved card');
    await expect(card.getByTestId('card-state')).toHaveText('scheduled');
    await expect(card.getByRole('button', { name: 'Run now: Moved card' })).toHaveCount(0);
  });

  test('a paused scheduler holds a due trigger until it is resumed', async ({ page }) => {
    await setSetting('scheduler.missedPolicy', 'mark');
    const start = await createCard('Paused card', 120);
    await openDay(page, start);
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('Pause scheduler');
    await page.keyboard.press('Enter');
    const paused = page.getByRole('button', { name: 'Scheduler paused' });
    await expect(paused).toBeVisible();

    await restart(600);
    await useServer(page);
    await page.reload();
    const card = cardBlock(page, 'Paused card');
    await expect(card.getByTestId('card-state')).toHaveText('scheduled');
    await page.getByRole('button', { name: 'Scheduler paused' }).click();
    await expect(card.getByTestId('card-state')).toHaveText('missed');
    await expect(card.getByRole('button', { name: 'Run now: Paused card' })).toBeVisible();
  });
});
