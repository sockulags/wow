import type { FileReadResult, Project, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
  type SettingValues,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMarkdown } from '../test/markdown';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime, type ViewerFile } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { viewerCommands } from './commands';
import {
  copyFilePath,
  fileLanguage,
  formatBytes,
  frameDocument,
  scriptedFrameDocument,
  shownFile,
} from './viewer';

beforeAll(loadMarkdown);

// The viewer's states in the context panel (review loop spec 6 to 9) against a fake server that
// answers `files.read` from a table of invented files.

const route = '/workflows/runs/run-1';

const project: Project = {
  id: 'demo',
  name: 'Demo',
  cwd: '/home/me/demo',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
};

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'waiting',
  currentStep: 0,
  steps: [
    {
      stepId: 's1',
      state: 'waiting',
      threadId: 'run-1.s1',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: '2026-11-02T08:05:00.000Z',
      artifactsFound: ['review/notes.md', 'review/screen.png'],
    },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
};

const workflow: Workflow = {
  id: 'w',
  name: 'Review',
  templateKind: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  steps: [
    {
      id: 's1',
      skillName: 'check-work',
      providerInstanceId: 'mock',
      model: 'mock-model',
      effort: 'default',
      permissionMode: 'default',
      gateBefore: false,
      gateAfter: true,
      expectedArtifacts: ['review/*'],
    },
  ],
};

type Answer = FileReadResult | Error | 'never';

interface Fake {
  readonly runtime: Runtime;
  readonly asked: unknown[];
}

function fake(
  files: Readonly<Record<string, Answer>>,
  options: { readonly settings?: SettingValues; readonly viewer?: string } = {},
): Fake {
  const asked: unknown[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [run],
    workflows: [workflow],
    projects: [project],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(run);
      if (method !== 'files.read') return Promise.resolve([]);
      asked.push(params);
      const answer = files[(params as { path: string }).path];
      if (answer === undefined || answer === 'never') return new Promise(() => undefined);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const layout = createLayoutStore();
  if (options.viewer !== undefined) layout.setState({ viewer: fileAt(options.viewer) });
  return {
    asked,
    runtime: {
      connection,
      layout,
      draft: createDraftStore(),
      settings: createSettingsStore(
        createMemorySettingsSource(undefined, {
          'appearance.contextPanel': true,
          // No provider instance is seeded; keep the first-run dialog out of the way.
          'providers.offerSetup': false,
          ...options.settings,
        }),
      ),
    },
  };
}

const fileAt = (path: string, from = route): ViewerFile => ({
  runId: 'run-1',
  path,
  fullPath: `/home/me/demo/${path}`,
  from,
  fullSize: false,
  read: undefined,
});

const viewer = () => screen.findByRole('region', { name: 'File viewer' });

describe('file viewer', () => {
  it('opens from an artifact button, which is not a file:// link, and goes back to the conversation', async () => {
    const user = userEvent.setup();
    const server = fake(
      {
        'review/notes.md': {
          kind: 'markdown',
          absolutePath: '/real/demo/file',
          size: 1200,
          text: '# Review notes\n\nAll good.',
        },
      },
      { settings: { 'appearance.contextPanel': false } },
    );
    const { container } = await renderApp(route, server.runtime);
    const artifacts = await screen.findByRole('list', { name: 'Artifacts of check-work' });
    expect(container.querySelector('a[href^="file:"]')).toBeNull();
    // The run waits at a gate, so the panel shows its conversation although the setting is off.
    expect(
      within(screen.getByRole('complementary', { name: 'Context panel' })).getByTestId('panel-run'),
    ).toBeTruthy();

    await user.click(within(artifacts).getByRole('button', { name: 'Open review/notes.md' }));
    const shown = await viewer();
    expect(server.asked).toEqual([{ runId: 'run-1', path: 'review/notes.md' }]);
    expect(await within(shown).findByRole('heading', { name: 'Review notes' })).toBeTruthy();
    expect(within(shown).getByTestId('viewer-path').textContent).toBe('review/notes.md');
    expect(within(shown).getByText('Markdown · 1.2 KB')).toBeTruthy();
    // The run view stays next to it.
    expect(screen.getByRole('list', { name: 'Run steps' })).toBeTruthy();

    await user.click(within(shown).getByRole('button', { name: 'Copy path' }));
    expect(await navigator.clipboard.readText()).toBe('/real/demo/file');

    await user.click(within(shown).getByRole('button', { name: 'Back to conversation' }));
    expect(screen.queryByRole('region', { name: 'File viewer' })).toBeNull();
    const panel = screen.getByRole('complementary', { name: 'Context panel' });
    expect(within(panel).getByTestId('panel-run')).toBeTruthy();
    expect(document.activeElement).toBe(panel);
  });

  it('goes back with Escape', async () => {
    const user = userEvent.setup();
    const server = fake(
      { 'a.txt': { kind: 'text', absolutePath: '/real/demo/file', size: 2, text: 'hi' } },
      { viewer: 'a.txt' },
    );
    await renderApp(route, server.runtime);
    const shown = await viewer();
    within(shown).getByRole('button', { name: 'Back to conversation' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'File viewer' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Context panel' })).toBeTruthy();
  });

  it('fits a picture to the panel and switches to its full size', async () => {
    const user = userEvent.setup();
    const server = fake(
      {
        'review/screen.png': {
          kind: 'image',
          absolutePath: '/real/demo/file',
          size: 2048,
          mediaType: 'image/png',
          base64: 'AAEC',
        },
      },
      { viewer: 'review/screen.png' },
    );
    await renderApp(route, server.runtime);
    const shown = await viewer();
    const picture = await within(shown).findByRole('img', { name: 'review/screen.png' });
    expect(picture.getAttribute('src')).toBe('data:image/png;base64,AAEC');
    expect(picture.className).toContain('object-contain');
    const full = within(shown).getByRole('button', { name: 'Full size' });
    expect(full.getAttribute('aria-pressed')).toBe('false');
    await user.click(full);
    expect(
      within(shown).getByRole('button', { name: 'Fit to panel' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(picture.className).not.toContain('object-contain');
    // The palette's commands act on what the server read, like the header's buttons.
    expect(server.runtime.layout.getState().viewer?.read).toEqual({
      kind: 'image',
      absolutePath: '/real/demo/file',
    });
  });

  it('shows HTML in a frame without an origin, and without scripts while the setting is off', async () => {
    const html = '<!doctype html><h1>Report</h1><script>alert(1)</script>';
    const server = fake(
      {
        'report.html': {
          kind: 'html',
          absolutePath: '/real/demo/file',
          size: html.length,
          text: html,
        },
      },
      { viewer: 'report.html' },
    );
    await renderApp(route, server.runtime);
    const frame = await within(await viewer()).findByTitle('report.html');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    const page = frame.getAttribute('srcdoc') ?? '';
    expect(page).toContain("default-src 'none'");
    expect(page).not.toContain('script-src');
    expect(page).toContain('<h1>Report</h1>');
  });

  it('lets the scripts of an HTML file run while viewer.htmlScripts is on, still without an origin', async () => {
    const server = fake(
      {
        'report.html': {
          kind: 'html',
          absolutePath: '/real/demo/file',
          size: 40,
          text: '<h1>Report</h1><script>start()</script>',
        },
      },
      { viewer: 'report.html', settings: { 'viewer.htmlScripts': true } },
    );
    await renderApp(route, server.runtime);
    const frame = await within(await viewer()).findByTitle('report.html');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const page = frame.getAttribute('srcdoc') ?? '';
    expect(page).toMatch(/script-src 'sha256-[A-Za-z0-9+/]{43}=';/);
    expect(page).not.toContain("script-src 'unsafe-inline'");
    expect(page).toContain("default-src 'none'");
    expect(page).toContain('<h1>Report</h1>');
  });

  it('shows any other text as code', async () => {
    const server = fake(
      {
        'checks.json': {
          kind: 'text',
          absolutePath: '/real/demo/file',
          size: 14,
          text: '{"passed": 12}',
        },
      },
      { viewer: 'checks.json' },
    );
    await renderApp(route, server.runtime);
    const code = await within(await viewer()).findByTestId('viewer-text');
    expect(code.textContent).toContain('{"passed": 12}');
    expect(screen.getByText('Text · 14 bytes')).toBeTruthy();
  });

  it.each([
    ['outside', 'Outside the run’s folders', '../x is outside the folders, so it was not read.'],
    ['missing', 'File not found', 'There is no file gone.md.'],
    ['not_a_file', 'Not a file', 'review is a folder, not a file.'],
    ['binary', 'Not shown: binary file', 'data.bin is a binary file, so it is not shown.'],
    ['too_large', 'Not shown: file too large', 'big.log is 3 MB, more than the 2 MB shown.'],
  ] as const)('says why a file was not read: %s', async (reason, title, message) => {
    const server = fake({ x: { kind: 'refused', reason, message } }, { viewer: 'x' });
    await renderApp(route, server.runtime);
    const shown = await viewer();
    expect(await within(shown).findByRole('heading', { name: title })).toBeTruthy();
    expect(within(shown).getByTestId('viewer-refusal').textContent).toBe(message);
    // The header stays, so the path can be copied and the conversation is one press away.
    expect(within(shown).getByRole('button', { name: 'Back to conversation' })).toBeTruthy();
    expect(within(shown).getByRole('button', { name: 'Copy path' })).toBeTruthy();
    expect(within(shown).queryByRole('link', { name: 'Open Viewer settings' }) !== null).toBe(
      reason === 'too_large',
    );
  });

  it('says it is reading until the server answers, and says when the read failed', async () => {
    const waiting = fake({ 'slow.md': 'never' }, { viewer: 'slow.md' });
    const first = await renderApp(route, waiting.runtime);
    expect(within(await viewer()).getByRole('status', { name: 'Reading the file' })).toBeTruthy();
    first.unmount();

    const failing = fake({ 'gone.md': new Error('No run run-1') }, { viewer: 'gone.md' });
    await renderApp(route, failing.runtime);
    const shown = await viewer();
    expect(
      await within(shown).findByRole('heading', { name: 'The file could not be read' }),
    ).toBeTruthy();
    expect(within(shown).getByText('No run run-1')).toBeTruthy();
  });

  it('says so when no server is connected', async () => {
    const { runtime } = fake({}, { viewer: 'a.md' });
    await renderApp(route, { ...runtime, connection: undefined });
    expect(within(await viewer()).getByText('Not connected to the wow server')).toBeTruthy();
  });

  it('belongs to the view it was opened on', () => {
    const file = fileAt('a.md');
    expect(shownFile(file, route)).toBe(file);
    expect(shownFile(file, '/calendar')).toBeUndefined();
    expect(shownFile(undefined, route)).toBeUndefined();
  });
});

const titles = (file: ViewerFile | undefined, openRun: WorkflowRun | undefined = run) =>
  viewerCommands({ viewer: file, pathname: route, openRun, projects: [project] }).map(
    (command) => command.title,
  );

describe('viewer commands', () => {
  it('lists every artifact of the open run, and the open file’s actions only while it shows', () => {
    expect(titles(undefined)).toEqual([
      'Open artifact: review/notes.md',
      'Open artifact: review/screen.png',
    ]);
    expect(
      viewerCommands({ viewer: undefined, pathname: route, openRun: undefined, projects: [] }),
    ).toEqual([]);
    const actions = ['Back to conversation', 'Copy file path'];
    expect(titles(fileAt('review/notes.md')).slice(2)).toEqual(actions);
    // The size switch is for a file the server read as a picture, not for one named like one.
    expect(titles(fileAt('review/screen.png')).slice(2)).toEqual(actions);
    const markdown = { kind: 'markdown', absolutePath: '/real/demo/notes.md' } as const;
    expect(titles({ ...fileAt('review/notes.md'), read: markdown }).slice(2)).toEqual(actions);
    const picture = { kind: 'image', absolutePath: '/real/demo/screen.png' } as const;
    expect(titles({ ...fileAt('review/screen.png'), read: picture }).slice(2)).toEqual([
      ...actions,
      'Show picture at full size',
    ]);
    expect(titles({ ...fileAt('review/screen.png'), read: picture, fullSize: true }).at(-1)).toBe(
      'Fit picture to panel',
    );
    expect(titles(fileAt('review/notes.md', '/calendar'))).toHaveLength(2);
  });

  it('copies the path the server resolved, and the named path until it has answered', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: { writeText: (text: string) => (copied.push(text), Promise.resolve()) },
    });
    const file = fileAt('review/notes.md');
    const resolved = { kind: 'markdown', absolutePath: '/real/demo/review/notes.md' } as const;
    for (const shown of [file, { ...file, read: resolved }]) {
      await viewerCommands({ viewer: shown, pathname: route, openRun: run, projects: [project] })
        .find((command) => command.id === 'viewer.copyPath')
        ?.run(undefined as never);
    }
    copyFilePath({ ...file, read: resolved });
    vi.unstubAllGlobals();
    expect(copied).toEqual([
      '/home/me/demo/review/notes.md',
      '/real/demo/review/notes.md',
      '/real/demo/review/notes.md',
    ]);
  });
});

describe('frame document', () => {
  it('puts a policy that allows no network before everything the file brings', () => {
    const page = frameDocument('<html><head><title>x</title></head><body>hi</body></html>');
    expect(page.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("form-action 'none'");
    expect(page).toContain("base-uri 'none'");
    expect(page).toContain('<base target="_blank">');
    expect(page).not.toMatch(/https?:/);
    expect(page).not.toContain('script-src');
  });

  it('keeps a doctype first, so the page is not laid out in quirks mode', () => {
    const page = frameDocument('\n<!DOCTYPE html>\n<p>hi</p>');
    expect(page.startsWith('\n<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(page.endsWith('\n<p>hi</p>')).toBe(true);
  });

  it('with scripts on, allows only the file’s own scripts, each closing WebRTC first', async () => {
    const page = await scriptedFrameDocument(
      [
        '<!doctype html><title>x</title>',
        '<script>one()</script>',
        '<script src="https://invented.example/far.js"></script>',
        '<button onclick="two()">Go</button>',
        '<script type="module">three()</script>',
      ].join(''),
    );
    expect(page.startsWith('<!doctype html><html><head><meta http-equiv=')).toBe(true);
    expect(page).toContain("default-src 'none'");
    expect(page).toContain('<base target="_blank">');
    // No inline script without its hash: nothing in an attribute, in a nested frame's own
    // markup or behind a javascript: address runs.
    const policy = /content="([^"]*)"/.exec(page)?.[1] ?? '';
    const sources = /script-src ([^;]*);/.exec(policy)?.[1]?.split(' ') ?? [];
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    expect(sources).toHaveLength(2);
    const parsed = new DOMParser().parseFromString(page, 'text/html');
    const inline = [...parsed.querySelectorAll('script:not([src])')].map(
      (script) => script.textContent ?? '',
    );
    expect(inline).toHaveLength(2);
    for (const [index, text] of inline.entries()) {
      expect(text).toMatch(
        /^for\(const name of Object\.getOwnPropertyNames\(globalThis\)\)if\(.*RTC/,
      );
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      expect(sources[index]).toBe(
        `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`,
      );
    }
    expect(inline[0]?.endsWith('\none()')).toBe(true);
    expect(inline[1]?.endsWith('\nthree()')).toBe(true);
  });

  it('with scripts on, leaves a script element that holds data as it is', async () => {
    const page = await scriptedFrameDocument(
      '<script type="application/json" id="data">{"a":1}</script><script>read()</script>',
    );
    expect(page).toContain('<script type="application/json" id="data">{"a":1}</script>');
    expect(/script-src ([^;]*);/.exec(page)?.[1]?.split(' ')).toHaveLength(1);
  });

  it('with scripts on and no script in the file, allows none', async () => {
    const page = await scriptedFrameDocument('<p onclick="go()">hi</p>');
    expect(page).toContain("script-src 'none';");
    expect(page.startsWith('<html><head><meta')).toBe(true);
  });
});

describe('viewer helpers', () => {
  it('takes the language from the extension', () => {
    expect(fileLanguage('src/app/main.TS')).toBe('ts');
    expect(fileLanguage('review/build.log')).toBe('log');
    expect(fileLanguage('Makefile')).toBeUndefined();
    expect(fileLanguage('a.b/.gitignore')).toBeUndefined();
  });

  it('writes sizes the way people read them', () => {
    expect(formatBytes(332)).toBe('332 bytes');
    expect(formatBytes(1200)).toBe('1.2 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
  });
});
