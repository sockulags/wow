import { tmpdir } from 'node:os';
import path from 'node:path';

// The wow server the chat tests talk to: its own home (wiped at every start) and a fixed port, so
// Playwright can wait for it before the tests run.
export const e2eHome = path.join(tmpdir(), 'wow-e2e-home');
export const e2ePort = 4517;
export const e2eProviderInstanceId = 'mock-claude';
export const e2eProjectId = 'demo';
