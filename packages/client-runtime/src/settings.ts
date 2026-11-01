import {
  settingsRegistry,
  type SettingDefinition,
  type SettingKey,
  type SettingValue,
} from '@wow/contracts';
import type { z } from 'zod';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type SettingDefinitions = Readonly<Record<string, SettingDefinition>>;

// Stored values only. A key without a stored value uses its registry default.
export type SettingValues = Readonly<Record<string, unknown>>;

export type SettingWriteResult = { readonly ok: true } | { readonly ok: false; issues: string[] };

// Where settings live. The server-backed source (settings RPC) and the in-memory source used until
// it exists both implement this, so the settings page does not change when the source does.
export interface SettingsSource {
  // Calls the listener with the current values now and after every change.
  watch(listener: (values: SettingValues) => void): () => void;
  write(key: string, value: unknown): Promise<SettingWriteResult>;
  reset(key: string): Promise<void>;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  );
}

export function validateSetting(
  definitions: SettingDefinitions,
  key: string,
  value: unknown,
): SettingWriteResult {
  const definition = definitions[key];
  if (!definition) return { ok: false, issues: [`Unknown setting "${key}"`] };
  const parsed = definition.schema.safeParse(value);
  return parsed.success ? { ok: true } : { ok: false, issues: formatIssues(parsed.error) };
}

// The stored value when it still passes the schema (a stored value can predate a schema change),
// otherwise the default. The stored object itself is returned, not a parsed copy, so selectors
// that read a setting stay referentially stable between renders.
export function resolveSetting(
  definitions: SettingDefinitions,
  values: SettingValues,
  key: string,
): unknown {
  const definition = definitions[key];
  if (!definition) return undefined;
  if (!(key in values)) return definition.default;
  const stored = values[key];
  return definition.schema.safeParse(stored).success ? stored : definition.default;
}

export function settingValue<K extends SettingKey>(values: SettingValues, key: K): SettingValue<K> {
  // The registry schema for K produced this value, so it has K's value type.
  return resolveSetting(settingsRegistry, values, key) as SettingValue<K>;
}

export function createMemorySettingsSource(
  definitions: SettingDefinitions = settingsRegistry,
  initial: SettingValues = {},
): SettingsSource {
  let values: SettingValues = { ...initial };
  const listeners = new Set<(values: SettingValues) => void>();
  const publish = () => {
    for (const listener of listeners) listener(values);
  };
  return {
    watch(listener) {
      listeners.add(listener);
      listener(values);
      return () => listeners.delete(listener);
    },
    write(key, value) {
      const result = validateSetting(definitions, key, value);
      if (result.ok) {
        values = { ...values, [key]: value };
        publish();
      }
      return Promise.resolve(result);
    },
    reset(key) {
      const { [key]: _removed, ...rest } = values;
      values = rest;
      publish();
      return Promise.resolve();
    },
  };
}

export interface SettingsState {
  readonly values: SettingValues;
  readonly ready: boolean;
}

export interface SettingsStore extends StoreApi<SettingsState> {
  readonly definitions: SettingDefinitions;
  write(key: string, value: unknown): Promise<SettingWriteResult>;
  reset(key: string): Promise<void>;
  dispose(): void;
}

export function createSettingsStore(
  source: SettingsSource,
  definitions: SettingDefinitions = settingsRegistry,
): SettingsStore {
  const store = createStore<SettingsState>(() => ({ values: {}, ready: false }));
  const stop = source.watch((values) => store.setState({ values, ready: true }));
  return {
    ...store,
    definitions,
    write(key, value) {
      // Validate here too so the page reports problems without a round trip.
      const local = validateSetting(definitions, key, value);
      return local.ok ? source.write(key, value) : Promise.resolve(local);
    },
    reset: (key) => source.reset(key),
    dispose: stop,
  };
}
