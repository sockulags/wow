import type {
  CalendarItem,
  Thread,
  Trigger,
  UpdateState,
  Workflow,
  WorkflowRun,
} from '@wow/contracts';
import {
  desktopSettingKeys,
  readDesktopSettings,
  type DesktopSettings,
} from './desktop-settings.js';
import { runNotices, runStates, type Notice, type RunStates } from './notifications.js';
import type { RpcClient } from './rpc-client.js';
import type { ServerEndpoint, ServerProcess } from './server-process.js';
import {
  trayMenu,
  traySummary,
  trayTooltip,
  type TrayAction,
  type TrayEntry,
} from './tray-menu.js';
import { restartWarning, UpdateManager, type Updater, type UpdateTimers } from './updates.js';

// What the controller needs from Electron. `main/index.ts` implements it with BrowserWindow, Tray,
// Notification and app; tests implement it with plain objects.
export interface DesktopShell {
  // Shows the window, creating it for this endpoint if needed, and loads `path` when given.
  openWindow(endpoint: ServerEndpoint, path: string | undefined): void;
  // Destroys the window, for example because the server it was connected to is gone.
  closeWindow(): void;
  setTray(entries: TrayEntry[], tooltip: string): void;
  notify(notice: Notice, onClick: () => void): void;
  setLoginItem(openAtLogin: boolean): void;
  askRestart(message: string): Promise<boolean>;
  // Hands the update state to the web app (the preload bridge).
  setUpdateState(state: UpdateState): void;
  // Asks whether to restart for the update although work is running; true means restart.
  confirmUpdateRestart(message: string): Promise<boolean>;
  exit(code: number): void;
  log(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void;
}

export interface ControllerOptions {
  readonly shell: DesktopShell;
  readonly startServer: () => Promise<ServerProcess>;
  readonly connect: (endpoint: ServerEndpoint) => Promise<RpcClient>;
  readonly newCommandId: () => string;
  // Started by the login item: open in the tray whatever startMinimized says.
  readonly launchedHidden: boolean;
  // The clock and local time format for the tray's "Next: … at 16:30"; tests pass fixed ones.
  readonly now?: () => Date;
  readonly formatTime?: (instant: Date) => string;
  // Auto-update, only in a packaged build: without it nothing checks, downloads or installs.
  readonly updates?: {
    readonly updater: Updater;
    readonly currentVersion: string;
    readonly timers: UpdateTimers;
    readonly now: () => Date;
  };
}

export type CloseDecision = 'hide' | 'close';

export const newThreadPath = '/chat?new=1';
const localTime = (instant: Date) =>
  instant.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
export const updatesPath = '/settings/updates';

// The desktop's main-process logic: owns the server child, follows the settings it acts on, and
// turns tray, window and run events into calls on the shell. All state shown to the user comes
// from the server; the controller keeps only what it needs to act (the resolved settings and the
// previous run states to tell what changed).
export class DesktopController {
  readonly #options: ControllerOptions;
  #server: ServerProcess | undefined;
  #client: RpcClient | undefined;
  #settings: DesktopSettings | undefined;
  #settingsRead = 0;
  #loginItem: boolean | undefined;
  #workflows: readonly Workflow[] = [];
  #runStates: RunStates | undefined;
  #runs: readonly WorkflowRun[] = [];
  #threads: readonly Thread[] = [];
  #triggers: readonly Trigger[] = [];
  #items: readonly CalendarItem[] = [];
  #quitting: Promise<void> | undefined;
  readonly #updates: UpdateManager | undefined;
  #installing = false;

  constructor(options: ControllerOptions) {
    this.#options = options;
    const updates = options.updates;
    this.#updates =
      updates === undefined
        ? undefined
        : new UpdateManager({
            ...updates,
            onState: (state, previous) => this.#updateChanged(state, previous),
          });
  }

  get settings(): DesktopSettings | undefined {
    return this.#settings;
  }

  get server(): ServerProcess | undefined {
    return this.#server;
  }

  // Undefined in an unpackaged build, where updates do not run.
  get updateState(): UpdateState | undefined {
    return this.#updates?.state;
  }

  // True once "Restart to update" has stopped the server and handed over to the installer, which
  // quits the app itself.
  get installingUpdate(): boolean {
    return this.#installing;
  }

  async start(): Promise<void> {
    this.#renderTray();
    await this.#launch();
    const settings = this.#settings;
    if (!this.#options.launchedHidden && settings !== undefined && !settings.startMinimized)
      this.open();
  }

  open(path?: string): void {
    const server = this.#server;
    if (server === undefined || this.#quitting !== undefined) return;
    this.#options.shell.openWindow(server.endpoint, path);
  }

  // The window's close button. Behavior 34: with close-to-tray the window hides and the server,
  // with its scheduler, keeps running.
  windowClosing(): CloseDecision {
    if (this.#quitting !== undefined) return 'close';
    if (this.#settings?.closeToTray ?? true) return 'hide';
    void this.quit();
    return 'close';
  }

  trayAction(action: TrayAction): void {
    switch (action) {
      case 'open':
        this.open();
        return;
      case 'openChat':
        this.open('/chat');
        return;
      case 'openCalendar':
        this.open('/calendar');
        return;
      case 'newThread':
        this.open(newThreadPath);
        return;
      case 'toggleScheduler':
        void this.toggleScheduler();
        return;
      case 'installUpdate':
        void this.installUpdate();
        return;
      case 'quit':
        void this.quit();
        return;
    }
  }

  async toggleScheduler(): Promise<void> {
    const client = this.#client;
    const settings = this.#settings;
    if (client === undefined || settings === undefined) return;
    try {
      await client.request('dispatch', {
        commandId: this.#options.newCommandId(),
        command: {
          type: 'setting.set',
          key: desktopSettingKeys.schedulerPaused,
          scope: 'global',
          value: !settings.schedulerPaused,
        },
      });
    } catch (error) {
      this.#options.shell.log('error', 'could not change scheduler.paused', error);
    }
  }

  // The palette's "Check for updates".
  checkForUpdates(): Promise<void> {
    return this.#updates?.check() ?? Promise.resolve();
  }

  // "Restart to update" from the web app or the tray: says so when work is running and lets the
  // user decide, stops the server through the normal lifecycle, then lets the installer quit the
  // app. If the installer cannot start, the server starts again and the error is shown.
  async installUpdate(): Promise<void> {
    const updates = this.#updates;
    if (updates?.state.status !== 'ready' || this.#quitting !== undefined) return;
    const warning = restartWarning(this.#threads, this.#runs);
    if (warning !== undefined && !(await this.#options.shell.confirmUpdateRestart(warning))) return;
    if (this.#quitting !== undefined) return;
    this.#installing = true;
    this.#quitting = (async () => {
      await this.#stopServer();
      try {
        updates.install();
      } catch (error) {
        updates.fail(error);
      }
    })();
    await this.#quitting;
  }

  quit(): Promise<void> {
    this.#quitting ??= (async () => {
      this.#updates?.stop();
      await this.#stopServer();
      this.#options.shell.exit(0);
    })();
    return this.#quitting;
  }

  async #stopServer(): Promise<void> {
    this.#renderTray();
    this.#client?.close();
    this.#client = undefined;
    try {
      await this.#server?.stop();
    } catch (error) {
      this.#options.shell.log('error', 'server did not stop cleanly', error);
    }
    this.#server = undefined;
  }

  async #launch(): Promise<void> {
    const server = await this.#options.startServer();
    this.#server = server;
    server.onUnexpectedExit((code) => {
      void this.#serverLost(`The wow server stopped unexpectedly (exit code ${code ?? 'none'}).`);
    });
    try {
      const client = await this.#options.connect(server.endpoint);
      this.#client = client;
      let initial = true;
      await client.subscribe('settings', () => {
        if (!initial) void this.#readSettings(client);
      });
      initial = false;
      await this.#readSettings(client);
      await client.subscribe('workflows', (rows) => {
        this.#workflows = rows;
      });
      await client.subscribe('workflowRuns', (rows) => {
        this.#runsChanged(rows);
        this.#renderTray();
      });
      await client.subscribe('threads', (rows) => {
        this.#threads = rows;
        this.#renderTray();
      });
      await client.subscribe('triggers', (rows) => {
        this.#triggers = rows;
        this.#renderTray();
      });
      await client.subscribe('calendarItems', (rows) => {
        this.#items = rows;
        this.#renderTray();
      });
    } catch (error) {
      this.#client?.close();
      this.#client = undefined;
      this.#server = undefined;
      await server.stop();
      throw error;
    }
    this.#renderTray();
  }

  async #readSettings(client: RpcClient): Promise<void> {
    const read = ++this.#settingsRead;
    let settings: DesktopSettings;
    try {
      settings = readDesktopSettings(await client.request('settings.resolve', {}));
    } catch (error) {
      this.#options.shell.log('warn', 'could not read settings', error);
      return;
    }
    // A slower earlier read must not overwrite a newer one.
    if (read !== this.#settingsRead) return;
    this.#settings = settings;
    if (this.#loginItem !== settings.autostart) {
      this.#loginItem = settings.autostart;
      this.#options.shell.setLoginItem(settings.autostart);
    }
    if (this.#quitting === undefined)
      this.#updates?.configure(settings.updatesEnabled, settings.updateCheckIntervalMinutes);
    this.#renderTray();
  }

  #runsChanged(runs: readonly WorkflowRun[]): void {
    this.#runs = runs;
    const notices = runNotices(this.#runStates, runs, this.#workflows);
    this.#runStates = runStates(runs);
    if (!(this.#settings?.notifications ?? false)) return;
    for (const notice of notices) this.#options.shell.notify(notice, () => this.open(notice.path));
  }

  async #serverLost(message: string): Promise<void> {
    if (this.#quitting !== undefined) return;
    this.#options.shell.log('error', message);
    this.#client?.close();
    this.#client = undefined;
    this.#server = undefined;
    this.#runStates = undefined;
    this.#options.shell.closeWindow();
    this.#renderTray();
    if (!(await this.#options.shell.askRestart(message))) {
      await this.quit();
      return;
    }
    try {
      await this.#launch();
      this.open();
    } catch (error) {
      this.#options.shell.log('error', 'server restart failed', error);
      await this.quit();
    }
  }

  #updateChanged(state: UpdateState, previous: UpdateState): void {
    this.#options.shell.setUpdateState(state);
    this.#renderTray();
    if (state.status === 'ready' && previous.status !== 'ready')
      this.#options.shell.notify(
        {
          title: state.version === null ? 'An update is ready' : `wow ${state.version} is ready`,
          body: 'Restart to update. Your data stays as it is.',
          path: updatesPath,
        },
        () => this.open(updatesPath),
      );
    if (state.status === 'error' && this.#installing) void this.#installFailed(state.error);
  }

  // The installer did not take over: the app is still here without its server.
  async #installFailed(message: string | null): Promise<void> {
    this.#options.shell.log('error', `update install failed: ${message ?? 'unknown error'}`);
    await this.#quitting;
    this.#installing = false;
    this.#quitting = undefined;
    this.#runStates = undefined;
    try {
      await this.#launch();
      this.open(updatesPath);
    } catch (error) {
      this.#options.shell.log('error', 'server restart after a failed update failed', error);
      await this.quit();
    }
  }

  #renderTray(): void {
    const update = this.#updates?.state;
    const serverReady = this.#client !== undefined && this.#quitting === undefined;
    const state = {
      serverReady,
      schedulerPaused: this.#settings?.schedulerPaused ?? false,
      updateReady: update?.status === 'ready' ? (update.version ?? '') : undefined,
      ...(serverReady
        ? traySummary(
            this.#threads,
            this.#runs,
            this.#triggers,
            this.#items,
            (this.#options.now ?? (() => new Date()))(),
            this.#options.formatTime ?? localTime,
          )
        : {}),
    };
    this.#options.shell.setTray(trayMenu(state), trayTooltip(state));
  }
}
