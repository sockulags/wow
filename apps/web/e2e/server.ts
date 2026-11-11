import type {
  CalendarItem,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
  ProviderTestResult,
} from '@wow/contracts';
import { replyText } from '@wow/contracts';
import { MockOutlookSource, loadFixtures } from '@wow/outlook-bridge';
import {
  MockConfluence,
  MockGitHub,
  MockGitLab,
  MockJira,
  MockProviderAdapter,
  createNpmRunner,
  snapshot,
  startOutlookService,
  startServer,
  type MockScript,
} from '@wow/server';
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  e2eAssistantBrokenWorkflowId,
  e2eAssistantGateWorkflowId,
  e2eAssistantHome,
  e2eCodexBareId,
  e2eCodexWithDefaultId,
  e2eOldWorkflowId,
  e2eFirstStartCodexError,
  e2eFirstStartHome,
  e2eBinDir,
  e2eBinary,
  e2eChangesHome,
  e2eChangesProjectId,
  e2eChangesWorkflowId,
  e2eCopyProjectId,
  e2eCopyWorkflowId,
  e2eGateProjectId,
  e2eConditionWorkflowId,
  e2eGateWorkflowId,
  e2ePlanningWorkflowId,
  e2eLimitWorkflowId,
  e2eRulesWorkflowId,
  e2eHostileSkillName,
  e2eClaudeConfigDir,
  e2eCodexHome,
  e2eCodexInstanceId,
  e2eHome,
  e2eEventBranch,
  e2eEventIntentId,
  e2eEventProjectId,
  e2eEventWorkflowId,
  e2eGitLabBranch,
  e2eGitLabIntentId,
  e2eGitLabProjectId,
  e2eGitLabProjectPath,
  e2eHostBranch,
  e2eHostIntentId,
  e2eHostProjectId,
  e2eHostWorkflowId,
  e2eTicketBacklogItemId,
  e2eTicketKey,
  e2ePagesBacklogItemId,
  e2ePagesTicketKey,
  e2ePlanRunIntentId,
  e2ePlanRunProjectId,
  e2ePlanRunWorkflowId,
  e2eOutlookControlPort,
  e2ePanelCardId,
  e2ePanelHome,
  e2ePanelWorkflowId,
  e2ePort,
  e2eProjectId,
  e2eProjectsHome,
  e2eProviderInstanceId,
  e2eTrackerPort,
  e2eViewerWorkflowId,
  e2eWorkflowId,
  e2eWorkspace,
} from './env';
import { AssistantMockAgent } from './assistant-agent';
import { e2eIntentMd, e2ePlanMd, e2ePlansDirectory, e2eSpecMd, seedPlanFiles } from './plans-seed';

// WOW_E2E_HOME and WOW_E2E_PORT start a second copy for the settings tests (playwright.config.ts).
const home = process.env['WOW_E2E_HOME'] ?? e2eHome;
const port = Number(process.env['WOW_E2E_PORT'] ?? e2ePort);
const outlookControlPort = Number(
  process.env['WOW_E2E_OUTLOOK_CONTROL_PORT'] ?? e2eOutlookControlPort,
);
const trackerPort = Number(process.env['WOW_E2E_TRACKER_PORT'] ?? e2eTrackerPort);
// The trigger tests restart the server on the same home (WOW_E2E_KEEP_HOME) with its clock moved
// ahead (WOW_E2E_CLOCK_OFFSET_SECONDS), so a trigger's time passes while it is down without
// the test waiting for it.
const keepHome = process.env['WOW_E2E_KEEP_HOME'] === '1';
const clockOffsetMs = Number(process.env['WOW_E2E_CLOCK_OFFSET_SECONDS'] ?? '0') * 1000;
// The first-start copy is seeded with nothing a user would have set up (e2e/env.ts).
const firstStart = home === e2eFirstStartHome;

// Starts the wow server for the chat tests with a scripted mock provider. The prompt picks the
// scenario: "approve" asks for an approval, "question" asks a question, "wait" streams a little
// and then waits for stop; "table and a diagram" answers in markdown; "reaches out" answers with
// diagrams that name another host; anything else streams an answer with reasoning, tasks and
// usage.
// Approval and question ids carry the thread id, because the answer only carries the id.

const separator = '|';

const words = (text: string) => text.split(/(?<= )/);

function finish(threadId: string, text: string, prefix = 'reply'): ProviderEvent[] {
  return [
    ...words(text).map((delta): ProviderEvent => ({
      type: 'textDelta',
      threadId,
      itemId: prefix,
      delta,
    })),
    {
      type: 'usage',
      threadId,
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 800,
      costUsd: 0.0123,
    },
    { type: 'contextUsage', threadId, usedTokens: 50_000, maxTokens: 200_000 },
    { type: 'turnCompleted', threadId },
  ];
}

// An invented answer with every kind of markdown the chat renders (review loop spec 1, 2).
const markdownAnswer = [
  '## Review of the login change',
  '',
  'The change touches `login.ts` and is **ready**:',
  '',
  '- Checks',
  '  - unit tests pass',
  '  - lint is clean',
  '- One open question',
  '',
  '| File | Added | Removed |',
  '| --- | ---: | ---: |',
  '| src/login.ts | 12 | 3 |',
  '| src/login.test.ts | 40 | 0 |',
  '',
  'Read more in [the guide](https://docs.example.test/login) or [here](javascript:alert(1)).',
  '',
  'Questions go to [the team](mailto:team@example.test).',
  '',
  '```ts',
  'export const retries = 3;',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  Plan --> Build',
  '  Build --> Review',
  '  Review -->|send back| Build',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  Plan -->',
  '```',
].join('\n');

// Invented diagrams that try to make the app fetch from another host: a picture in a label, a
// link, an image shape, a state diagram's class with a background, and CSS from a directive.
const reachingAnswer = [
  '```mermaid',
  'flowchart LR',
  '  Plan["Plan <img src=https://elsewhere.example.test/label.png>"] --> Build',
  '  click Build href "https://elsewhere.example.test/build"',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  Logo@{ img: "https://elsewhere.example.test/shape.png", label: "Logo" } --> Build',
  '```',
  '',
  '```mermaid',
  'stateDiagram-v2',
  '  classDef reaching background-image:url(https://elsewhere.example.test/state.png)',
  '  [*] --> Waiting',
  '  class Waiting reaching',
  '```',
  '',
  '```mermaid',
  '%%{init: {"themeCSS": ".node rect{fill:url(https://elsewhere.example.test/css.png)}"}}%%',
  'flowchart LR',
  '  Plan --> Build',
  '```',
].join('\n');

// The Changes tab tests (review loop spec 11, 12): an invented tea timer project in a Git
// repository of its own, and a mock agent that edits it the way a build step and a review step
// would. Git runs here only to set the scene; the server under test reads the result.
const changesRepo = path.join(home, 'tea-timer');
// The gate tests (review loop spec 14 to 16) get a copy of their own, so a run of theirs does not
// reseed the folder the Changes tests are reading.
const gateRepo = path.join(home, 'tea-kettle');
const teaRepos = new Set([changesRepo, gateRepo]);
// The working copy tests (review loop spec 36, 37): the agent must find itself in a working copy
// under the server's own `workspaces` folder, never in this repository.
const copyRepo = path.join(home, 'tea-cup');
const inTeaRepo = (cwd: string) =>
  teaRepos.has(cwd) || path.dirname(cwd) === path.join(home, 'workspaces');
// The host tests (review loop spec 23, 28, 31) read a third copy; nothing edits it.
const hostRepo = path.join(home, 'tea-garden');
const gardenUnits = `## Units

- [U1] Plant the tea
- [U2] Water the beds -- depends on U1
- [U3] Pick the leaves -- depends on U1
- [U4] Dry the leaves -- depends on U2
- [U5] Sell the tea -- blocked: the stall is not built

${['U1', 'U2', 'U3', 'U4', 'U5'].map((key) => `### ${key} Invented\n\nOutcome: invented for the tests.\n`).join('\n')}`;
// The event trigger tests (review loop spec 48) follow this plan's one pull request.
const leafRepo = path.join(home, 'tea-leaf');
const leafUnits = `## Units

- [U1] Pick the leaves

### U1 Invented

Outcome: invented for the tests.
`;
// The GitLab tests (review loop spec 34) read this plan's merge requests from the mock GitLab.
const fieldRepo = path.join(home, 'tea-field');
const fieldUnits = `## Units

- [U1] Plough the field
- [U2] Weed the rows -- depends on U1
- [U3] Plant the bushes -- depends on U1
- [U4] Harvest -- depends on U2

${['U1', 'U2', 'U3', 'U4'].map((key) => `### ${key} Invented\n\nOutcome: invented for the tests.\n`).join('\n')}`;
// The plan run tests (review loop spec 40, 41) run a workflow over the units of this plan.
const potRepo = path.join(home, 'tea-pot');
const potUnits = `## Units

- [U1] Shape the pot
- [U2] Glaze the pot -- depends on U1
- [U3] Fire the kiln

${['U1', 'U2', 'U3'].map((key) => `### ${key} Invented\n\nOutcome: invented for the tests.\n`).join('\n')}`;
const git = (repo: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Invented Agent',
      '-c',
      'user.email=agent@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { stdio: 'pipe' },
  );
const inRepo = (repo: string, relative: string) => path.join(repo, ...relative.split('/'));
function writeInRepo(repo: string, relative: string, content: string | Uint8Array): void {
  mkdirSync(path.dirname(inRepo(repo, relative)), { recursive: true });
  writeFileSync(inRepo(repo, relative), content);
}
const timerSource = (ring: string) =>
  [
    "import { ring } from './bell';",
    '',
    'export function startTimer(minutes: number): void {',
    '  const ms = minutes * 60_000;',
    `  setTimeout(() => ${ring}, ms);`,
    '}',
    '',
  ].join('\n');
const guide = Array.from(
  { length: 12 },
  (_, index) => `${index + 1}. Invented step ${index + 1} of making tea.`,
).join('\n');

function seedTeaRepo(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeInRepo(repo, '.gitignore', '*.log\n');
  writeInRepo(repo, 'README.md', '# Tea timer\n\nRings when the tea is ready.\n');
  writeInRepo(repo, 'src/timer.ts', timerSource('ring()'));
  writeInRepo(repo, 'src/bell.ts', "export const ring = (): void => console.log('ding');\n");
  writeInRepo(repo, 'src/legacy.ts', 'export const oldRing = (): void => undefined;\n');
  writeInRepo(repo, 'docs/howto.md', `# How to\n\n${guide}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Invented tea timer');
}

// A working copy shares its repository's settings, so its files get the line endings written
// here whatever this machine's git is set to.
function seedCopyRepo(): void {
  seedTeaRepo(copyRepo);
  git(copyRepo, 'config', 'core.autocrlf', 'false');
}

// The build step: one committed change, then uncommitted ones of every kind the tab lists.
function buildTeaTimer(repo: string): void {
  writeInRepo(repo, 'README.md', '# Tea timer\n\nRings twice when the tea is ready.\n');
  git(repo, 'commit', '-q', '-am', 'Say that it rings twice');
  writeInRepo(
    repo,
    'src/timer.ts',
    timerSource('ringTwice()').replace('{ ring }', '{ ringTwice }'),
  );
  writeInRepo(
    repo,
    'src/bell.ts',
    [
      "export const ring = (): void => console.log('ding');",
      'export const ringTwice = (): void => {',
      '  ring();',
      '  ring();',
      '};',
      '',
    ].join('\n'),
  );
  git(repo, 'mv', 'docs/howto.md', 'docs/guide.md');
  rmSync(inRepo(repo, 'src/legacy.ts'));
  writeInRepo(repo, 'src/chime.ts', "export const chime = 'soft';\n");
  writeInRepo(
    repo,
    'assets/chime.bin',
    Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3, 0xff, 0]),
  );
  writeInRepo(repo, 'build.log', 'ignored by git\n');
}

// The review step: its notes, and one fix to a file the build step left.
function reviewTeaTimer(repo: string): void {
  writeInRepo(
    repo,
    'review/notes.md',
    '# Review\n\n- The timer rings twice.\n- The chime was renamed for clarity.\n',
  );
  renameSync(inRepo(repo, 'src/chime.ts'), inRepo(repo, 'src/soft-chime.ts'));
}

// A step sent back at its gate (review loop spec 16): the second attempt names the kettle in a
// new document and in the bell.
function reworkTeaTimer(repo: string): void {
  writeInRepo(repo, 'docs/kettle.md', '# Kettle\n\nThe timer starts when the kettle clicks off.\n');
  writeInRepo(
    repo,
    'src/bell.ts',
    [
      "export const ring = (): void => console.log('ding, the kettle is done');",
      'export const ringTwice = (): void => {',
      '  ring();',
      '  ring();',
      '};',
      '',
    ].join('\n'),
  );
}

function startTurn(command: Extract<ProviderCommand, { type: 'startTurn' }>): ProviderEvent[] {
  const { threadId, prompt } = command;
  const session: ProviderEvent = {
    type: 'session',
    threadId,
    providerSessionId: command.resumeId ?? `mock-session-${threadId.slice(0, 8)}`,
  };
  const resumed = command.resumeId === undefined ? '' : `Resumed ${command.resumeId}. `;
  // A step of a unit's run: the agent opens the unit's pull request, as deliver-work would, and
  // says which unit it was told about.
  const unit = /^Unit: (\S+) (.*)$/m.exec(prompt);
  const unitIntent = /^Intent: (\S+)$/m.exec(prompt)?.[1];
  if (/deliver the plan unit/i.test(prompt) && unit?.[1] && unitIntent) {
    const key = unit[1];
    const line = `Intent-Unit: ${unitIntent}/${key}`;
    if (!potHost.pulls.some((pull) => pull.body.endsWith(line))) {
      const number = 31 + potHost.pulls.length;
      potHost.pulls = [
        ...potHost.pulls,
        {
          number,
          title: unit[2] ?? key,
          body: `Invented.\n\n${line}`,
          state: 'open',
          branch: `agent/${key}`,
          sha: `c${number}c${number}c${number}`,
          checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        },
      ];
    }
    return [session, ...finish(threadId, `Delivered ${key} of ${unitIntent}: ${unit[2] ?? ''}`)];
  }
  // A send back names no step, and the note in it may say anything, so it is looked for first.
  if (/sent it back/i.test(prompt)) {
    if (inTeaRepo(command.cwd)) reworkTeaTimer(command.cwd);
    return [
      session,
      ...finish(threadId, 'Second attempt: the bell and a new document name the kettle.'),
    ];
  }
  // The path tests (e2e/run-path.spec.ts): a rule of the review sent the work back to the build
  // step, which is told so in its own thread; and a review that asks for changes the first time
  // it looks and approves when it is asked again in the same thread.
  if (/sent the work back/i.test(prompt)) {
    return [session, ...finish(threadId, 'Second look: the lid is tight now.')];
  }
  if (/check the kettle until it holds/i.test(prompt)) {
    return command.resumeId === undefined
      ? [session, ...finish(threadId, 'The lid is loose.\n\nCHANGES_REQUESTED')]
      : [session, ...finish(threadId, 'The lid holds.\n\nAPPROVED')];
  }
  // The gate condition tests: a check that ends with a verdict line, as check-work does, and a
  // plan that ends with the approved line although its gate must wait all the same. The step
  // after the check quotes "APPROVED" in its handover, so it is answered before the approval
  // prompt below can match.
  if (/kettle taught us/i.test(prompt)) {
    return [session, ...finish(threadId, 'Noted: descale the kettle monthly.')];
  }
  if (/check the kettle strictly/i.test(prompt)) {
    return [session, ...finish(threadId, 'The lid is loose.\n\nCHANGES_REQUESTED')];
  }
  if (/check the kettle/i.test(prompt)) {
    return [session, ...finish(threadId, 'The kettle whistles at the boil.\n\nAPPROVED')];
  }
  if (/plan the kettle/i.test(prompt)) {
    return [session, ...finish(threadId, 'The plan: fill, boil, pour.\n\nAPPROVED')];
  }
  // The review step's prompt quotes the build step's answer, so it is looked for first.
  if (/review the tea timer/i.test(prompt)) {
    if (inTeaRepo(command.cwd)) reviewTeaTimer(command.cwd);
    return [session, ...finish(threadId, 'Reviewed the tea timer: one rename, notes written.')];
  }
  if (/build the tea timer/i.test(prompt)) {
    if (inTeaRepo(command.cwd)) buildTeaTimer(command.cwd);
    return [session, ...finish(threadId, 'The tea timer rings twice now.')];
  }
  // A turn that reads three things, one of which fails: the conversation draws them as one row.
  if (/look around/i.test(prompt)) {
    const calls = [
      { id: 'read-1', name: 'Read', input: { file_path: 'package.json' }, status: 'ok' },
      { id: 'grep-1', name: 'Grep', input: { pattern: 'kettle' }, status: 'error' },
      { id: 'read-2', name: 'Read', input: { file_path: 'README.md' }, status: 'ok' },
    ] as const;
    return [
      session,
      ...calls.flatMap(({ id, name, input, status }): ProviderEvent[] => [
        { type: 'toolCallStarted', threadId, itemId: id, name, input },
        { type: 'toolCallOutput', threadId, itemId: id, output: `${name} ${id} answered\n` },
        { type: 'toolCallCompleted', threadId, itemId: id, status },
      ]),
      ...finish(threadId, 'The repo holds a kettle.'),
    ];
  }
  // Tool rows (agent workbench U4): a task list, a command that exits 1 after 4.2 s in a folder
  // of its own, a read, an MCP call, and a command that keeps running, so the turn runs on.
  if (/run the tools/i.test(prompt)) {
    const testOutput = Array.from({ length: 24 }, (_, line) => `kettle test ${line + 1} passed`);
    const tasks = [
      'Read the readme',
      'Find the kettle issue',
      'Plan the timer',
      'Running the tests',
      'Fix the failing test',
      'Start the dev server',
      'Write the summary',
    ].map((content, index) => ({
      id: String(index + 1),
      content,
      status:
        index < 3
          ? ('completed' as const)
          : index === 3
            ? ('in_progress' as const)
            : ('pending' as const),
    }));
    return [
      session,
      { type: 'textDelta', threadId, itemId: 'intro', delta: 'Running the checks.' },
      { type: 'taskListUpdated', threadId, tasks },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'cmd-test',
        name: 'command',
        input: { command: 'pnpm test', cwd: `${command.cwd}/app` },
        kind: 'command',
        command: 'pnpm test',
        cwd: `${command.cwd}/app`,
      },
      {
        type: 'toolCallOutput',
        threadId,
        itemId: 'cmd-test',
        output: `${[...testOutput, 'kettle test 25 failed: expected 2 rings, got 1'].join('\n')}\n`,
      },
      {
        type: 'toolCallCompleted',
        threadId,
        itemId: 'cmd-test',
        status: 'error',
        exitCode: 1,
        durationMs: 4200,
      },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'read-readme',
        name: 'Read',
        input: { file_path: `${command.cwd}/README.md`, offset: 1, limit: 80 },
        kind: 'read',
        path: `${command.cwd}/README.md`,
        lines: { from: 1, to: 80 },
      },
      { type: 'toolCallOutput', threadId, itemId: 'read-readme', output: '# Demo\n' },
      { type: 'toolCallCompleted', threadId, itemId: 'read-readme', status: 'ok' },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'mcp-issue',
        name: 'mcp__tracker__find_issue',
        input: { key: 'DEMO-42', fields: ['status'] },
        kind: 'mcp',
        server: 'tracker',
        tool: 'find_issue',
      },
      { type: 'toolCallOutput', threadId, itemId: 'mcp-issue', output: 'DEMO-42 · To Do\n' },
      { type: 'toolCallCompleted', threadId, itemId: 'mcp-issue', status: 'ok', durationMs: 300 },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'cmd-dev',
        name: 'Bash',
        input: { command: 'pnpm dev' },
        kind: 'command',
        command: 'pnpm dev',
      },
    ];
  }
  if (/approve/i.test(prompt)) {
    return [
      session,
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'tool-1',
        name: 'Bash',
        input: { command: 'pnpm test' },
      },
      {
        type: 'approvalRequested',
        threadId,
        approvalId: `${threadId}${separator}approval`,
        kind: 'command',
        summary: 'pnpm test',
        request: { command: 'pnpm test', cwd: '/work/demo' },
      },
    ];
  }
  // Two questions in one ask, as Claude Code asks them: a header each, a recommended choice
  // marked the provider's way, and one that takes several picks (questions spec 1 to 3).
  if (/two questions/i.test(prompt)) {
    return [
      session,
      {
        type: 'questionAsked',
        threadId,
        questionId: `${threadId}${separator}ask${separator}0`,
        askId: `${threadId}-ask`,
        header: 'Kettle',
        question: 'Which kettle should the tea timer start?',
        options: [
          { label: 'Glass kettle', description: 'You can see the water' },
          { label: 'Steel kettle (Recommended)', description: 'Boils faster', recommended: true },
          { label: 'Travel kettle', description: 'Small, for one cup' },
        ],
        multiSelect: false,
      },
      {
        type: 'questionAsked',
        threadId,
        questionId: `${threadId}${separator}ask${separator}1`,
        askId: `${threadId}-ask`,
        header: 'Teas',
        question: 'Which teas go on the timer list?',
        options: [
          { label: 'Green', description: 'Three minutes' },
          { label: 'Black', description: 'Five minutes' },
          { label: 'Oolong', description: 'Four minutes' },
        ],
        multiSelect: true,
      },
    ];
  }
  if (/question/i.test(prompt)) {
    return [
      session,
      {
        type: 'questionAsked',
        threadId,
        questionId: `${threadId}${separator}question`,
        askId: `${threadId}-question`,
        header: 'Color',
        question: 'Which color should the button be?',
        options: [
          { label: 'Red', description: 'Warm and loud' },
          { label: 'Blue', description: 'Calm' },
        ],
        multiSelect: false,
      },
    ];
  }
  if (/break the build/i.test(prompt)) {
    return [session, { type: 'turnFailed', threadId, error: 'The build broke' }];
  }
  if (/table and a diagram/i.test(prompt)) {
    return [session, ...finish(threadId, markdownAnswer)];
  }
  if (/reaches out/i.test(prompt)) {
    return [session, ...finish(threadId, reachingAnswer)];
  }
  if (/in the background/i.test(prompt)) {
    // Claude Code ends the turn with an agent still running; the control port's
    // /background-done ends it, and the agent goes on by itself in a turn wow did not start.
    backgroundThreads.push(threadId);
    return [
      session,
      {
        type: 'backgroundTasks',
        threadId,
        tasks: [{ id: 'bg-1', description: 'Count the tea leaves', agent: true }],
      },
      ...finish(threadId, 'I asked a background agent to count them.'),
    ];
  }
  if (/wait/i.test(prompt)) {
    return [session, { type: 'textDelta', threadId, itemId: 'partial', delta: 'Working on it' }];
  }
  return [
    session,
    { type: 'reasoningDelta', threadId, itemId: 'thinking', delta: 'The user said hello.' },
    {
      type: 'taskListUpdated',
      threadId,
      tasks: [
        { id: '1', content: 'Read the message', status: 'completed' },
        { id: '2', content: 'Answer it', status: 'in_progress' },
      ],
    },
    ...finish(threadId, `${resumed}You said: ${prompt}`),
  ];
}

const threadOf = (id: string) => id.split(separator)[0] ?? id;

// Threads whose turn left background work running, oldest first, and a Claude mock adapter to
// send what follows through (the provider service takes a thread's events from any adapter).
const backgroundThreads: string[] = [];
let claudeMock: MockProviderAdapter | undefined;

// What the first question of a two-question ask was answered, per thread, until the second is.
const answered = new Map<string, string[]>();

const chatScript: MockScript = (command) => {
  switch (command.type) {
    case 'startTurn':
      return startTurn(command);
    case 'answerApproval': {
      const threadId = threadOf(command.approvalId);
      const allowed = command.decision !== 'deny';
      return [
        { type: 'toolCallOutput', threadId, itemId: 'tool-1', output: 'All 12 tests passed\n' },
        { type: 'toolCallCompleted', threadId, itemId: 'tool-1', status: allowed ? 'ok' : 'error' },
        ...finish(threadId, allowed ? 'The command ran.' : 'The command was denied.', 'after'),
      ];
    }
    case 'answerQuestion': {
      // The questions of one ask are answered together; the agent goes on after the last.
      const threadId = threadOf(command.questionId);
      const given = [...(answered.get(threadId) ?? []), replyText(command.answer)];
      if (command.questionId.endsWith(`${separator}ask${separator}0`)) {
        answered.set(threadId, given);
        return [];
      }
      answered.delete(threadId);
      return finish(threadId, `You chose ${given.join(' and ')}.`, 'after');
    }
    case 'interrupt':
      return [{ type: 'turnInterrupted', threadId: command.threadId }];
    default:
      return [];
  }
};

const chatClaude = () => (claudeMock = new MockProviderAdapter('claude', chatScript));

// "Update Codex" (settings tests): a Codex instance named "... differs" tests as a compatible
// other version, one named "... incompatible" as incompatible with an npm update until the fake
// npm below has "installed" the tested version (a marker file in the server home).
const codexInstalled = () => path.join(home, 'codex-installed');
const fakeNpm = path.join(home, 'fake-npm.cjs');
function codexTest(instance: ProviderInstance): () => ProviderTestResult {
  return () => {
    if (firstStart)
      return { ok: false, account: null, version: null, message: e2eFirstStartCodexError };
    if (/differs/i.test(instance.name))
      return {
        ok: true,
        account: 'mock',
        version: '0.164.0',
        message: 'codex 0.164.0 differs from the tested 0.166.0; compatible.',
        update: null,
      };
    if (/incompatible/i.test(instance.name) && !existsSync(codexInstalled()))
      return {
        ok: false,
        account: null,
        version: '0.100.0',
        message:
          'codex 0.100.0 is not compatible with wow, which is tested with codex 0.166.0: model/list result.data[].hidden is missing. Update codex to 0.166.0.',
        update: {
          method: 'npm',
          targetVersion: '0.166.0',
          reason: 'incompatible',
          packageSpec: '@openai/codex@0.166.0',
          prefix: null,
        },
      };
    return { ok: true, account: 'mock', version: 'mock', message: null };
  };
}

// The invented Outlook fixtures, placed relative to today. The calendar tests make it fail and
// come back through the control port below.
const outlook = new MockOutlookSource({ fixtures: await loadFixtures() });

if (!keepHome) await rm(home, { recursive: true, force: true });
// Provider detection looks at the server's PATH; the mock adapters never run these files.
await mkdir(e2eBinDir(home), { recursive: true });
for (const name of ['claude', 'codex']) {
  await writeFile(e2eBinary(home, name), '', { mode: 0o755 });
}
// Skills discovery reads "~/.claude/skills"; "~" is a folder inside the server's home, so the tests
// never see the real user's skills.
const userHome = path.join(home, 'user-home');
for (const [name, description] of [
  ['deliver-work', 'Deliver one unit of planned work end to end.'],
  ['capture-intent', 'Turn a rough idea into an intent and a spec.'],
  ['plan-work', 'Split a spec into ordered units of work.'],
  ['check-work', 'Review delivered work against its contract.'],
] as const) {
  const dir = path.join(userHome, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nInvented fixture skill.\n`,
  );
}
// The seeded project's folder is the server home; an intent there is what the Feature template's
// first step expects, so the workflow tests see a found artifact.
await writeFile(
  fakeNpm,
  [
    "const fs = require('node:fs');",
    "process.stdout.write('added 1 package in 1s (invented)\\n');",
    `fs.writeFileSync(${JSON.stringify(codexInstalled())}, process.argv.slice(2).join(' '));`,
  ].join('\n'),
);
await mkdir(path.join(home, 'intents', 'demo'), { recursive: true });
await writeFile(path.join(home, 'intents', 'demo', 'intent.md'), '# Demo intent\n');
const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, check]);
};

// An invented picture for the viewer tests: a PNG drawn here, so no binary fixture is checked in.
function inventedPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Rows of red, green, blue: a slate page with a lighter card and an accent bar on it.
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const card = x > width * 0.1 && x < width * 0.9 && y > height * 0.2 && y < height * 0.8;
      const bar = card && y < height * 0.3;
      const color = bar ? [94, 106, 210] : card ? [236, 238, 244] : [30, 34, 46];
      rows.set(color, y * (1 + width * 3) + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// The panel server's project holds one invented file of each kind the viewer shows, and one it
// refuses. The HTML page tries everything a page must not be able to do from the viewer: reach
// the app, its storage and the network (the tracker port below records any request that arrives,
// and any datagram: WebRTC is the one way out that a content policy does not govern, so the page
// asks for it from its own script, from a script in an attribute and from a frame inside it).
if (home === e2ePanelHome) {
  const review = path.join(home, 'review');
  const leak = `http://127.0.0.1:${trackerPort}/leak`;
  const connect = [
    `const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${trackerPort}' }] });`,
    "peer.createDataChannel('leak');",
    'peer.createOffer().then((offer) => peer.setLocalDescription(offer));',
  ].join(' ');
  await mkdir(review, { recursive: true });
  await writeFile(
    path.join(review, 'notes.md'),
    [
      '# Review notes',
      '',
      'The search panel was checked against its **three** acceptance lines.',
      '',
      '| Check | Result |',
      '| --- | --- |',
      '| Opens with its key | Pass |',
      '| Keeps the query after a reload | Pass |',
      '| Shows an empty state | Needs a look |',
      '',
      '- [x] Keyboard only',
      '- [ ] Screen reader pass',
      '',
      '```ts',
      "export const verdict = 'changes requested';",
      '```',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(review, 'screen.png'), inventedPng(640, 400));
  await writeFile(
    path.join(review, 'checks.json'),
    `${JSON.stringify({ suite: 'search-panel', passed: 12, failed: 1 }, null, 2)}\n`,
  );
  await writeFile(path.join(review, 'archive.bin'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff, 0]));
  await writeFile(
    path.join(review, 'report.html'),
    [
      '<!doctype html>',
      '<html><head><title>Invented report</title>',
      '<style>body { font: 14px sans-serif; margin: 16px; } h1 { font-size: 18px; }</style>',
      '</head><body>',
      '<h1>Search panel report</h1>',
      '<p id="scripts">Scripts: off</p>',
      '<p id="app">App: not tried</p>',
      '<p id="network">Network: not tried</p>',
      '<p id="webrtc">WebRTC: not tried</p>',
      `<button id="handler" onclick="${connect} this.textContent = 'Handler: ran';">Handler: off</button>`,
      `<iframe title="Inner frame" srcdoc="<script>${connect}</script>"></iframe>`,
      `<img alt="" src="${leak}/image">`,
      `<a href="${leak}/link" target="_self">A link out</a>`,
      '<script>',
      "  document.getElementById('scripts').textContent = 'Scripts: on';",
      "  let app = 'blocked';",
      "  try { app = 'reached ' + parent.document.title; } catch {}",
      "  let storage = 'blocked';",
      "  try { localStorage.setItem('invented', '1'); storage = 'reached'; } catch {}",
      "  document.getElementById('app').textContent = 'App: ' + app + ', storage: ' + storage;",
      `  fetch('${leak}/fetch').then(() => 'reached', () => 'blocked').then((result) => {`,
      "    document.getElementById('network').textContent = 'Network: ' + result;",
      '  });',
      "  const webrtc = document.getElementById('webrtc');",
      "  let own = 'blocked';",
      `  try { ${connect} own = 'open'; } catch {}`,
      "  let borrowed = 'blocked';",
      '  try {',
      "    const inner = document.body.appendChild(document.createElement('iframe'));",
      "    new inner.contentWindow.RTCPeerConnection(); borrowed = 'open';",
      '  } catch {}',
      "  webrtc.textContent = 'WebRTC: ' + own + ', from a frame: ' + borrowed;",
      '</script>',
      '</body></html>',
      '',
    ].join('\n'),
  );
}
if (home === e2eChangesHome) {
  seedTeaRepo(changesRepo);
  seedTeaRepo(gateRepo);
  seedCopyRepo();
  // The host tests: a repository on a branch that has a pull request, with a plan in it.
  seedTeaRepo(hostRepo);
  git(hostRepo, 'checkout', '-q', '-b', e2eHostBranch);
  const garden = 'A tea garden that waters itself';
  for (const [name, text] of Object.entries({
    // The page tests: the intent links to a page on the mock Confluence by space and title.
    'intent.md': `${e2eIntentMd(e2eHostIntentId, garden)}\nDesign notes: http://127.0.0.1:${trackerPort}/confluence/display/ENG/Watering+notes\n`,
    'spec.md': e2eSpecMd(e2eHostIntentId, garden),
    'plan.md': e2ePlanMd(e2eHostIntentId, garden, gardenUnits),
  })) {
    writeInRepo(hostRepo, `intents/${e2eHostIntentId}/${name}`, text);
  }
  // The GitLab tests: a repository whose remote is on the mock GitLab, on the branch of an open
  // merge request, with a plan in it. Nothing fetches from the remote.
  seedTeaRepo(fieldRepo);
  git(fieldRepo, 'checkout', '-q', '-b', e2eGitLabBranch);
  git(fieldRepo, 'remote', 'add', 'origin', `git@127.0.0.1:${e2eGitLabProjectPath}.git`);
  const field = 'A tea field that weeds itself';
  for (const [name, text] of Object.entries({
    'intent.md': e2eIntentMd(e2eGitLabIntentId, field),
    'spec.md': e2eSpecMd(e2eGitLabIntentId, field),
    'plan.md': e2ePlanMd(e2eGitLabIntentId, field, fieldUnits),
  })) {
    writeInRepo(fieldRepo, `intents/${e2eGitLabIntentId}/${name}`, text);
  }
  // The plan run tests: a repository whose plan has no pull request yet. Its unit runs work in
  // working copies, which share the repository's settings.
  seedTeaRepo(potRepo);
  git(potRepo, 'config', 'core.autocrlf', 'false');
  const pot = 'A tea pot that pours without dripping';
  for (const [name, text] of Object.entries({
    'intent.md': e2eIntentMd(e2ePlanRunIntentId, pot),
    'spec.md': e2eSpecMd(e2ePlanRunIntentId, pot),
    'plan.md': e2ePlanMd(e2ePlanRunIntentId, pot, potUnits),
  })) {
    writeInRepo(potRepo, `intents/${e2ePlanRunIntentId}/${name}`, text);
  }
  // The event trigger tests: a repository that has the branch of its plan's pull request, so
  // the run an event starts gets a working copy on it.
  seedTeaRepo(leafRepo);
  git(leafRepo, 'config', 'core.autocrlf', 'false');
  git(leafRepo, 'branch', e2eEventBranch);
  const leaf = 'A tea leaf picker';
  for (const [name, text] of Object.entries({
    'intent.md': e2eIntentMd(e2eEventIntentId, leaf),
    'spec.md': e2eSpecMd(e2eEventIntentId, leaf),
    'plan.md': e2ePlanMd(e2eEventIntentId, leaf, leafUnits),
  })) {
    writeInRepo(leafRepo, `intents/${e2eEventIntentId}/${name}`, text);
  }
}
await seedPlanFiles(home);
// Commands the assistant mock agent sends as the assistant's, numbered for their ids.
let assistantActs = 0;
const server = await startServer({
  home,
  port,
  userHome,
  ...(clockOffsetMs === 0 ? {} : { clock: () => new Date(Date.now() + clockOffsetMs) }),
  runNpm: createNpmRunner({ file: process.execPath, prefixArgs: [fakeNpm] }),
  env: {
    ...process.env,
    WOW_PROVIDERS: '',
    PATH: e2eBinDir(home),
    CLAUDE_CONFIG_DIR: e2eClaudeConfigDir(home),
    CODEX_HOME: e2eCodexHome(home),
  },
  hooks: {
    providers: {
      claude: () =>
        home === e2eAssistantHome || firstStart
          ? new AssistantMockAgent(
              new MockProviderAdapter('claude', chatScript),
              () => server.assistant.tools,
              (command) =>
                server.engine.dispatch(`assistant-mock-${++assistantActs}`, command, 'assistant'),
              `http://127.0.0.1:${trackerPort}`,
            )
          : chatClaude(),
      codex: (instance) => new MockProviderAdapter('codex', chatScript, codexTest(instance)),
    },
    outlook: (mode, context) => {
      if (mode !== 'mock') throw new Error('The e2e server runs with WOW_OUTLOOK=mock');
      return startOutlookService(mode, context, { source: outlook });
    },
  },
});

const control = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/unavailable' && request.method === 'PUT') {
    outlook.setUnavailable(url.searchParams.get('message') ?? 'Outlook is not running');
  } else if (url.pathname === '/unavailable' && request.method === 'DELETE') {
    outlook.setUnavailable(null);
  } else if (url.pathname === '/background-done' && request.method === 'PUT') {
    const threadId = backgroundThreads.shift();
    if (!threadId || !claudeMock) {
      response.statusCode = 409;
    } else {
      claudeMock.emit([
        { type: 'backgroundTasks', threadId, tasks: [] },
        { type: 'turnStartedByProvider', threadId },
        ...finish(threadId, 'The background agent counted 42 leaves.', 'counted'),
      ]);
    }
  } else if (url.pathname === '/opened' && request.method === 'GET') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(outlook.opened));
    return;
  } else if (url.pathname === '/asked' && request.method === 'GET') {
    // Every operation the server has asked the mock Outlook, once each.
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([...new Set(outlook.asked)].toSorted()));
    return;
  } else {
    response.statusCode = 404;
  }
  response.end();
});
// A test's requests can be more than Node's five idle seconds apart; a connection closed in
// between is reused by the test's fetch and fails with a reset.
control.keepAliveTimeout = 0;
await new Promise<void>((resolve) => control.listen(outlookControlPort, '127.0.0.1', resolve));

if (!firstStart) {
  server.engine.dispatch('seed-instance', {
    type: 'providerInstance.create',
    providerInstanceId: e2eProviderInstanceId,
    kind: 'claude',
    name: 'Mock Claude',
    binaryPath: 'claude',
    configDir: '/home/me/.claude',
    env: {},
    launchArgs: [],
    defaultPermissionMode: 'default',
  });
}
// The assistant runs only on an instance whose test passed.
if (home === e2eAssistantHome) await server.providerService.test(e2eProviderInstanceId);
// Only the chat server gets a Codex instance; the settings tests count and add instances themselves.
if (home === e2eHome) {
  server.engine.dispatch('seed-codex-instance', {
    type: 'providerInstance.create',
    providerInstanceId: e2eCodexInstanceId,
    kind: 'codex',
    name: 'Mock Codex',
    binaryPath: 'codex',
    configDir: '/home/me/.codex',
    env: {},
    launchArgs: [],
  });
}
// The projects server: invented Claude and Codex session files in the config directories detection
// reports, read by two instances that use those defaults. `alpha` appears in both, `beta` only in
// Codex, and `gone` no longer exists, so the import offers alpha and beta.
if (home === e2eProjectsHome) {
  for (const name of ['alpha', 'beta']) await mkdir(e2eWorkspace(home, name), { recursive: true });
  const claudeProjects = path.join(e2eClaudeConfigDir(home), 'projects');
  for (const name of ['alpha', 'gone']) {
    const cwd = e2eWorkspace(home, name);
    const dir = path.join(claudeProjects, cwd.replaceAll(/[^A-Za-z0-9]/g, '-'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'session-1.jsonl'),
      `${JSON.stringify({ type: 'user', cwd, sessionId: `invented-${name}` })}\n`,
    );
  }
  const codexDay = path.join(e2eCodexHome(home), 'sessions', '2026', '11', '01');
  await mkdir(codexDay, { recursive: true });
  for (const name of ['alpha', 'beta']) {
    await writeFile(
      path.join(codexDay, `rollout-invented-${name}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', payload: { id: name, cwd: e2eWorkspace(home, name) } })}\n`,
    );
  }
  for (const kind of ['claude', 'codex'] as const) {
    server.engine.dispatch(`seed-discovery-${kind}`, {
      type: 'providerInstance.create',
      providerInstanceId: `discovery-${kind}`,
      kind,
      name: `Discovery ${kind === 'claude' ? 'Claude' : 'Codex'}`,
      binaryPath: kind,
      configDir: '',
      env: {},
      launchArgs: [],
    });
  }
}
if (!firstStart) {
  server.engine.dispatch('seed-project', {
    type: 'project.create',
    projectId: e2eProjectId,
    name: 'Demo',
    cwd: home,
  });
  server.engine.dispatch('seed-plans-directory', {
    type: 'setting.set',
    key: 'plans.intentsDirectory',
    scope: `project:${e2eProjectId}`,
    value: e2ePlansDirectory,
  });
}

// Settings for the mock trackers below: Jira fully set up, GitHub without its token, which the
// backlog tests enter on the settings page.
const trackerUrl = `http://127.0.0.1:${trackerPort}`;
const seedSettings: Record<string, unknown> = {
  'trackers.jira.baseUrl': `${trackerUrl}/jira`,
  'trackers.jira.email': 'me@example.invalid',
  'trackers.jira.projectKey': 'DEMO',
  'trackers.jira.token': await server.secrets.set('setting:trackers.jira.token', 'jira-e2e-token'),
  'trackers.github.baseUrl': `${trackerUrl}/github`,
  'trackers.github.owner': 'acme',
  'trackers.github.repo': 'demo',
  'trackers.confluence.baseUrl': `${trackerUrl}/confluence`,
  'trackers.confluence.authMode': 'pat',
  'trackers.confluence.token': await server.secrets.set(
    'setting:trackers.confluence.token',
    'confluence-e2e-token',
  ),
};
for (const [key, value] of Object.entries(firstStart ? {} : seedSettings)) {
  server.engine.dispatch(`seed-${key}`, { type: 'setting.set', key, scope: 'global', value });
}
if (!firstStart) {
  // A one-step workflow for "Plan on calendar"; the mock provider finishes its turn.
  server.engine.dispatch('seed-workflow', {
    type: 'workflow.create',
    workflowId: e2eWorkflowId,
    name: 'Backlog e2e',
    steps: [
      {
        id: 'deliver',
        skillName: 'deliver-work',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'default',
        permissionMode: 'default',
        gateBefore: false,
        gateAfter: false,
        expectedArtifacts: [],
      },
    ],
  });
}

// The panel server: a one-step workflow that waits for the user after its step, and a card
// tomorrow at 10:00 (this machine's zone) that runs it, started through POST /fire?cardId=….
if (home === e2ePanelHome) {
  server.engine.dispatch('seed-panel-workflow', {
    type: 'workflow.create',
    workflowId: e2ePanelWorkflowId,
    name: 'Panel e2e',
    steps: [
      {
        id: 'review',
        skillName: 'check-work',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'default',
        permissionMode: 'default',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: [],
      },
    ],
  });
  server.engine.dispatch('seed-viewer-workflow', {
    type: 'workflow.create',
    workflowId: e2eViewerWorkflowId,
    name: 'Viewer e2e',
    steps: [
      {
        id: 'review',
        skillName: 'check-work',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'default',
        permissionMode: 'default',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: ['review/*'],
      },
    ],
  });
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  server.engine.dispatch('seed-panel-card', {
    type: 'card.create',
    cardId: e2ePanelCardId,
    title: 'Review the search panel',
    start: start.toISOString(),
    end: new Date(start.getTime() + 60 * 60_000).toISOString(),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    body: 'Invented notes for the panel tests.',
    projectId: e2eProjectId,
    workflowId: e2ePanelWorkflowId,
  });
}

// A Codex step of the old workflow below, without a model.
const oldStep = (id: string, providerInstanceId: string) => ({
  id,
  skillName: id,
  providerInstanceId,
  effort: 'low',
  permissionMode: 'auto',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
});

if (home === e2eAssistantHome) {
  for (const [providerInstanceId, name, defaults] of [
    [
      e2eCodexWithDefaultId,
      'Codex at work',
      { defaultModel: 'mock-model-large', defaultEffort: 'medium' },
    ],
    [e2eCodexBareId, 'Codex bare', {}],
  ] as const) {
    server.engine.dispatch(`seed-${providerInstanceId}`, {
      type: 'providerInstance.create',
      providerInstanceId,
      kind: 'codex',
      name,
      binaryPath: 'codex',
      configDir: '/home/me/.codex',
      env: {},
      launchArgs: [],
      ...defaults,
    });
  }
  // Stored as an older wow stored it: its Codex steps name no model. Restoring a row keeps it
  // as it was, which is how old data reaches the store here.
  server.engine.dispatch('seed-assistant-old-workflow', {
    type: 'workflow.restore',
    workflow: {
      id: e2eOldWorkflowId,
      name: 'Old review',
      templateKind: null,
      steps: [oldStep('check-work', e2eCodexBareId), oldStep('plan-work', e2eCodexWithDefaultId)],
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-01T08:00:00.000Z',
    },
  });
  // Its run waits before its only step, so a test has a gate to ask the assistant about.
  server.engine.dispatch('seed-assistant-gate-workflow', {
    type: 'workflow.create',
    workflowId: e2eAssistantGateWorkflowId,
    name: 'Kettle check',
    steps: [
      {
        id: 'check',
        skillName: 'check-work',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'default',
        permissionMode: 'default',
        gateBefore: true,
        gateAfter: false,
        expectedArtifacts: [],
      },
    ],
  });
  server.engine.dispatch('seed-assistant-broken-workflow', {
    type: 'workflow.create',
    workflowId: e2eAssistantBrokenWorkflowId,
    name: 'Brew report',
    steps: [
      {
        id: 'report',
        skillName: 'brew-report',
        providerInstanceId: e2eProviderInstanceId,
        model: 'mock-model',
        effort: 'default',
        permissionMode: 'default',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: [],
      },
    ],
  });
}

const teaStep = (id: string, skillName: string, extraPrompt: string) => ({
  id,
  skillName,
  providerInstanceId: e2eProviderInstanceId,
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  gateBefore: false,
  gateAfter: true,
  extraPrompt,
  expectedArtifacts: [],
});

// The Changes server: the tea timer repository as a project, and a build step and a review step
// that each wait for the user.
if (home === e2eChangesHome) {
  server.engine.dispatch('seed-changes-project', {
    type: 'project.create',
    projectId: e2eChangesProjectId,
    name: 'Tea timer',
    cwd: changesRepo,
  });
  server.engine.dispatch('seed-changes-workflow', {
    type: 'workflow.create',
    workflowId: e2eChangesWorkflowId,
    name: 'Build and review',
    steps: [
      teaStep('build', 'deliver-work', 'Build the tea timer.'),
      teaStep('review', 'check-work', 'Review the tea timer.'),
    ],
  });
  // The gate tests: the same agent in its own repository, with a third step so that Approve can
  // be used by key, by button and from the palette.
  server.engine.dispatch('seed-gate-project', {
    type: 'project.create',
    projectId: e2eGateProjectId,
    name: 'Tea kettle',
    cwd: gateRepo,
  });
  server.engine.dispatch('seed-gate-workflow', {
    type: 'workflow.create',
    workflowId: e2eGateWorkflowId,
    name: 'Build, review and wrap up',
    steps: [
      {
        ...teaStep('build', 'deliver-work', 'Build the tea timer.'),
        expectedArtifacts: ['docs/*.md'],
      },
      teaStep('review', 'check-work', 'Review the tea timer.'),
      teaStep('wrap', 'learn-work', 'Note what the tea timer taught us.'),
    ],
  });
  // The working copy tests: the same agent again; the test turns "Own working copy" on in the
  // builder before it starts a run.
  server.engine.dispatch('seed-copy-project', {
    type: 'project.create',
    projectId: e2eCopyProjectId,
    name: 'Tea cup',
    cwd: copyRepo,
  });
  server.engine.dispatch('seed-copy-workflow', {
    type: 'workflow.create',
    workflowId: e2eCopyWorkflowId,
    name: 'Build in a working copy',
    steps: [
      teaStep('build', 'deliver-work', 'Build the tea timer.'),
      { ...teaStep('review', 'check-work', 'Review the tea timer.'), gateAfter: false },
    ],
  });
  // The gate condition tests (e2e/gate-condition.spec.ts) run in the Demo project and touch no
  // repository: a check whose gate the test gives a condition in the builder, and a plan whose
  // gate can get none.
  server.engine.dispatch('seed-condition-workflow', {
    type: 'workflow.create',
    workflowId: e2eConditionWorkflowId,
    name: 'Check and wrap up',
    steps: [
      teaStep('check', 'check-work', 'Check the kettle.'),
      teaStep('wrap', 'learn-work', 'Note what the kettle taught us.'),
    ],
  });
  // The rules tests (e2e/workflow-rules.spec.ts): a step whose name is hostile to a diagram.
  server.engine.dispatch('seed-rules-workflow', {
    type: 'workflow.create',
    workflowId: e2eRulesWorkflowId,
    name: 'A step with a strange name',
    steps: [
      { ...teaStep('build', 'deliver-work', 'Build the kettle.'), gateAfter: false },
      { ...teaStep('strange', e2eHostileSkillName, 'Check the kettle.'), gateAfter: false },
    ],
  });
  // The limit test (e2e/run-path.spec.ts): a review that never approves and a rule that sends
  // the work back to the build step every time.
  server.engine.dispatch('seed-limit-workflow', {
    type: 'workflow.create',
    workflowId: e2eLimitWorkflowId,
    name: 'Build until the review passes',
    steps: [
      { ...teaStep('build', 'deliver-work', 'Build the kettle.'), gateAfter: false },
      {
        ...teaStep('review', 'check-work', 'Check the kettle strictly.'),
        gateAfter: false,
        rules: [
          {
            when: { fact: 'verdict', is: 'changesRequested' },
            goTo: { type: 'step', stepId: 'build' },
          },
        ],
      },
    ],
  });
  server.engine.dispatch('seed-planning-workflow', {
    type: 'workflow.create',
    workflowId: e2ePlanningWorkflowId,
    name: 'Plan and deliver',
    steps: [
      teaStep('plan', 'plan-work', 'Plan the kettle.'),
      {
        ...teaStep('deliver', 'deliver-work', 'Note what the kettle taught us.'),
        gateAfter: false,
      },
    ],
  });
}

// The host tests' project: its own GitHub repository and token, a plan, and a workflow that waits
// before its only step.
const gitHubHost = new MockGitHub({
  owner: 'acme',
  repo: 'tea-garden',
  webUrl: `${trackerUrl}/web`,
});
// The plan run tests' repository on the same invented host. It starts without pull requests;
// the mock agent opens one per unit it is asked to deliver.
const potHost = new MockGitHub({ owner: 'acme', repo: 'tea-pot', webUrl: `${trackerUrl}/web` });
potHost.token = 'github-host-e2e-token';
// The event trigger tests' repository on the same invented host: one open pull request.
const leafHost = new MockGitHub({ owner: 'acme', repo: 'tea-leaf', webUrl: `${trackerUrl}/web` });
leafHost.token = 'github-host-e2e-token';
leafHost.pulls = [
  {
    number: 21,
    title: 'Pick the leaves by hand',
    body: `Invented.\n\nIntent-Unit: ${e2eEventIntentId}/U1`,
    state: 'open',
    branch: e2eEventBranch,
    // The run's working copy starts at the pull request's head commit.
    sha:
      home === e2eChangesHome
        ? git(leafRepo, 'rev-parse', e2eEventBranch).toString().trim()
        : 'd4d4d4d4d4d4',
    checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
  },
];
const unitLine = (key: string) => `Invented.\n\nIntent-Unit: ${e2eHostIntentId}/${key}`;
gitHubHost.token = 'github-host-e2e-token';
gitHubHost.pulls = [
  {
    number: 12,
    title: 'Plant the tea',
    body: unitLine('U1'),
    state: 'closed',
    mergedAt: '2026-11-01T10:00:00Z',
    branch: 'agent/U1-plant-the-tea',
    sha: 'a1a1a1a1a1a1',
    checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
  },
  {
    number: 14,
    title: 'Water the beds every morning',
    body: unitLine('U2'),
    state: 'open',
    draft: true,
    branch: e2eHostBranch,
    sha: 'b2b2b2b2b2b2',
    checkRuns: [
      { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'success' },
      { name: 'test (windows-latest)', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'completed', conclusion: 'success' },
    ],
    statuses: { 'deploy/preview': 'failure' },
    comments: [
      { id: 9001, user: 'mira', body: 'The beds flood when it rains.', path: 'src/water.ts' },
      { id: 9004, user: 'jon', body: 'Say which valve this opens.', path: 'docs/howto.md' },
    ],
  },
];
// The GitLab the GitLab tests' project reads (GET /gitlab/api/v4/…), with a nested group path.
const gitLabHost = new MockGitLab({
  projectPath: e2eGitLabProjectPath,
  webUrl: `${trackerUrl}/web`,
});
gitLabHost.token = 'gitlab-host-e2e-token';
const fieldLine = (key: string) => `Invented.\n\nIntent-Unit: ${e2eGitLabIntentId}/${key}`;
gitLabHost.mergeRequests = [
  {
    iid: 7,
    title: 'Plough the field',
    description: fieldLine('U1'),
    state: 'merged',
    mergedAt: '2026-11-02T10:00:00Z',
    branch: 'agent/U1-plough-the-field',
    sha: 'c3c3c3c3c3c3',
    pipeline: { id: 301, status: 'success', jobs: [{ name: 'test', status: 'success' }] },
  },
  {
    iid: 9,
    title: 'Weed the rows by hand',
    description: fieldLine('U2'),
    state: 'opened',
    branch: e2eGitLabBranch,
    sha: 'e5e5e5e5e5e5',
    pipeline: {
      id: 302,
      status: 'failed',
      jobs: [
        { name: 'lint', status: 'success' },
        { name: 'test:windows', status: 'failed' },
        { name: 'deploy:review', status: 'manual' },
      ],
    },
    notes: [
      { id: 701, author: 'gitlab-bot', body: 'added 2 commits', system: true },
      { id: 702, author: 'mira', body: 'The weeds grow back by Friday.', path: 'src/weed.ts' },
    ],
  },
];
// The Jira the ticket tests read (GET /jira/rest/api/2/issue/<key>), signed in with the
// seeded global Jira settings.
const jiraHost = new MockJira();
jiraHost.authorization = `Basic ${Buffer.from('me@example.invalid:jira-e2e-token').toString('base64')}`;
jiraHost.issues = [
  {
    key: e2eTicketKey,
    summary: 'Water the beds before the sun is up',
    status: 'In Progress',
    assignee: 'Mira Invented',
    type: 'Story',
    description: [
      'h2. Why',
      'The beds dry out by *noon*, see {{water.ts}}.',
      '# Open the valve',
      '# Close it after _ten_ minutes',
      '',
      '{code:ts}',
      'openValve(10);',
      '{code}',
      '<script>window.ranTicketScript = true</script> [click|javascript:alert(1)]',
    ].join('\n'),
  },
];
// The Confluence the page tests read (GET /confluence/rest/api/content…), signed in with the
// seeded global Confluence token. The pages are invented; one tries to run a script and to load
// a picture, and neither may happen in the viewer.
const confluenceHost = new MockConfluence('/confluence');
confluenceHost.authorization = 'Bearer confluence-e2e-token';
confluenceHost.pages = [
  {
    id: '123',
    title: 'Watering schedule',
    space: 'ENG',
    version: 3,
    body: [
      '<h1>Watering schedule</h1>',
      '<p>Water the beds at <strong>five</strong> in the morning.</p>',
      `<p><img alt="valve diagram" src="${trackerUrl}/confluence/download/attachments/123/valve.png"></p>`,
      '<script>document.body.insertAdjacentHTML("beforeend", "<p id=ran>ran</p>")</script>',
    ].join(''),
  },
  {
    id: '456',
    title: 'Watering notes',
    space: 'ENG',
    version: 1,
    body: '<p>Notes on the <em>valves</em>.</p>',
  },
];
jiraHost.issues.push({
  key: e2ePagesTicketKey,
  summary: 'Water on a schedule',
  status: 'To Do',
  assignee: null,
  type: 'Story',
  description: [
    `See [the schedule|${trackerUrl}/confluence/pages/viewpage.action?pageId=123].`,
    `Not this one: ${trackerUrl}/elsewhere/pages/viewpage.action?pageId=999`,
  ].join('\n'),
});
if (home === e2eChangesHome) {
  // A backlog item already published to Jira whose description links to a page.
  server.engine.dispatch('seed-pages-item', {
    type: 'backlog.create',
    backlogItemId: e2ePagesBacklogItemId,
    title: 'Water on a schedule',
    body: '',
    tags: [],
  });
  server.engine.dispatch('seed-pages-published', {
    type: 'backlog.published',
    backlogItemId: e2ePagesBacklogItemId,
    remote: {
      service: 'jira',
      key: e2ePagesTicketKey,
      url: `${trackerUrl}/jira/browse/${e2ePagesTicketKey}`,
    },
  });
}
if (home === e2eChangesHome) {
  // A backlog item already published to Jira; the ticket test runs it in the host project.
  server.engine.dispatch('seed-ticket-item', {
    type: 'backlog.create',
    backlogItemId: e2eTicketBacklogItemId,
    title: 'Water the beds early',
    body: '',
    tags: [],
  });
  server.engine.dispatch('seed-ticket-published', {
    type: 'backlog.published',
    backlogItemId: e2eTicketBacklogItemId,
    remote: {
      service: 'jira',
      key: e2eTicketKey,
      url: `${trackerUrl}/jira/browse/${e2eTicketKey}`,
    },
  });
  server.engine.dispatch('seed-host-project', {
    type: 'project.create',
    projectId: e2eHostProjectId,
    name: 'Tea garden',
    cwd: hostRepo,
  });
  const scope = `project:${e2eHostProjectId}`;
  const hostSettings: Record<string, unknown> = {
    'trackers.github.repo': 'tea-garden',
    'trackers.github.token': await server.secrets.set(
      `setting:${scope}:trackers.github.token`,
      'github-host-e2e-token',
    ),
  };
  for (const [key, value] of Object.entries(hostSettings)) {
    server.engine.dispatch(`seed-host-${key}`, { type: 'setting.set', key, scope, value });
  }
  // A round a day: the tests see the reads a followed plan, a new run and Refresh now start,
  // and no round of the timer falls between two of their steps.
  server.engine.dispatch('seed-host-interval', {
    type: 'setting.set',
    key: 'hosts.pollSeconds',
    scope: 'global',
    value: 86_400,
  });
  server.engine.dispatch('seed-host-workflow', {
    type: 'workflow.create',
    workflowId: e2eHostWorkflowId,
    name: 'Water the beds',
    steps: [{ ...teaStep('water', 'deliver-work', 'Water the beds.'), gateBefore: true }],
  });
  server.engine.dispatch('seed-field-project', {
    type: 'project.create',
    projectId: e2eGitLabProjectId,
    name: 'Tea field',
    cwd: fieldRepo,
  });
  const fieldScope = `project:${e2eGitLabProjectId}`;
  const fieldSettings: Record<string, unknown> = {
    'trackers.gitlab.baseUrl': `${trackerUrl}/gitlab`,
    'trackers.gitlab.token': await server.secrets.set(
      `setting:${fieldScope}:trackers.gitlab.token`,
      'gitlab-host-e2e-token',
    ),
  };
  for (const [key, value] of Object.entries(fieldSettings)) {
    server.engine.dispatch(`seed-field-${key}`, {
      type: 'setting.set',
      key,
      scope: fieldScope,
      value,
    });
  }
  server.engine.dispatch('seed-pot-project', {
    type: 'project.create',
    projectId: e2ePlanRunProjectId,
    name: 'Tea pot',
    cwd: potRepo,
  });
  const potScope = `project:${e2ePlanRunProjectId}`;
  const potSettings: Record<string, unknown> = {
    'trackers.github.repo': 'tea-pot',
    'trackers.github.token': await server.secrets.set(
      `setting:${potScope}:trackers.github.token`,
      'github-host-e2e-token',
    ),
  };
  for (const [key, value] of Object.entries(potSettings)) {
    server.engine.dispatch(`seed-pot-${key}`, { type: 'setting.set', key, scope: potScope, value });
  }
  server.engine.dispatch('seed-pot-workflow', {
    type: 'workflow.create',
    workflowId: e2ePlanRunWorkflowId,
    name: 'Deliver a unit',
    steps: [{ ...teaStep('deliver', 'deliver-work', 'Deliver the plan unit.'), gateAfter: false }],
    forUnits: true,
  });
  server.engine.dispatch('seed-leaf-project', {
    type: 'project.create',
    projectId: e2eEventProjectId,
    name: 'Tea leaf',
    cwd: leafRepo,
  });
  const leafScope = `project:${e2eEventProjectId}`;
  const leafSettings: Record<string, unknown> = {
    'trackers.github.repo': 'tea-leaf',
    'trackers.github.token': await server.secrets.set(
      `setting:${leafScope}:trackers.github.token`,
      'github-host-e2e-token',
    ),
  };
  for (const [key, value] of Object.entries(leafSettings)) {
    server.engine.dispatch(`seed-leaf-${key}`, {
      type: 'setting.set',
      key,
      scope: leafScope,
      value,
    });
  }
  server.engine.dispatch('seed-leaf-workflow', {
    type: 'workflow.create',
    workflowId: e2eEventWorkflowId,
    name: 'Tidy up after a merge',
    steps: [{ ...teaStep('tidy', 'deliver-work', 'Tidy up after the merge.'), gateAfter: false }],
  });
  await server.plans.refresh();
}

const received: { path: string; authorization: string | undefined; body: unknown }[] = [];
const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
};

// What the scheduler does when a card's time comes (U11), for the backlog item's card or a card
// named by its id.
function fire(match: (card: CalendarItem) => boolean): string | undefined {
  const cards = snapshot(server.database.db, { topic: 'calendarItems' }) as CalendarItem[];
  const card = cards.find(match);
  if (!card?.workflowId || !card.projectId) return undefined;
  const runId = `run-${card.id}`;
  server.engine.dispatch(`fire-${card.id}`, {
    type: 'workflowRun.start',
    runId,
    workflowId: card.workflowId,
    projectId: card.projectId,
    calendarItemId: card.id,
    ...(card.backlogItemId ? { backlogItemId: card.backlogItemId } : {}),
  });
  return runId;
}

const trackers = createServer((request, response) => {
  const url = new URL(request.url ?? '/', trackerUrl);
  const json = (status: number, body: unknown) => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && url.pathname === '/requests') return json(200, received);
  if (request.method === 'POST' && url.pathname === '/fire') {
    const backlogItemId = url.searchParams.get('backlogItemId');
    const cardId = url.searchParams.get('cardId');
    const runId = fire((card) =>
      cardId === null ? card.backlogItemId === backlogItemId : card.id === cardId,
    );
    return runId ? json(200, { runId }) : json(404, { error: 'No such card' });
  }
  // A run started without a card, for the viewer tests.
  if (request.method === 'POST' && url.pathname === '/run') {
    const workflowId = url.searchParams.get('workflowId');
    const runId = url.searchParams.get('runId');
    if (!workflowId || !runId) return json(400, { error: 'workflowId and runId are needed' });
    const projectId = url.searchParams.get('projectId') ?? e2eProjectId;
    const backlogItemId = url.searchParams.get('backlogItemId');
    // Every run of the tea timer starts from the same invented commit.
    if (projectId === e2eChangesProjectId) seedTeaRepo(changesRepo);
    if (projectId === e2eGateProjectId) seedTeaRepo(gateRepo);
    if (projectId === e2eCopyProjectId) seedCopyRepo();
    server.engine.dispatch(`run-${runId}`, {
      type: 'workflowRun.start',
      runId,
      workflowId,
      projectId,
      ...(backlogItemId ? { backlogItemId } : {}),
    });
    return json(200, { runId });
  }
  // The mock GitHub the host tests' project reads, and its controls.
  if (url.pathname === '/github-host/requests' && request.method === 'GET') {
    return json(200, gitHubHost.requests);
  }
  if (url.pathname === '/github-host/failure') {
    const status = Number(url.searchParams.get('status') ?? '500');
    gitHubHost.failure =
      request.method === 'PUT' ? { status, message: 'Invented server error' } : undefined;
    return json(200, {});
  }
  // The mock GitLab the GitLab tests' project reads, and its controls.
  if (url.pathname === '/gitlab-host/requests' && request.method === 'GET') {
    return json(200, gitLabHost.requests);
  }
  if (url.pathname === '/gitlab-host/failure') {
    const status = Number(url.searchParams.get('status') ?? '500');
    gitLabHost.failure =
      request.method === 'PUT' ? { status, message: 'Invented GitLab error' } : undefined;
    return json(200, {});
  }
  if (request.method === 'GET' && url.pathname.startsWith('/gitlab/api/v4/')) {
    const token = request.headers['private-token'];
    const answer = gitLabHost.answer(
      'GET',
      `${url.pathname.slice('/gitlab/api/v4'.length)}${url.search}`,
      typeof token === 'string' ? token : null,
    );
    for (const [name, value] of Object.entries(answer.headers)) response.setHeader(name, value);
    return json(answer.status, answer.body);
  }
  // The mock Confluence the page tests read, and its controls. Every GET under /confluence goes
  // to it, so a picture the viewer tried to load would show in its requests.
  if (url.pathname === '/confluence-host/requests' && request.method === 'GET') {
    return json(200, confluenceHost.requests);
  }
  if (url.pathname === '/confluence-host/failure') {
    const status = Number(url.searchParams.get('status') ?? '500');
    confluenceHost.failure =
      request.method === 'PUT' ? { status, message: 'Invented Confluence refusal' } : undefined;
    return json(200, {});
  }
  if (request.method === 'GET' && url.pathname.startsWith('/confluence/')) {
    const answer = confluenceHost.answer(
      'GET',
      `${url.pathname.slice('/confluence'.length)}${url.search}`,
      request.headers.authorization ?? null,
    );
    return json(answer.status, answer.body);
  }
  // The mock Jira the ticket tests read, and its controls.
  if (url.pathname === '/jira-host/requests' && request.method === 'GET') {
    return json(200, jiraHost.requests);
  }
  if (url.pathname === '/jira-host/failure') {
    const status = Number(url.searchParams.get('status') ?? '500');
    jiraHost.failure =
      request.method === 'PUT' ? { status, message: 'Invented Jira refusal' } : undefined;
    return json(200, {});
  }
  if (request.method === 'GET' && url.pathname.startsWith('/jira/rest/api/2/issue/')) {
    const answer = jiraHost.answer(
      'GET',
      `${url.pathname.slice('/jira'.length)}${url.search}`,
      request.headers.authorization ?? null,
    );
    return json(answer.status, answer.body);
  }
  // Merges the pull request of one unit of the plan run tests' plan.
  if (url.pathname === '/github-pot/merged' && request.method === 'PUT') {
    const line = `Intent-Unit: ${e2ePlanRunIntentId}/${url.searchParams.get('unit') ?? ''}`;
    if (!potHost.pulls.some((pull) => pull.body.endsWith(line))) {
      return json(404, { error: 'No pull request for that unit' });
    }
    potHost.pulls = potHost.pulls.map((pull) =>
      pull.body.endsWith(line)
        ? { ...pull, state: 'closed', mergedAt: '2026-11-05T10:00:00Z' }
        : pull,
    );
    return json(200, {});
  }
  // Merges the pull request of the event trigger tests' plan.
  if (url.pathname === '/github-leaf/merged' && request.method === 'PUT') {
    leafHost.pulls = leafHost.pulls.map((pull) => ({
      ...pull,
      state: 'closed',
      mergedAt: '2026-11-06T10:00:00Z',
    }));
    return json(200, {});
  }
  if (request.method === 'GET' && url.pathname.startsWith('/github/')) {
    const asked = `${url.pathname.slice('/github'.length)}${url.search}`;
    // Three invented repositories live on this host; a request names its own.
    const named = decodeURIComponent(asked);
    const repository = named.includes('acme/tea-pot')
      ? potHost
      : named.includes('acme/tea-leaf')
        ? leafHost
        : gitHubHost;
    const answer = repository.answer('GET', asked, request.headers.authorization ?? null);
    for (const [name, value] of Object.entries(answer.headers)) response.setHeader(name, value);
    return json(answer.status, answer.body);
  }
  // Anything the viewer's HTML page manages to fetch lands here and fails its test.
  if (url.pathname.startsWith('/leak')) {
    received.push({ path: url.pathname, authorization: undefined, body: undefined });
    return json(200, {});
  }
  if (request.method !== 'POST') return json(404, {});
  void readBody(request).then((body) => {
    received.push({ path: url.pathname, authorization: request.headers.authorization, body });
    const number = received.length;
    if (url.pathname === '/jira/rest/api/2/issue') {
      return json(201, { id: String(10_000 + number), key: `DEMO-${number}`, self: url.href });
    }
    const github = /^\/github\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(url.pathname);
    if (github) {
      return json(201, {
        number,
        html_url: `${trackerUrl}/${github[1]}/${github[2]}/issues/${number}`,
      });
    }
    return json(404, { message: 'Not Found' });
  });
  return undefined;
});
trackers.keepAliveTimeout = 0;
await new Promise<void>((resolve) => trackers.listen(trackerPort, '127.0.0.1', resolve));
// The same port for datagrams: a STUN request from the viewer's HTML page would arrive here.
const datagrams = createSocket('udp4');
datagrams.on('message', () => {
  received.push({ path: '/leak/datagram', authorization: undefined, body: undefined });
});
await new Promise<void>((resolve) => datagrams.bind(trackerPort, '127.0.0.1', resolve));
// Seeding again after a restart repeats the same command ids, which the server answers as
// duplicates. The trigger tests wait for this line.
process.stdout.write('wow e2e server ready\n');

const stop = () => {
  control.close();
  trackers.close();
  datagrams.close();
  void server.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
