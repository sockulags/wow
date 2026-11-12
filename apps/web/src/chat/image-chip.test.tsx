import type { ProviderInstance, Thread, ThreadItem } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
  type SettingValues,
} from '@wow/client-runtime';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { createDraftStore } from './draft';
import { readDraft } from './drafts';
import { activeImageComposer, imageComposerCommands, imageComposerStore } from './image-commands';
import { ThreadConversation } from './thread-view';

// Agent workbench spec 53, 54 and 61: images pasted or dropped on the composer are chips, sent
// with the message and drawn on the user's message. The server side is in
// apps/server/src/files/images.test.ts, the whole flow in e2e/chat.spec.ts.

const thread: Thread = {
  id: 'thread-1',
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Kettle',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

const instance: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'sonnet',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const ids = [
  '0f8fad5b-d9cb-469f-a165-70867728950e.png',
  '7c9e6679-7425-40de-944b-e07fc1f90ae7.png',
  '9b2d1c3a-1f0e-4d2c-8b7a-6e5f4d3c2b1a.png',
];

// Invented pictures: only the type and the size matter to the composer.
const pngFile = (name: string, size = 64) =>
  new File([new Uint8Array(size).fill(7)], name, { type: 'image/png' });

function setup({
  assistant = false,
  shown = thread,
  items = [],
  settings = {},
  refuse,
  held,
  heldSends,
}: {
  assistant?: boolean;
  shown?: Thread;
  items?: ThreadItem[];
  settings?: SettingValues;
  // What the server answers to attachments.put instead of storing the image.
  refuse?: string;
  // Holds every put until the test answers it, to answer them out of order.
  held?: (() => void)[];
  // Holds every dispatch until the test answers it.
  heldSends?: (() => void)[];
} = {}) {
  let stored = 0;
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method, params) => {
    if (method === 'attachments.put') {
      if (refuse !== undefined) return Promise.reject(new Error(refuse));
      const { name } = params as { name?: string };
      const id = ids[stored] ?? ids[0];
      stored += 1;
      const answer = { id, mediaType: 'image/png', bytes: 64, ...(name ? { name } : {}) };
      if (held) return new Promise((resolve) => held.push(() => resolve(answer)));
      return Promise.resolve(answer);
    }
    if (method === 'attachments.read') {
      return Promise.resolve({ mediaType: 'image/png', base64: 'aW52ZW50ZWQ=' });
    }
    const accepted = {
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    };
    if (heldSends && method === 'dispatch') {
      return new Promise((resolve) => heldSends.push(() => resolve(accepted)));
    }
    return Promise.resolve(accepted);
  });
  const topics: Record<string, unknown> = { skills: [], turns: [], threadItems: items };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, settings)),
      }}
    >
      <ThreadConversation
        thread={shown}
        instance={instance}
        {...(assistant ? { extras: { placeholder: 'Message' } } : {})}
      />
    </RuntimeProvider>,
  );
  const box = screen.getByRole('combobox', { name: /message/i }) as HTMLTextAreaElement;
  const calls = (method: string) =>
    request.mock.calls.filter(([called]) => called === method).map(([, params]) => params);
  const sent = () => calls('dispatch').map((params) => (params as { command: unknown }).command);
  return { box, calls, sent, user: userEvent.setup() };
}

const chips = () => screen.queryAllByTestId('composer-image-chip');

// A paste and a drop as the browser fires them, with files on the event.
async function paste(target: HTMLElement, files: File[]) {
  await act(async () => {
    fireEvent.paste(target, { clipboardData: { files, types: ['Files'] } });
  });
}
async function drop(target: HTMLElement, files: File[]) {
  await act(async () => {
    fireEvent.dragOver(target, { dataTransfer: { files, types: ['Files'] } });
    fireEvent.drop(target, { dataTransfer: { files, types: ['Files'] } });
  });
}

describe('images in the composer (agent workbench spec 53)', () => {
  it('shows a pasted screenshot and a dropped PNG as two chips, Backspace takes the last off, a click shows it full size @agent-workbench-53', async () => {
    const { box, calls, user } = setup();
    await paste(box, [pngFile('image.png')]);
    await drop(box, [pngFile('kettle.png')]);
    expect(chips()).toHaveLength(2);
    // Each went to the server once, when it was added; a pasted screenshot has no name.
    expect(calls('attachments.put')).toEqual([
      { threadId: 'thread-1', base64: expect.any(String), type: 'image/png' },
      { threadId: 'thread-1', base64: expect.any(String), type: 'image/png', name: 'kettle.png' },
    ]);
    const list = screen.getByRole('list', { name: 'Images' });
    expect(within(list).getByRole('button', { name: 'Show Image 1 full size' })).toBeTruthy();

    await user.click(within(list).getByRole('button', { name: 'Show kettle.png full size' }));
    const dialog = await screen.findByRole('dialog', { name: 'kettle.png' });
    expect(within(dialog).getByTestId('image-full-size').getAttribute('src')).toBe(
      'data:image/png;base64,aW52ZW50ZWQ=',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    box.focus();
    box.setSelectionRange(0, 0);
    await user.keyboard('{Backspace}');
    expect(chips()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show Image 1 full size' })).toBeTruthy();
  });

  it('keeps the chips in the order they were added when the second upload answers first @agent-workbench-53', async () => {
    const held: (() => void)[] = [];
    const { box, user } = setup({ held });
    await paste(box, [pngFile('image.png')]);
    await drop(box, [pngFile('kettle.png')]);
    expect(held).toHaveLength(2);
    await act(async () => held[1]?.());
    await act(async () => held[0]?.());
    const list = screen.getByRole('list', { name: 'Images' });
    expect(
      within(list)
        .getAllByRole('button', { name: /full size/ })
        .map((chip) => chip.getAttribute('aria-label')),
    ).toEqual(['Show Image 1 full size', 'Show kettle.png full size']);
    box.focus();
    box.setSelectionRange(0, 0);
    await user.keyboard('{Backspace}');
    expect(screen.getByRole('button', { name: 'Show Image 1 full size' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show kettle.png full size' })).toBeNull();
  });

  it('leaves a paste that carries text to the text box, even with a picture beside it', async () => {
    const { box, calls } = setup();
    await act(async () => {
      fireEvent.paste(box, {
        clipboardData: {
          files: [pngFile('image.png')],
          types: ['text/plain', 'text/html', 'Files'],
          getData: (type: string) => (type === 'text/plain' ? 'Kettle\t2 l' : ''),
        },
      });
    });
    expect(chips()).toHaveLength(0);
    expect(calls('attachments.put')).toEqual([]);
  });

  it('steps onto a chip with the left arrow and takes it off with Delete', async () => {
    const { box, user } = setup();
    await paste(box, [pngFile('image.png')]);
    box.focus();
    box.setSelectionRange(0, 0);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Show Image 1 full size');
    await user.keyboard('{Delete}');
    expect(chips()).toHaveLength(0);
    expect(document.activeElement).toBe(box);
  });

  it('sends the images with the message by id and keeps them in the draft until then @agent-workbench-53', async () => {
    const { box, sent, user } = setup();
    await paste(box, [pngFile('image.png'), pngFile('kettle.png')]);
    expect(readDraft('thread-1').images).toEqual([
      { id: ids[0], mediaType: 'image/png' },
      { id: ids[1], mediaType: 'image/png', name: 'kettle.png' },
    ]);
    await user.type(box, 'What is wrong here?{Enter}');
    expect(sent()).toContainEqual({
      type: 'thread.sendMessage',
      threadId: 'thread-1',
      text: 'What is wrong here?',
      attachments: [{ id: ids[0] }, { id: ids[1], name: 'kettle.png' }],
    });
    expect(chips()).toHaveLength(0);
    expect(readDraft('thread-1').images).toBeUndefined();
  });

  it('keeps an image pasted while the message is on its way @agent-workbench-53', async () => {
    const heldSends: (() => void)[] = [];
    const { box, sent, user } = setup({ heldSends });
    await paste(box, [pngFile('image.png')]);
    await user.type(box, 'First{Enter}');
    expect(heldSends).toHaveLength(1);
    await paste(box, [pngFile('kettle.png')]);
    expect(chips()).toHaveLength(2);
    await act(async () => heldSends[0]?.());
    expect(sent()).toEqual([
      {
        type: 'thread.sendMessage',
        threadId: 'thread-1',
        text: 'First',
        attachments: [{ id: ids[0] }],
      },
    ]);
    const list = screen.getByRole('list', { name: 'Images' });
    expect(
      within(list)
        .getAllByRole('button', { name: /full size/ })
        .map((chip) => chip.getAttribute('aria-label')),
    ).toEqual(['Show kettle.png full size']);
    expect(readDraft('thread-1').images).toEqual([
      { id: ids[1], mediaType: 'image/png', name: 'kettle.png' },
    ]);
  });

  it("shows a sent message's images from the stored item, after a reload too @agent-workbench-53", async () => {
    const { user } = setup({
      items: [
        {
          id: 'item-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          index: 0,
          kind: 'user',
          payload: {
            text: 'What is wrong here?',
            images: [
              { id: ids[0], mediaType: 'image/png' },
              { id: ids[1], mediaType: 'image/png', name: 'kettle.png' },
            ],
          },
          streaming: false,
        },
      ],
    });
    const sentList = screen.getByRole('list', { name: 'Sent with images' });
    expect(within(sentList).getAllByTestId('sent-image')).toHaveLength(2);
    expect((await within(sentList).findByAltText('kettle.png')).getAttribute('src')).toBe(
      'data:image/png;base64,aW52ZW50ZWQ=',
    );
    await user.click(within(sentList).getByRole('button', { name: 'Show kettle.png full size' }));
    expect(await screen.findByRole('dialog', { name: 'kettle.png' })).toBeTruthy();
  });

  it('lists the palette commands for the images of the composer on screen', async () => {
    const { box } = setup();
    await paste(box, [pngFile('kettle.png')]);
    const titles = imageComposerCommands(activeImageComposer(imageComposerStore.getState())).map(
      (command) => command.title,
    );
    expect(titles).toEqual([
      'Add an image to the message…',
      'Show kettle.png full size',
      'Remove kettle.png from the message',
    ]);
    await act(async () => {
      imageComposerCommands(activeImageComposer(imageComposerStore.getState()))
        .find((command) => command.id === 'composer.removeImage.0')
        ?.run({} as never);
    });
    expect(chips()).toHaveLength(0);
  });
});

describe('images that are refused (agent workbench spec 54)', () => {
  it('refuses a BMP and an image over the limit with the reason, without sending them @agent-workbench-54', async () => {
    const { box, calls } = setup({ settings: { 'chat.imageMaxBytes': 10_000 } });
    await paste(box, [new File([new Uint8Array(40)], 'old.bmp', { type: 'image/bmp' })]);
    expect(screen.getByRole('alert').textContent).toBe(
      'old.bmp is a BMP image. Only PNG, JPEG, GIF and WebP images can be sent.',
    );
    await drop(box, [pngFile('big.png', 20_000)]);
    expect(screen.getByRole('alert').textContent).toBe(
      'big.png is 20 KB; images up to 10 KB can be sent (Settings → Chat, "Largest image").',
    );
    expect(calls('attachments.put')).toEqual([]);
    expect(chips()).toHaveLength(0);
  });

  it("shows the server's refusal for a model that takes no images and adds no chip @agent-workbench-54", async () => {
    const refusal =
      'Mock model for Codex, mini takes no images. Pick a model that does, or send the message without them.';
    const { box } = setup({ refuse: refusal });
    await paste(box, [pngFile('image.png')]);
    expect((await screen.findByRole('alert')).textContent).toBe(refusal);
    expect(chips()).toHaveLength(0);
  });
});

describe("the Assistant view's composer (agent workbench spec 61)", () => {
  it('takes no pasted or dropped image @agent-workbench-61', async () => {
    const { box, calls } = setup({ assistant: true });
    await paste(box, [pngFile('image.png')]);
    await drop(box, [pngFile('kettle.png')]);
    expect(calls('attachments.put')).toEqual([]);
    expect(chips()).toHaveLength(0);
    expect(activeImageComposer(imageComposerStore.getState())).toBeUndefined();
  });
});

describe("a workflow step's thread", () => {
  it('takes no pasted or dropped image, wherever it is shown', async () => {
    const { box, calls } = setup({ shown: { ...thread, runId: 'run-1', stepId: 'build' } });
    await paste(box, [pngFile('image.png')]);
    await drop(box, [pngFile('kettle.png')]);
    expect(calls('attachments.put')).toEqual([]);
    expect(chips()).toHaveLength(0);
    expect(activeImageComposer(imageComposerStore.getState())).toBeUndefined();
  });
});
