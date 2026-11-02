import {
  settingsRegistry,
  type ResolvedSetting,
  type SettingDefinition,
  type SettingKey,
  type SettingScopeRef,
  type SettingValue,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { settings } from '../db/schema.js';
import type { Engine } from '../core/engine.js';

export interface SettingContext {
  readonly projectId?: string | undefined;
  readonly providerInstanceId?: string | undefined;
}

export type SettingChangeListener = (key: string, scope: SettingScopeRef) => void;

// Reads go to SQLite every time, so a committed change is what the next read returns; services
// that hold derived state (a timer, a log level) listen with onChange.
export class SettingsService {
  readonly #db: Db;
  readonly #registry: Readonly<Record<string, SettingDefinition>>;
  readonly #listeners = new Set<SettingChangeListener>();

  constructor(
    db: Db,
    engine: Engine,
    registry: Readonly<Record<string, SettingDefinition>> = settingsRegistry,
  ) {
    this.#db = db;
    this.#registry = registry;
    engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind !== 'setting.changed' && event.kind !== 'setting.reset') continue;
        for (const listener of this.#listeners) listener(event.payload.key, event.payload.scope);
      }
    });
  }

  onChange(listener: SettingChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get<K extends SettingKey>(key: K, context: SettingContext = {}): SettingValue<K> {
    return this.resolve(key, context).value as SettingValue<K>;
  }

  // Provider over project over global over the registry default. A stored value that no longer
  // passes the setting's schema is skipped rather than handed to a service.
  resolve(key: string, context: SettingContext = {}): ResolvedSetting {
    const definition = Object.hasOwn(this.#registry, key) ? this.#registry[key] : undefined;
    if (!definition) throw new Error(`Unknown setting ${key}`);
    const stored = new Map(
      this.#db
        .select({ scope: settings.scope, value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .all()
        .map((row) => [row.scope, row.value]),
    );
    return resolveStored(key, definition, context, (scope) =>
      stored.has(scope) ? { value: stored.get(scope) } : undefined,
    );
  }

  resolveAll(context: SettingContext = {}): ResolvedSetting[] {
    return Object.keys(this.#registry)
      .toSorted()
      .map((key) => this.resolve(key, context));
  }
}

// The resolution order on its own, for callers that read stored values another way: the
// orchestrator reads them inside the command's transaction.
export function resolveStored(
  key: string,
  definition: SettingDefinition,
  context: SettingContext,
  storedAt: (scope: SettingScopeRef) => { value: unknown } | undefined,
): ResolvedSetting {
  for (const scope of scopesFor(definition, context)) {
    const stored = storedAt(scope);
    if (!stored) continue;
    const parsed = definition.schema.safeParse(stored.value);
    if (parsed.success) return { key, value: parsed.data, source: scope };
  }
  return { key, value: definition.default, source: 'default' };
}

function scopesFor(definition: SettingDefinition, context: SettingContext): SettingScopeRef[] {
  const scopes: SettingScopeRef[] = [];
  if (definition.scope === 'provider' && context.providerInstanceId) {
    scopes.push(`provider:${context.providerInstanceId}`);
  }
  if (definition.scope !== 'global' && context.projectId) {
    scopes.push(`project:${context.projectId}`);
  }
  scopes.push('global');
  return scopes;
}
