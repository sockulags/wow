import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Screenshots of built screens for an intent's `sketches` folder. They are only written when
// WOW_E2E_SKETCHES is set, so a normal run changes no files:
//
//   WOW_E2E_SKETCHES=1 pnpm e2e -- --trace off -g sketch

export const sketching = process.env['WOW_E2E_SKETCHES'] !== undefined;

// Twice the pixels, so text stays sharp when the owner zooms in.
export const sketchUse = { deviceScaleFactor: 2, viewport: { width: 1280, height: 1000 } };

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const sketchPath = (intent: string, name: string) =>
  path.join(repository, 'intents', intent, 'sketches', `${name}.png`);
