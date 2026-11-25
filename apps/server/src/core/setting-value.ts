import type { SettingDefinition } from '@wow/contracts';
import { resolveStored } from '../settings/service.js';
import type { DecideContext, ReadModel } from './orchestrator.js';

// A setting's value as a decision reads it: the stored value, or the registry's default.
export const settingValue = (key: string, read: ReadModel, context: DecideContext): unknown => {
  const definition: SettingDefinition | undefined = Object.hasOwn(context.registry, key)
    ? context.registry[key]
    : undefined;
  if (!definition) return undefined;
  return resolveStored(key, definition, {}, (scope) => read.setting(key, scope)).value;
};
