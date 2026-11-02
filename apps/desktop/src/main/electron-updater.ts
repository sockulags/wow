import type { AppUpdater } from 'electron-updater';
import type { Updater, UpdaterEvent } from './updates.js';

// electron-updater behind the `Updater` seam. It reads `app-update.yml`, which electron-builder
// writes into the packaged resources from the `publish` block in electron-builder.yml (GitHub
// Releases of sockulags/wow), and fetches `latest.yml` from the newest stable release.
export function electronUpdater(
  updater: AppUpdater,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): Updater {
  updater.autoDownload = true;
  // Installing is the user's "Restart to update", after the server has stopped; never on a quit.
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.logger = {
    info: (message?: unknown) => log('info', `updater: ${String(message)}`),
    warn: (message?: unknown) => log('warn', `updater: ${String(message)}`),
    error: (message?: unknown) => log('error', `updater: ${String(message)}`),
  };
  return {
    async check() {
      await updater.checkForUpdates();
    },
    // Silent, because the user already chose to restart; run wow again when it is installed.
    quitAndInstall: () => updater.quitAndInstall(true, true),
    onEvent(listener: (event: UpdaterEvent) => void) {
      updater.on('checking-for-update', () => listener({ type: 'checking' }));
      updater.on('update-available', (info) =>
        listener({ type: 'available', version: info.version }),
      );
      updater.on('update-not-available', () => listener({ type: 'not-available' }));
      updater.on('download-progress', (progress) =>
        listener({ type: 'progress', percent: progress.percent }),
      );
      updater.on('update-downloaded', (info) =>
        listener({ type: 'downloaded', version: info.version }),
      );
      updater.on('error', (error) => listener({ type: 'error', message: error.message }));
    },
  };
}
