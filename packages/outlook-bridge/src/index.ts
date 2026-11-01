import { loadFixtures } from './fixtures.js';
import { MockOutlookSource } from './mock-source.js';
import { PowershellOutlookSource } from './powershell-source.js';
import type { Clock, OutlookSource } from './source.js';

export * from './fixtures.js';
export * from './mock-source.js';
export * from './powershell-source.js';
export * from './protocol.js';
export * from './source.js';
export * from './sync.js';
export * from './zone.js';

export interface CreateOutlookSourceOptions {
  readonly requestTimeoutMs: () => number;
  readonly clock?: Clock;
  // Mock only: where the fixtures live; the package's invented fixtures by default.
  readonly fixturesDir?: string;
}

// `mode` comes from prefersMock: the mock off Windows or with WOW_OUTLOOK=mock, else the bridge.
export async function createOutlookSource(
  mode: 'mock' | 'bridge',
  options: CreateOutlookSourceOptions,
): Promise<OutlookSource> {
  if (mode === 'bridge') {
    return new PowershellOutlookSource({
      requestTimeoutMs: options.requestTimeoutMs,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }
  return new MockOutlookSource({
    fixtures: await loadFixtures(options.fixturesDir),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
