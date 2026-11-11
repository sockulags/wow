import { SetupRead, SetupSaved, type SetupApplication } from '@wow/contracts';
import { dispatch, type Connection } from '@wow/client-runtime';
import { createStore } from 'zustand';
import type { AppCommand, CommandContext } from '@/app/commands';
import { errorMessage } from '@/chat/data';
import { notify } from '@/lib/feedback';

// "Save setup to a file" and "Start from a setup file" (app assistant spec 21, 22). The server
// writes and reads the file's text; the app only hands it to the user as a file and back. What
// is applied, and whether it was undone, comes from the `setupApplications` topic.

// A file the user picked, while its preview is open.
export interface SetupDraft {
  readonly name: string;
  readonly text: string;
  readonly read: SetupRead;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export interface SetupState {
  readonly draft: SetupDraft | undefined;
  // "Start from a setup file" was asked for from the palette; Settings → Advanced opens the
  // file picker once it shows.
  readonly pickWanted: boolean;
}

export const setupStore = createStore<SetupState>(() => ({ draft: undefined, pickWanted: false }));

// Hands the text to the browser as a download; the desktop app asks where to save it.
function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export async function saveSetupFile(connection: Connection): Promise<SetupSaved> {
  const saved = SetupSaved.parse(await connection.request('setup.save', {}));
  download(saved.fileName, saved.text);
  const left = saved.leftOut.map(({ what, reason }) => `${what} (${reason})`);
  notify.success(`Saved ${saved.fileName}`, {
    description: [
      saved.toFillIn.length > 0
        ? `${saved.toFillIn.length} ${saved.toFillIn.length === 1 ? 'secret is' : 'secrets are'} listed to fill in, without the value.`
        : 'No secret is in it.',
      left.length > 0 ? `Left out: ${left.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  });
  return saved;
}

export async function readSetupFile(
  connection: Connection,
  file: { readonly name: string; text(): Promise<string> },
): Promise<void> {
  const text = await file.text();
  const read = SetupRead.parse(await connection.request('setup.preview', { text }));
  setupStore.setState({ draft: { name: file.name, text, read, busy: false, error: undefined } });
}

export const cancelSetup = (): void => setupStore.setState({ draft: undefined });

// Nothing to apply: the file holds what this install already has.
export const setupIsEmpty = (read: SetupRead): boolean =>
  read.outcome === 'ready' && read.preview.added.length === 0 && read.preview.replaced.length === 0;

export async function confirmSetup(connection: Connection): Promise<void> {
  const draft = setupStore.getState().draft;
  if (!draft || draft.read.outcome !== 'ready' || draft.busy) return;
  setupStore.setState({ draft: { ...draft, busy: true, error: undefined } });
  try {
    await dispatch(connection, {
      type: 'setup.apply',
      applicationId: globalThis.crypto.randomUUID(),
      name: draft.name,
      text: draft.text,
    });
    setupStore.setState({ draft: undefined });
    notify.success(`Applied ${draft.name}`, {
      description: 'Undo it in Settings → Advanced or from the palette.',
    });
  } catch (error) {
    setupStore.setState({ draft: { ...draft, busy: false, error: errorMessage(error) } });
  }
}

export const undoSetup = (connection: Connection, application: SetupApplication) =>
  dispatch(connection, { type: 'setup.undo', applicationId: application.id });

export function askForSetupFile({ navigate }: CommandContext): void {
  setupStore.setState({ pickWanted: true });
  void navigate({ to: '/settings/$group', params: { group: 'advanced' } });
}

// Palette commands: save, start from a file, and Undo for the newest applied file (older ones
// when searched for).
export function setupCommands(applications: readonly SetupApplication[]): AppCommand[] {
  const applied = applications.filter((application) => application.state === 'applied');
  return [
    {
      id: 'setup.save',
      title: 'Save setup to a file',
      group: 'Settings',
      keywords: ['setup', 'export', 'share', 'yaml', 'colleague'],
      run: ({ connection }) => {
        if (!connection) return;
        saveSetupFile(connection).catch((error: unknown) =>
          notify.error('The setup was not saved', { description: errorMessage(error) }),
        );
      },
    },
    {
      id: 'setup.start',
      title: 'Start from a setup file',
      group: 'Settings',
      keywords: ['setup', 'import', 'open', 'yaml', 'colleague'],
      run: askForSetupFile,
    },
    ...applied.map((application, index): AppCommand => ({
      id: `setup.undo.${application.id}`,
      title: `Undo setup from ${application.name}`,
      group: 'Settings',
      keywords: ['setup', 'revert', 'undo'],
      detail: 'Setup file',
      searchOnly: index !== applied.length - 1,
      run: ({ connection }) => {
        if (!connection) return;
        undoSetup(connection, application).catch((error: unknown) =>
          notify.error(`The setup from ${application.name} was not undone`, {
            description: errorMessage(error),
          }),
        );
      },
    })),
  ];
}
