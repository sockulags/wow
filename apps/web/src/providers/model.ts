import {
  providerSetup,
  type Command,
  type SecretRef,
  type ProviderInstance,
  type ProviderInstanceStatus,
  type ProviderKind,
} from '@wow/contracts';

// The editor's working copy of a provider instance and how it becomes a command. Pure, so the
// rules (secret values, launch arguments, what changed) are tested without rendering.

export interface EnvRow {
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
  // The stored reference of a secret row; its value is never sent back to the client.
  readonly stored: SecretRef | undefined;
}

export interface InstanceDraft {
  readonly kind: ProviderKind;
  readonly name: string;
  readonly binaryPath: string;
  readonly configDir: string;
  readonly env: readonly EnvRow[];
  // One argument per line, so values with spaces stay whole.
  readonly launchArgs: string;
  readonly defaultModel: string;
  readonly defaultEffort: string;
  readonly defaultPermissionMode: string;
}

export const statusLabels: Readonly<Record<ProviderInstanceStatus, string>> = {
  unknown: 'Not tested',
  ready: 'Ready',
  error: 'Error',
};

// A new instance is named after its provider, numbered when that name is taken.
export function emptyDraft(kind: ProviderKind, takenNames: readonly string[]): InstanceDraft {
  const label = providerSetup[kind].label;
  const taken = new Set(takenNames);
  let name = label;
  for (let n = 2; taken.has(name); n += 1) name = `${label} ${n}`;
  return {
    kind,
    name,
    binaryPath: '',
    configDir: '',
    env: [],
    launchArgs: '',
    defaultModel: '',
    defaultEffort: '',
    defaultPermissionMode: '',
  };
}

export function draftFromInstance(instance: ProviderInstance): InstanceDraft {
  return {
    kind: instance.kind,
    name: instance.name,
    binaryPath: instance.binaryPath,
    configDir: instance.configDir,
    env: Object.entries(instance.env).map(([key, value]) =>
      typeof value === 'string'
        ? { key, value, secret: false, stored: undefined }
        : { key, value: '', secret: true, stored: value },
    ),
    launchArgs: instance.launchArgs.join('\n'),
    defaultModel: instance.defaultModel ?? '',
    defaultEffort: instance.defaultEffort ?? '',
    defaultPermissionMode: instance.defaultPermissionMode ?? '',
  };
}

export const newInstanceId = (kind: ProviderKind) =>
  `${kind}-${globalThis.crypto.randomUUID().slice(0, 8)}`;

export const parseLaunchArgs = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

export const secretName = (providerInstanceId: string, key: string) =>
  `provider:${providerInstanceId}:env:${key}`;

export function draftIssues(draft: InstanceDraft): string[] {
  const issues: string[] = [];
  if (draft.name.trim() === '') issues.push('Give the instance a name.');
  const keys = draft.env.map((row) => row.key.trim());
  if (keys.some((key) => key === '')) issues.push('Every environment variable needs a name.');
  if (new Set(keys).size !== keys.length) issues.push('Environment variable names must be unique.');
  for (const row of draft.env) {
    if (row.secret && row.value === '' && !row.stored && row.key.trim() !== '') {
      issues.push(`Enter a value for the secret ${row.key.trim()}.`);
    }
  }
  return issues;
}

// Stores new secret values first (through `storeSecret`, which answers with the reference), then
// builds the command. Secret rows left empty keep their stored value.
export async function draftToCommand(
  draft: InstanceDraft,
  providerInstanceId: string,
  existing: ProviderInstance | undefined,
  storeSecret: (name: string, value: string) => Promise<SecretRef>,
): Promise<Command> {
  const env: Record<string, string | SecretRef> = {};
  for (const row of draft.env) {
    const key = row.key.trim();
    if (!row.secret) env[key] = row.value;
    else if (row.value !== '')
      env[key] = await storeSecret(secretName(providerInstanceId, key), row.value);
    else if (row.stored) env[key] = row.stored;
  }
  const fields = {
    name: draft.name.trim(),
    binaryPath: draft.binaryPath.trim(),
    configDir: draft.configDir.trim(),
    env,
    launchArgs: parseLaunchArgs(draft.launchArgs),
    defaultModel: draft.defaultModel.trim() || null,
    defaultEffort: draft.defaultEffort.trim() || null,
    defaultPermissionMode: draft.defaultPermissionMode || null,
  };
  return existing
    ? { type: 'providerInstance.update', providerInstanceId, ...fields }
    : { type: 'providerInstance.create', providerInstanceId, kind: draft.kind, ...fields };
}
