import {
  RpcResponse,
  assistantThreadId,
  type DomainEventKind,
  type ProviderCommand,
  type ServerCommand,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter, mockCodexModels } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import { threadImageFolder, threadImageFolderName } from './images.js';

// Agent workbench spec 53 to 55 and 61: images go to the server once, are stored under wow's home
// per thread, are refused with a reason, and reach the thread's provider as files.

let root: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
let next = 0;

// Invented pictures: the first bytes are what tells a type, the rest is padding.
const png = (size = 64) => {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
};
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const bmp = () => Buffer.concat([Buffer.from('BM'), Buffer.alloc(40, 1)]);

async function rpc(method: string, params: unknown): Promise<RpcResponse> {
  const socket = new WebSocket(server.url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const answer = new Promise<RpcResponse>((resolve) =>
    socket.once('message', (raw) => resolve(RpcResponse.parse(JSON.parse(String(raw))))),
  );
  socket.send(JSON.stringify({ id: '1', method, params }));
  const response = await answer;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
  return response;
}

const resultOf = <T>(response: RpcResponse): T => {
  if ('error' in response) throw new Error(response.error.message);
  return response.result as T;
};

const errorOf = (response: RpcResponse) => ('error' in response ? response.error : undefined);

const dispatch = (command: ServerCommand) => server.engine.dispatch(`c${(next += 1)}`, command);

const committed = (kind: DomainEventKind) =>
  new Promise<void>((resolve) => {
    const off = server.engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === kind)) {
        off();
        resolve();
      }
    });
  });

const put = (threadId: string, bytes: Buffer, extra: Record<string, unknown> = {}) =>
  rpc('attachments.put', {
    threadId,
    base64: bytes.toString('base64'),
    type: 'image/png',
    ...extra,
  });

const startTurns = () =>
  adapters.flatMap((adapter) =>
    adapter.sent.filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn',
    ),
  );

function instance(id: string, kind: 'claude' | 'codex') {
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: id,
    kind,
    name: id,
    binaryPath: kind,
    configDir: '',
    env: {},
    launchArgs: [],
  });
}

function thread(threadId: string, providerInstanceId: string, model: string) {
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId,
    cwd: path.join(root, 'tea'),
    model,
    effort: 'low',
    permissionMode: 'default',
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow images '));
  adapters = [];
  server = await startServer({
    home: path.join(root, 'wow home'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind);
          adapters.push(adapter);
          return adapter;
        },
        codex: (row) => {
          const adapter = new MockProviderAdapter(row.kind, undefined, undefined, () => [
            ...mockCodexModels,
          ]);
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  instance('claude', 'claude');
  instance('codex', 'codex');
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('images in the composer', () => {
  it('stores images under wow home for the thread and hands them to the provider @agent-workbench-53 @agent-workbench-55', async () => {
    thread('t1', 'claude', 'mock-model');
    const first = resultOf<{ id: string; mediaType: string; bytes: number }>(
      await put('t1', png()),
    );
    const second = resultOf<{ id: string; mediaType: string }>(
      await put('t1', jpeg(), { type: 'image/jpeg', name: 'kettle.jpg' }),
    );
    expect(first).toMatchObject({ mediaType: 'image/png', bytes: 64 });
    expect(second).toMatchObject({ mediaType: 'image/jpeg', name: 'kettle.jpg' });
    expect(second.id).toMatch(/\.jpg$/u);

    const folder = path.join(server.home, 'images', 't1');
    expect(threadImageFolder(server.home, 't1')).toBe(folder);
    expect(await readFile(path.join(folder, first.id))).toEqual(png());

    const ended = committed('turn.ended');
    expect(
      errorOf(
        await rpc('dispatch', {
          commandId: 'send-1',
          command: {
            type: 'thread.sendMessage',
            threadId: 't1',
            text: 'What is in these?',
            attachments: [{ id: first.id }, { id: second.id, name: 'kettle.jpg' }],
          },
        }),
      ),
    ).toBeUndefined();
    await ended;

    expect(startTurns()).toEqual([
      expect.objectContaining({
        prompt: 'What is in these?',
        images: [
          { path: path.join(folder, first.id), mediaType: 'image/png' },
          { path: path.join(folder, second.id), mediaType: 'image/jpeg' },
        ],
      }),
    ]);
    const items = snapshot(server.database.db, { topic: 'threadItems', threadId: 't1' }) as Array<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
    expect(items.find((item) => item.kind === 'user')?.payload).toEqual({
      text: 'What is in these?',
      images: [
        { id: first.id, mediaType: 'image/png' },
        { id: second.id, mediaType: 'image/jpeg', name: 'kettle.jpg' },
      ],
    });
    // The mock says how many it was handed.
    expect(JSON.stringify(items)).toContain('Received 2 images.');

    // Read back for the thread's display.
    expect(resultOf(await rpc('attachments.read', { threadId: 't1', id: first.id }))).toEqual({
      mediaType: 'image/png',
      base64: png().toString('base64'),
    });
  });

  it('refuses an image over the size limit, a BMP and a file that is no image @agent-workbench-54', async () => {
    thread('t1', 'claude', 'mock-model');
    dispatch({ type: 'setting.set', key: 'chat.imageMaxBytes', scope: 'global', value: 10_000 });
    expect(errorOf(await put('t1', png(20_000), { name: 'big.png' }))).toEqual({
      code: 'rejected',
      message:
        'big.png is 20 KB; images up to 10 KB can be sent (Settings → Chat, "Largest image").',
    });
    expect(errorOf(await put('t1', bmp(), { type: 'image/bmp', name: 'old.bmp' }))).toEqual({
      code: 'rejected',
      message: 'old.bmp is a BMP image. Only PNG, JPEG, GIF and WebP images can be sent.',
    });
    expect(errorOf(await put('t1', Buffer.from('<svg/>'), { type: 'image/svg+xml' }))).toEqual({
      code: 'rejected',
      message: 'This file is a SVG+XML image. Only PNG, JPEG, GIF and WebP images can be sent.',
    });
    expect(existsSync(path.join(server.home, 'images', 't1'))).toBe(false);
  });

  it('refuses images for a Codex model without image input and takes them for Claude @agent-workbench-54', async () => {
    thread('mini', 'codex', 'mock-codex-mini');
    thread('full', 'codex', 'mock-codex');
    thread('claude', 'claude', 'mock-model');
    expect(errorOf(await put('mini', png()))).toEqual({
      code: 'rejected',
      message:
        'Mock model for Codex, mini takes no images. Pick a model that does, or send the message without them.',
    });
    expect(errorOf(await put('full', png()))).toBeUndefined();
    // Claude Code does not say which models take images, so they are sent.
    expect(errorOf(await put('claude', png()))).toBeUndefined();
    // A new thread's composer names where the image will go.
    expect(
      errorOf(
        await put('not-yet', png(), { providerInstanceId: 'codex', model: 'mock-codex-mini' }),
      ),
    ).toMatchObject({ code: 'rejected' });
  });

  it('refuses the images at send when the model was changed to one without image input @agent-workbench-54', async () => {
    thread('full', 'codex', 'mock-codex');
    const image = resultOf<{ id: string }>(await put('full', png()));
    dispatch({ type: 'thread.configure', threadId: 'full', model: 'mock-codex-mini' });
    expect(
      errorOf(
        await rpc('dispatch', {
          commandId: 'send-after-switch',
          command: { type: 'thread.sendMessage', threadId: 'full', text: '', attachments: [image] },
        }),
      ),
    ).toEqual({
      code: 'rejected',
      message:
        'Mock model for Codex, mini takes no images. Pick a model that does, or send the message without them.',
    });
    expect(startTurns()).toEqual([]);
  });

  it('sends images to Codex as local files @agent-workbench-53', async () => {
    thread('full', 'codex', 'mock-codex');
    const image = resultOf<{ id: string }>(await put('full', png()));
    const ended = committed('turn.ended');
    await rpc('dispatch', {
      commandId: 'send-codex',
      command: { type: 'thread.sendMessage', threadId: 'full', text: '', attachments: [image] },
    });
    await ended;
    expect(startTurns()).toEqual([
      expect.objectContaining({
        prompt: '',
        images: [
          { path: path.join(server.home, 'images', 'full', image.id), mediaType: 'image/png' },
        ],
      }),
    ]);
  });

  it('refuses a message naming an image that is not stored for its thread', async () => {
    thread('t1', 'claude', 'mock-model');
    thread('t2', 'claude', 'mock-model');
    const image = resultOf<{ id: string }>(await put('t2', png()));
    expect(
      errorOf(
        await rpc('dispatch', {
          commandId: 'send-other',
          command: { type: 'thread.sendMessage', threadId: 't1', text: 'Hi', attachments: [image] },
        }),
      ),
    ).toEqual({
      code: 'rejected',
      message: 'An image of this message is no longer stored. Add it again.',
    });
    expect(startTurns()).toEqual([]);
  });

  it('takes no image for the assistant @agent-workbench-61', async () => {
    expect(errorOf(await put(assistantThreadId, png()))).toEqual({
      code: 'rejected',
      message: 'The assistant takes no images.',
    });
    dispatch({
      type: 'setting.set',
      key: 'assistant.providerInstanceId',
      scope: 'global',
      value: 'claude',
    });
    dispatch({
      type: 'providerInstance.recordTest',
      providerInstanceId: 'claude',
      result: { ok: true, account: 'mock', version: 'mock', message: null },
    });
    dispatch({ type: 'thread.openAssistant', fallbackModel: 'mock-model', fallbackEffort: 'low' });
    expect(() =>
      dispatch({
        type: 'thread.sendMessage',
        threadId: assistantThreadId,
        text: 'Look at this',
        attachments: [{ id: '0f8fad5b-d9cb-469f-a165-70867728950e.png' }],
      }),
    ).toThrow('The assistant takes no images');
  });

  it('keeps every thread id inside the images folder', () => {
    expect(threadImageFolderName('run-1:step:2')).toBe('run-1~3astep~3a2');
    expect(threadImageFolderName('../up')).toBe('~2e~2e~2fup');
    expect(path.dirname(threadImageFolder(server.home, '../../x'))).toBe(
      path.join(server.home, 'images'),
    );
  });
});
