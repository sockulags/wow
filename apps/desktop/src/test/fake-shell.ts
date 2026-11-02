import type { UpdateState } from '@wow/contracts';
import { EventEmitter } from 'node:events';
import type { DesktopShell } from '../main/controller.js';
import type { Notice } from '../main/notifications.js';
import type { ServerEndpoint } from '../main/server-process.js';
import type { TrayEntry } from '../main/tray-menu.js';

export type ShellCall =
  | { readonly kind: 'openWindow'; readonly endpoint: ServerEndpoint; readonly path?: string }
  | { readonly kind: 'closeWindow' }
  | { readonly kind: 'setTray'; readonly entries: TrayEntry[]; readonly tooltip: string }
  | { readonly kind: 'notify'; readonly notice: Notice; readonly click: () => void }
  | { readonly kind: 'setLoginItem'; readonly openAtLogin: boolean }
  | { readonly kind: 'askRestart'; readonly message: string }
  | { readonly kind: 'setUpdateState'; readonly state: UpdateState }
  | { readonly kind: 'confirmUpdateRestart'; readonly message: string }
  | { readonly kind: 'exit'; readonly code: number };

// Records what the controller asks of Electron, and lets a test wait for a call without polling.
export class FakeShell implements DesktopShell {
  readonly calls: ShellCall[] = [];
  readonly logs: string[] = [];
  restartAnswer = false;
  updateRestartAnswer = true;
  readonly #events = new EventEmitter();

  waitFor<K extends ShellCall['kind']>(
    kind: K,
    matches: (call: Extract<ShellCall, { kind: K }>) => boolean = () => true,
    after = 0,
  ): Promise<Extract<ShellCall, { kind: K }>> {
    const test = (call: ShellCall): call is Extract<ShellCall, { kind: K }> =>
      call.kind === kind && matches(call as Extract<ShellCall, { kind: K }>);
    const found = this.calls.slice(after).find(test);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve) => {
      const listener = (call: ShellCall) => {
        if (!test(call)) return;
        this.#events.off('call', listener);
        resolve(call);
      };
      this.#events.on('call', listener);
    });
  }

  last<K extends ShellCall['kind']>(kind: K): Extract<ShellCall, { kind: K }> | undefined {
    return this.calls.findLast(
      (call): call is Extract<ShellCall, { kind: K }> => call.kind === kind,
    );
  }

  openWindow(endpoint: ServerEndpoint, path: string | undefined): void {
    this.#record(
      path === undefined
        ? { kind: 'openWindow', endpoint }
        : { kind: 'openWindow', endpoint, path },
    );
  }
  closeWindow(): void {
    this.#record({ kind: 'closeWindow' });
  }
  setTray(entries: TrayEntry[], tooltip: string): void {
    this.#record({ kind: 'setTray', entries, tooltip });
  }
  notify(notice: Notice, onClick: () => void): void {
    this.#record({ kind: 'notify', notice, click: onClick });
  }
  setLoginItem(openAtLogin: boolean): void {
    this.#record({ kind: 'setLoginItem', openAtLogin });
  }
  askRestart(message: string): Promise<boolean> {
    this.#record({ kind: 'askRestart', message });
    return Promise.resolve(this.restartAnswer);
  }
  setUpdateState(state: UpdateState): void {
    this.#record({ kind: 'setUpdateState', state });
  }
  confirmUpdateRestart(message: string): Promise<boolean> {
    this.#record({ kind: 'confirmUpdateRestart', message });
    return Promise.resolve(this.updateRestartAnswer);
  }
  exit(code: number): void {
    this.#record({ kind: 'exit', code });
  }
  log(level: string, message: string): void {
    this.logs.push(`${level} ${message}`);
  }

  #record(call: ShellCall): void {
    this.calls.push(call);
    this.#events.emit('call', call);
  }
}

export const trayLabels = (call: { readonly entries: TrayEntry[] } | undefined): string[] =>
  (call?.entries ?? []).flatMap((entry) =>
    entry.kind === 'item' ? [`${entry.label}${entry.enabled ? '' : ' (disabled)'}`] : [],
  );
