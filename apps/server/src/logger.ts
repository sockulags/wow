import type { LogLevel } from '@wow/contracts';

const order: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

export type LogSink = (line: string) => void;

// JSON lines on stderr. The level is read on every call so a settings change applies at once.
export function createLogger(
  level: () => LogLevel,
  sink: LogSink = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const write = (at: LogLevel) => (message: string, detail?: unknown) => {
    if (order[at] > order[level()]) return;
    const entry: Record<string, unknown> = { at: new Date().toISOString(), level: at, message };
    if (detail !== undefined) {
      entry['detail'] = detail instanceof Error ? (detail.stack ?? detail.message) : detail;
    }
    sink(JSON.stringify(entry));
  };
  return { error: write('error'), warn: write('warn'), info: write('info'), debug: write('debug') };
}
