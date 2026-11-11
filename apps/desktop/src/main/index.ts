import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import electronUpdaterModule from 'electron-updater';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appId,
  appOrigin,
  appScheme,
  encodeServerInfoArg,
  appChannels,
  folderChannels,
  hiddenFlag,
  productName,
  updateChannels,
} from '../app.js';
import { applicationMenu } from './app-menu.js';
import { opensOutside, rendererFile } from './app-protocol.js';
import { DesktopController, type DesktopShell } from './controller.js';
import { electronUpdater } from './electron-updater.js';
import { serverStartTimeoutMs, serverStopTimeoutMs } from './limits.js';
import { RpcClient } from './rpc-client.js';
import { ServerProcess, wowHome, type ServerEndpoint } from './server-process.js';

// Electron entry. Everything with a decision in it lives in the controller and the modules next
// to this file; this file only connects them to Electron.

protocol.registerSchemesAsPrivileged([
  {
    scheme: appScheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

app.setName(productName);
if (process.platform === 'win32') app.setAppUserModelId(appId);

const appPath = app.getAppPath();
const outDir = path.join(appPath, 'out');
const rendererDir = path.join(outDir, 'renderer');
const preloadPath = path.join(outDir, 'preload', 'index.cjs');
const iconPath = path.join(outDir, 'assets', 'icon.png');
const trayIconPath = path.join(outDir, 'assets', 'tray.png');
// Packaged, the server lives outside app.asar (see electron-builder.yml) so PowerShell can run
// the Outlook bridge script from it.
const serverEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'server', 'server.mjs')
  : path.join(outDir, 'server', 'server.mjs');

const home = wowHome(process.env);
mkdirSync(home, { recursive: true, mode: 0o700 });
const logStream = createWriteStream(path.join(home, 'desktop.log'), { flags: 'a' });
const writeLog = (text: string) => {
  logStream.write(text);
  if (!app.isPackaged) process.stderr.write(text);
};

let window: BrowserWindow | undefined;
let windowEndpoint: ServerEndpoint | undefined;
let tray: Tray | undefined;
// Electron drops a notification's click handler when the object is collected.
const notifications = new Set<Notification>();

function createWindow(endpoint: ServerEndpoint): BrowserWindow {
  const created = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: productName,
    backgroundColor: '#0a0a0a',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [encodeServerInfoArg({ port: endpoint.port, token: endpoint.token })],
    },
  });
  created.on('close', (event) => {
    if (controller.windowClosing() === 'hide') {
      event.preventDefault();
      created.hide();
    }
  });
  created.on('closed', () => {
    if (window === created) {
      window = undefined;
      windowEndpoint = undefined;
    }
  });
  // Links to the outside world open in the browser; the window only ever shows the app.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (opensOutside(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${appOrigin}/`)) event.preventDefault();
  });
  // Pinch and Ctrl+wheel belong to the calendar's own zoom, not to the page (audit B-14).
  void created.webContents.setVisualZoomLevelLimits(1, 1);
  created.once('ready-to-show', () => created.show());
  return created;
}

const electronShell: DesktopShell = {
  openWindow(endpoint, route) {
    if (window !== undefined && windowEndpoint !== endpoint) window.destroy();
    if (window === undefined) {
      window = createWindow(endpoint);
      windowEndpoint = endpoint;
      void window.loadURL(`${appOrigin}${route ?? '/'}`);
      return;
    }
    if (route !== undefined) void window.loadURL(`${appOrigin}${route}`);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  },
  closeWindow() {
    window?.destroy();
  },
  setTray(entries, tooltip) {
    if (tray === undefined) {
      tray = new Tray(nativeImage.createFromPath(trayIconPath));
      tray.on('click', () => controller.open());
    }
    const template = entries.map((entry): MenuItemConstructorOptions =>
      entry.kind === 'separator'
        ? { type: 'separator' }
        : {
            label: entry.label,
            enabled: entry.enabled,
            click: () => controller.trayAction(entry.action),
          },
    );
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(tooltip);
  },
  notify(notice, onClick) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: notice.title,
      body: notice.body,
      icon: iconPath,
    });
    notifications.add(notification);
    const release = () => notifications.delete(notification);
    notification.on('click', () => {
      release();
      onClick();
    });
    notification.on('close', release);
    notification.show();
  },
  setLoginItem(openAtLogin) {
    // In development the login item would point at the bare Electron binary.
    if (!app.isPackaged) {
      writeLog(`login item not changed in development (openAtLogin=${openAtLogin})\n`);
      return;
    }
    app.setLoginItemSettings({ openAtLogin, args: [hiddenFlag] });
  },
  async askRestart(message) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: productName,
      message,
      buttons: ['Restart', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    return response === 0;
  },
  setUpdateState(state) {
    window?.webContents.send(updateChannels.state, state);
  },
  async confirmUpdateRestart(message) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: productName,
      message: 'Restart to update?',
      detail: message,
      buttons: ['Restart and update', 'Later'],
      defaultId: 1,
      cancelId: 1,
    });
    return response === 0;
  },
  exit(code) {
    tray?.destroy();
    logStream.end(() => app.exit(code));
  },
  log(level, message, error) {
    const detail = error instanceof Error ? ` ${error.stack ?? error.message}` : '';
    writeLog(`${new Date().toISOString()} ${level} ${message}${detail}\n`);
  },
};

const controller = new DesktopController({
  shell: electronShell,
  launchedHidden: process.argv.includes(hiddenFlag),
  newCommandId: randomUUID,
  startServer: () =>
    ServerProcess.start({
      execPath: process.execPath,
      entry: serverEntry,
      home,
      env: process.env,
      startTimeoutMs: serverStartTimeoutMs,
      stopTimeoutMs: serverStopTimeoutMs,
      onOutput: writeLog,
    }),
  connect: (endpoint) =>
    RpcClient.connect(endpoint, (message, error) => electronShell.log('warn', message, error)),
  // Nothing updates in development: an unpackaged build has no app-update.yml to update from.
  ...(app.isPackaged
    ? {
        updates: {
          updater: electronUpdater(electronUpdaterModule.autoUpdater, (level, message) =>
            electronShell.log(level, message),
          ),
          currentVersion: app.getVersion(),
          timers: {
            every: (ms: number, run: () => void) => {
              const timer = setInterval(run, ms);
              return () => clearInterval(timer);
            },
          },
          now: () => new Date(),
        },
      }
    : {}),
});

// Only the app's own pages may use the update bridge.
const fromApp = (event: Electron.IpcMainInvokeEvent): boolean =>
  event.senderFrame?.url.startsWith(`${appOrigin}/`) ?? false;
ipcMain.handle(updateChannels.getState, (event) =>
  fromApp(event) ? (controller.updateState ?? null) : null,
);
ipcMain.handle(updateChannels.check, async (event) => {
  if (fromApp(event)) await controller.checkForUpdates();
});
ipcMain.handle(updateChannels.install, async (event) => {
  if (fromApp(event)) await controller.installUpdate();
});
// Settings marked "Restart required": start again with the same arguments, then quit cleanly.
ipcMain.handle(appChannels.restart, (event) => {
  if (!fromApp(event)) return;
  app.relaunch();
  void controller.quit();
});
ipcMain.handle(folderChannels.pick, async (event) => {
  if (!fromApp(event)) return null;
  const options: Electron.OpenDialogOptions = {
    title: 'Choose the project folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

if (!app.requestSingleInstanceLock()) {
  // Another wow is running; it shows its window (see 'second-instance') and this one leaves.
  app.exit(0);
} else {
  app.on('second-instance', () => controller.open());
  // Closing the last window must not quit: the tray and the server keep running.
  app.on('window-all-closed', () => undefined);
  // Sign-out, shutdown or an app menu quit: stop the server cleanly first.
  app.on('before-quit', (event) => {
    // "Restart to update" already stopped the server; the installer needs the app to quit.
    if (controller.installingUpdate) return;
    event.preventDefault();
    void controller.quit();
  });
  void app.whenReady().then(async () => {
    const menu = applicationMenu(process.platform, app.isPackaged);
    if (menu !== undefined) {
      Menu.setApplicationMenu(menu === null ? null : Menu.buildFromTemplate([...menu]));
    }
    protocol.handle(appScheme, (request) => {
      const file = rendererFile(rendererDir, request.url);
      if (file === undefined) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    try {
      await controller.start();
    } catch (error) {
      electronShell.log('error', 'start failed', error);
      dialog.showErrorBox(
        productName,
        `wow could not start its server.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
      electronShell.exit(1);
    }
  });
}
