import { z } from 'zod';

// Auto-update state (behavior 35). The desktop main process owns it: it runs electron-updater and
// hands every change to the web app through the preload bridge (`window.wowDesktop.updates`). The
// web app renders it and never works a status out on its own.

export const UpdateStatus = z.enum([
  // Nothing to do: never checked, or the last check found nothing newer.
  'idle',
  'checking',
  // A newer release was found and its download is about to start.
  'available',
  'downloading',
  // Downloaded; "Restart to update" installs it.
  'ready',
  'error',
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const UpdateState = z.object({
  status: UpdateStatus,
  // False when `updates.enabled` is off. An unpackaged build has no bridge state at all.
  enabled: z.boolean(),
  currentVersion: z.string(),
  // The newer release, once a check found one.
  version: z.string().nullable(),
  // Download progress while `downloading`, 0 to 100.
  percent: z.number().min(0).max(100).nullable(),
  error: z.string().nullable(),
  // When the last check finished, as an ISO instant.
  checkedAt: z.string().nullable(),
});
export type UpdateState = z.infer<typeof UpdateState>;
