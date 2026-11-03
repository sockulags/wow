import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexError } from '../connection.js';
import { runCommand, type RunCommand } from '../process.js';
import { compareWithInstalled, type ProtocolFingerprint, type SchemaFiles } from './schema.js';

export interface SchemaLaunch {
  readonly binaryPath: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

// Writes the installed codex's protocol schema into outDir. Rejects with code 'unsupported' when
// that codex has no schema generator, and 'timeout' when it took too long.
export type GenerateSchema = (launch: SchemaLaunch, outDir: string) => Promise<void>;

const lastLine = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

export const generateSchemaWith =
  (run: RunCommand): GenerateSchema =>
  async (launch, outDir) => {
    // generate-json-schema only writes files; it needs no network and no login.
    const result = await run({
      file: launch.binaryPath,
      args: ['app-server', 'generate-json-schema', '--out', outDir],
      env: launch.env,
      timeoutMs: launch.timeoutMs,
    });
    if (result.timedOut)
      throw new CodexError(
        'timeout',
        `codex did not describe its protocol within ${launch.timeoutMs} ms`,
      );
    if (result.startError)
      throw new CodexError('exited', `could not start ${launch.binaryPath} (${result.startError})`);
    if (result.code !== 0)
      throw new CodexError(
        'unsupported',
        lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.code}`,
      );
  };

export const generateJsonSchema: GenerateSchema = generateSchemaWith(runCommand);

export const schemaFilesIn =
  (dir: string): SchemaFiles =>
  (file) => {
    const full = path.join(dir, ...file.split('/'));
    if (!existsSync(full)) return undefined;
    try {
      return JSON.parse(readFileSync(full, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  };

export type InstalledCheck =
  | { readonly state: 'compatible'; readonly doesWithout: readonly string[] }
  | { readonly state: 'incompatible'; readonly problems: readonly string[] }
  // The installed codex cannot describe its protocol (a release without generate-json-schema).
  | { readonly state: 'unavailable'; readonly detail: string };

// Asks the installed codex for its schema and compares it with the tested fingerprint. A
// timeout or a binary that does not start rejects, so the caller does not keep the answer.
export async function checkInstalledCodex(
  fingerprint: ProtocolFingerprint,
  generate: GenerateSchema,
  launch: SchemaLaunch,
): Promise<InstalledCheck> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wow-codex-schema-'));
  try {
    try {
      await generate(launch, dir);
    } catch (error) {
      if (error instanceof CodexError && error.code === 'unsupported')
        return { state: 'unavailable', detail: error.message };
      throw error;
    }
    const report = compareWithInstalled(fingerprint, schemaFilesIn(dir));
    return report.compatible
      ? { state: 'compatible', doesWithout: report.doesWithout }
      : { state: 'incompatible', problems: report.problems };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Answers kept per codex binary and version, for the life of the server process, so "Test" runs
// the check once per installed version. A failed computation is not kept.
export class CompatibilityCache<T> {
  readonly #entries = new Map<string, Promise<T>>();

  get(binaryPath: string, version: string, compute: () => Promise<T>): Promise<T> {
    const key = `${binaryPath}\u0000${version}`;
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const entry = compute();
    this.#entries.set(key, entry);
    entry.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return entry;
  }

  get size(): number {
    return this.#entries.size;
  }
}
