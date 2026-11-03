import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parsePath,
  type FieldShape,
  type MethodKind,
  type ProtocolFingerprint,
  type SchemaFiles,
} from './schema.js';

// Tests only: an invented generate-json-schema directory that defines exactly what a fingerprint
// describes, laid out like the real one (union files, <Name>Response.json files). Tests change
// the fingerprint or the files to make an incompatible release.

type Json = Record<string, unknown>;

interface Slot {
  shape?: FieldShape;
  readonly props: Map<string, Slot>;
  items?: Slot;
  values?: Slot;
  readonly variants: Map<string, Slot>;
}

const slot = (): Slot => ({ props: new Map(), variants: new Map() });

function insert(root: Slot, fieldPath: string, shape: FieldShape): void {
  let current = root;
  for (const step of parsePath(fieldPath)) {
    let next = current.props.get(step.name);
    if (!next) {
      next = slot();
      current.props.set(step.name, next);
    }
    current = next;
    for (const modifier of step.modifiers) {
      if (modifier === '[]') current = current.items ??= slot();
      else if (modifier === '{}') current = current.values ??= slot();
      else {
        const tag = modifier.slice(1, -1);
        let variant = current.variants.get(tag);
        if (!variant) {
          variant = slot();
          current.variants.set(tag, variant);
        }
        current = variant;
      }
    }
  }
  current.shape ??= shape;
}

function objectSchema(props: Map<string, Slot>, extra: Json = {}, skip?: string): Json {
  const properties: Json = {};
  const required: string[] = [];
  for (const [name, child] of props) {
    if (name === skip) continue;
    properties[name] = schemaOf(child);
    if (child.shape?.required ?? true) required.push(name);
  }
  const extraProperties = (extra['properties'] ?? {}) as Json;
  const extraRequired = (extra['required'] ?? []) as string[];
  return {
    type: 'object',
    properties: { ...extraProperties, ...properties },
    required: [...extraRequired, ...required],
  };
}

function schemaOf(node: Slot): Json {
  const shape = node.shape;
  const base = baseSchema(node);
  return shape?.nullable ? { anyOf: [base, { type: 'null' }] } : base;
}

function baseSchema(node: Slot): Json {
  const shape = node.shape;
  const tags = new Set<string>(shape?.type === 'union' ? (shape.values ?? []) : []);
  for (const tag of node.variants.keys()) tags.add(tag);
  // `item.type` lists every tag, also of variants no other path names.
  const tagShape = node.props.get('type')?.shape;
  if (node.variants.size > 0 && tagShape?.type === 'enum')
    for (const tag of tagShape.values ?? []) tags.add(tag);
  if (tags.size > 0 || shape?.type === 'union') {
    if (tags.size === 0) return { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    // Properties of the union itself (`item.id`) belong to every variant; `type` is the tag.
    return {
      oneOf: [...tags].map((tag) =>
        objectSchema(node.variants.get(tag)?.props ?? new Map(), {
          properties: {
            ...(objectSchema(node.props, {}, 'type')['properties'] as Json),
            type: { type: 'string', enum: [tag] },
          },
          required: ['type', ...(objectSchema(node.props, {}, 'type')['required'] as string[])],
        }),
      ),
    };
  }
  switch (shape?.type) {
    case 'enum':
      return { type: 'string', enum: [...(shape.values ?? [])] };
    case 'string':
    case 'boolean':
      return { type: shape.type };
    case 'number':
      return { type: 'integer', format: 'int64' };
    case 'null':
      return { type: 'null' };
    case 'array':
      return { type: 'array', items: node.items ? schemaOf(node.items) : {} };
    case 'map':
      return {
        type: 'object',
        additionalProperties: node.values ? schemaOf(node.values) : true,
      };
    case 'any':
      return {};
    default:
      return objectSchema(node.props);
  }
}

const unionFile: Readonly<Record<MethodKind, string>> = {
  clientRequest: 'ClientRequest.json',
  clientNotification: 'ClientNotification.json',
  serverNotification: 'ServerNotification.json',
  serverRequest: 'ServerRequest.json',
};

// The files, by relative path, of a schema directory that defines the fingerprint.
export function synthesizeSchema(fingerprint: ProtocolFingerprint): Map<string, Json> {
  const files = new Map<string, Json>();
  const unions = new Map<MethodKind, { oneOf: Json[]; definitions: Json }>();
  for (const kind of Object.keys(unionFile) as MethodKind[])
    unions.set(kind, { oneOf: [], definitions: {} });
  Object.entries(fingerprint.methods).forEach(([method, entry], index) => {
    const union = unions.get(entry.kind);
    if (!union) return;
    const name = `Method${index}`;
    const params = slot();
    for (const field of entry.params) insert(params, field.path, field.shape);
    union.definitions[`${name}Params`] = objectSchema(params.props);
    union.oneOf.push({
      type: 'object',
      properties: {
        ...(entry.kind === 'clientRequest' || entry.kind === 'serverRequest'
          ? { id: { type: 'integer' } }
          : {}),
        method: { type: 'string', enum: [method] },
        params: { $ref: `#/definitions/${name}Params` },
      },
      required: ['method', 'params'],
    });
    if (entry.kind === 'clientRequest' || entry.kind === 'serverRequest') {
      const result = slot();
      for (const field of entry.result) insert(result, field.path, field.shape);
      files.set(`v2/${name}Response.json`, { ...objectSchema(result.props), definitions: {} });
    }
  });
  for (const [kind, union] of unions)
    files.set(unionFile[kind], { oneOf: union.oneOf, definitions: union.definitions });
  return files;
}

export const filesOf =
  (files: Map<string, Json>): SchemaFiles =>
  (file) =>
    files.get(file);

export async function writeSchema(files: Map<string, Json>, dir: string): Promise<void> {
  for (const [file, content] of files) {
    const full = path.join(dir, ...file.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, JSON.stringify(content));
  }
}
