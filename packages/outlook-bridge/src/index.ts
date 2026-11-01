// Placeholder until U4 adds the bridge. Off Windows the mock source is used.
export function prefersMock(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): boolean {
  return platform !== 'win32' || env['WOW_OUTLOOK'] === 'mock';
}
