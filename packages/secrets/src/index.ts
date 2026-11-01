import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretProtection, SecretRef } from '@wow/contracts';

export const secretsFileName = 'secrets.json';

// Turns a plain value into what is stored on disk and back.
export interface Protector {
  readonly kind: SecretProtection;
  protect(plain: string): Promise<string>;
  unprotect(stored: string): Promise<string>;
}

// Off Windows the value is stored as is; the file mode (0600) is the only protection, and the UI
// warns about it.
export const plainProtector: Protector = {
  kind: 'none',
  protect: (plain) => Promise.resolve(plain),
  unprotect: (stored) => Promise.resolve(stored),
};

const dpapiScript = (operation: 'Protect' | 'Unprotect'): string =>
  [
    'Add-Type -AssemblyName System.Security',
    '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$result = [System.Security.Cryptography.ProtectedData]::${operation}($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');

// The script travels as -EncodedCommand and the value through stdin, so neither quoting nor the
// process command line ever carries the secret.
function runPowerShell(executable: string, script: string, input: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`DPAPI call failed (exit ${String(code)}): ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

export function dpapiProtector(executable = 'powershell.exe'): Protector {
  return {
    kind: 'dpapi',
    protect: (plain) =>
      runPowerShell(executable, dpapiScript('Protect'), Buffer.from(plain).toString('base64')),
    unprotect: async (stored) =>
      Buffer.from(
        await runPowerShell(executable, dpapiScript('Unprotect'), stored),
        'base64',
      ).toString('utf8'),
  };
}

export function defaultProtector(platform: NodeJS.Platform = process.platform): Protector {
  return platform === 'win32' ? dpapiProtector() : plainProtector;
}

interface SecretsFile {
  version: 1;
  protection: SecretProtection;
  entries: Record<string, string>;
}

const isSecretsFile = (value: unknown): value is SecretsFile => {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<SecretsFile>;
  return (
    file.version === 1 &&
    (file.protection === 'dpapi' || file.protection === 'none') &&
    typeof file.entries === 'object' &&
    file.entries !== null
  );
};

export interface SecretStoreOptions {
  // The wow home directory; the store lives in `<dir>/secrets.json`.
  readonly dir: string;
  readonly protector?: Protector;
}

export class SecretStore {
  readonly file: string;
  readonly protector: Protector;
  // Writes are read-modify-write on one file, so they run one after another.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SecretStoreOptions) {
    this.file = path.join(options.dir, secretsFileName);
    this.protector = options.protector ?? defaultProtector();
  }

  get protection(): SecretProtection {
    return this.protector.kind;
  }

  async names(): Promise<string[]> {
    return Object.keys((await this.#read()).entries).toSorted();
  }

  async get(name: string): Promise<string | undefined> {
    const file = await this.#read();
    const stored = file.entries[name];
    if (stored === undefined) return undefined;
    if (file.protection !== this.protector.kind) {
      throw new Error(
        `Secrets were stored with ${file.protection} protection but this machine uses ${this.protector.kind}`,
      );
    }
    return this.protector.unprotect(stored);
  }

  async resolve(ref: SecretRef): Promise<string | undefined> {
    return this.get(ref.secretRef);
  }

  set(name: string, value: string): Promise<SecretRef> {
    return this.#serial(async () => {
      const file = await this.#read();
      if (file.protection !== this.protector.kind && Object.keys(file.entries).length > 0) {
        throw new Error(
          `Secrets were stored with ${file.protection} protection but this machine uses ${this.protector.kind}`,
        );
      }
      file.protection = this.protector.kind;
      file.entries[name] = await this.protector.protect(value);
      await this.#write(file);
      return { secretRef: name };
    });
  }

  delete(name: string): Promise<boolean> {
    return this.#serial(async () => {
      const file = await this.#read();
      if (!Object.hasOwn(file.entries, name)) return false;
      delete file.entries[name];
      await this.#write(file);
      return true;
    });
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #read(): Promise<SecretsFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, protection: this.protector.kind, entries: {} };
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isSecretsFile(parsed)) throw new Error(`${this.file} is not a wow secrets file`);
    return parsed;
  }

  // Write a sibling file with mode 0600 and rename it over the old one, so a crash never leaves a
  // half-written store and the file is never readable by others, not even briefly.
  async #write(file: SecretsFile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
