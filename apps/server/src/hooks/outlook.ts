import { prefersMock } from '@wow/outlook-bridge';

export type OutlookMode = 'mock' | 'bridge';

// Off Windows, or with WOW_OUTLOOK=mock, the fixture-backed MockOutlookSource is used.
export function outlookMode(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): OutlookMode {
  return prefersMock(platform, env) ? 'mock' : 'bridge';
}
