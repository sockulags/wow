import { z } from 'zod';

// The settings page picks an editor from the setting's zod schema, so a new registry entry needs no
// UI code. Schemas that need a special editor say so with `.meta({ widget })`.

export type ListItemKind = { readonly kind: 'text' } | { readonly kind: 'enum'; options: string[] };

export type FieldKind =
  | { readonly kind: 'text' }
  | {
      readonly kind: 'number';
      readonly min: number | undefined;
      readonly max: number | undefined;
      readonly integer: boolean;
    }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly options: readonly string[] }
  | { readonly kind: 'list'; readonly item: ListItemKind }
  | { readonly kind: 'keyValue' }
  | { readonly kind: 'keybinding' }
  | { readonly kind: 'workHours' }
  | { readonly kind: 'template'; readonly placeholders: readonly string[] }
  | { readonly kind: 'object'; readonly fields: readonly ObjectField[] }
  // An IANA zone, "system" or "outlook": a searchable zone picker.
  | { readonly kind: 'timeZone' }
  // "outlook" or an override of the inner kind (F-8): Outlook's value with an Override switch.
  | { readonly kind: 'fromOutlook'; readonly inner: FieldKind }
  | { readonly kind: 'json' };

export interface ObjectField {
  readonly name: string;
  readonly kind: FieldKind;
}

const finite = (value: number | null): number | undefined =>
  value !== null && Number.isFinite(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER
    ? value
    : undefined;

const stringOptions = (schema: z.ZodEnum): string[] =>
  schema.options.filter((option): option is string => typeof option === 'string');

export function fieldKind(schema: z.ZodType): FieldKind {
  const widget = schema.meta()?.['widget'];
  if (widget === 'keybinding') return { kind: 'keybinding' };
  if (widget === 'keyValue') return { kind: 'keyValue' };
  if (widget === 'workHours') return { kind: 'workHours' };
  if (widget === 'template') {
    const placeholders = schema.meta()?.['placeholders'];
    return {
      kind: 'template',
      placeholders: Array.isArray(placeholders)
        ? placeholders.filter((name): name is string => typeof name === 'string')
        : [],
    };
  }
  if (widget === 'timeZone') return { kind: 'timeZone' };
  if (widget === 'fromOutlook' && schema instanceof z.ZodUnion) {
    const override = (schema.options as readonly z.ZodType[]).find(
      (option) => !(option instanceof z.ZodLiteral),
    );
    if (override) return { kind: 'fromOutlook', inner: fieldKind(override) };
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return fieldKind(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodString) return { kind: 'text' };
  if (schema instanceof z.ZodNumber) {
    return {
      kind: 'number',
      min: finite(schema.minValue),
      max: finite(schema.maxValue),
      integer: schema.isInt,
    };
  }
  if (schema instanceof z.ZodBoolean) return { kind: 'boolean' };
  if (schema instanceof z.ZodEnum) return { kind: 'enum', options: stringOptions(schema) };
  if (schema instanceof z.ZodArray) {
    const element = schema.element as z.ZodType;
    if (element instanceof z.ZodEnum) {
      return { kind: 'list', item: { kind: 'enum', options: stringOptions(element) } };
    }
    if (element instanceof z.ZodString) return { kind: 'list', item: { kind: 'text' } };
    return { kind: 'json' };
  }
  if (schema instanceof z.ZodObject) {
    const fields = Object.entries(schema.shape).map(([name, child]) => ({
      name,
      kind: fieldKind(child as z.ZodType),
    }));
    return { kind: 'object', fields };
  }
  return { kind: 'json' };
}
