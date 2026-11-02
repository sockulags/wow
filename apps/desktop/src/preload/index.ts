import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { decodeServerInfoArg, folderChannels, updateChannels } from '../app.js';

// The web app reads `window.wowServerInfo` (see apps/web/src/app/bootstrap.ts) to find the server.
contextBridge.exposeInMainWorld('wowServerInfo', decodeServerInfoArg(process.argv));

// Auto-update state and actions (behavior 35), read by apps/web/src/app/updates.ts. The main
// process owns the state; the web app only renders what arrives here.
contextBridge.exposeInMainWorld('wowDesktop', {
  // Settings → Projects picks a project's folder with the system dialog instead of a typed path.
  pickFolder: (): Promise<unknown> => ipcRenderer.invoke(folderChannels.pick),
  updates: {
    getState: (): Promise<unknown> => ipcRenderer.invoke(updateChannels.getState),
    check: (): Promise<unknown> => ipcRenderer.invoke(updateChannels.check),
    install: (): Promise<unknown> => ipcRenderer.invoke(updateChannels.install),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const forward = (_event: IpcRendererEvent, state: unknown) => listener(state);
      ipcRenderer.on(updateChannels.state, forward);
      return () => ipcRenderer.off(updateChannels.state, forward);
    },
  },
});
