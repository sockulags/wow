import { contextBridge } from 'electron';
import { decodeServerInfoArg } from '../app.js';

// The web app reads `window.wowServerInfo` (see apps/web/src/app/bootstrap.ts) to find the server.
contextBridge.exposeInMainWorld('wowServerInfo', decodeServerInfoArg(process.argv));
