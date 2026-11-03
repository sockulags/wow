// The protocol fingerprint: the fields of each app-server method the adapter sends or reads, with
// their types, read from the JSON Schema bundle `codex app-server generate-json-schema` writes.
//
// scripts/generate-protocol.mjs imports this file directly (Node strips the types), so it has no
// imports and uses only syntax Node can strip.

export type MethodKind =
  'clientRequest' | 'clientNotification' | 'serverNotification' | 'serverRequest';

export type ShapeType =
  'string' | 'number' | 'boolean' | 'null' | 'object' | 'map' | 'array' | 'enum' | 'union' | 'any';

// What one field looks like in a codex release. `values` lists an enum's values or a union's tags.
export interface FieldShape {
  readonly type: ShapeType;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly values?: readonly string[];
}

// How the adapter uses a field, written in FIELDS in the generator.
//
// A path is dot-separated property names; `[]` steps into array items, `{}` into map values and
// `<tag>` selects the variant of a tagged union (`item<commandExecution>.command`). A path that
// ends in `<tag>` only asks for that variant to exist.
export interface FieldUse {
  readonly path: string;
  // The adapter copes when the field is missing (it falls back, or the field only refines).
  readonly copes?: boolean;
  // Sent fields only: the adapter leaves the field out on some requests.
  readonly omits?: boolean;
  // Sent fields only: the adapter may send null.
  readonly sendsNull?: boolean;
  // Sent fields only: the enum values or union tags the adapter sends.
  readonly sends?: readonly string[];
}

export interface FieldEntry extends FieldUse {
  readonly shape: FieldShape;
}

export interface MethodFingerprint {
  readonly kind: MethodKind;
  // The adapter works without this method (a notification that only adds detail).
  readonly copes?: boolean;
  // Params of the message: sent for client requests, read for everything codex sends.
  readonly params: readonly FieldEntry[];
  // Result of a request: read for client requests, sent for server requests.
  readonly result: readonly FieldEntry[];
}

export interface ProtocolFingerprint {
  readonly codexVersion: string;
  readonly methods: Readonly<Record<string, MethodFingerprint>>;
}

// What the generator and the runtime check describe: methods, and per method the field uses.
export interface MethodUse {
  readonly kind: MethodKind;
  readonly copes?: boolean;
  readonly params: readonly FieldUse[];
  readonly result: readonly FieldUse[];
}

// Reads one file of a generate-json-schema output directory, by its relative path with `/`.
export type SchemaFiles = (relativePath: string) => unknown;

type Json = Readonly<Record<string, unknown>>;

interface Node {
  readonly schema: Json;
  readonly defs: Json;
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unionFiles: Readonly<Record<MethodKind, string>> = {
  clientRequest: 'ClientRequest.json',
  clientNotification: 'ClientNotification.json',
  serverNotification: 'ServerNotification.json',
  serverRequest: 'ServerRequest.json',
};

// Follows $ref (into the same file's definitions) and single-entry allOf.
function deref(node: Node): Node {
  let current = node;
  for (let depth = 0; depth < 64; depth += 1) {
    const ref = current.schema['$ref'];
    if (typeof ref === 'string') {
      const name = ref.replace(/^#\/definitions\//, '');
      const target = current.defs[name];
      if (!isObject(target)) return { schema: {}, defs: current.defs };
      current = { schema: target, defs: current.defs };
      continue;
    }
    const allOf = current.schema['allOf'];
    if (Array.isArray(allOf) && allOf.length === 1 && isObject(allOf[0])) {
      current = { schema: allOf[0], defs: current.defs };
      continue;
    }
    return current;
  }
  return current;
}

const typeList = (schema: Json): string[] => {
  const type = schema['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type))
    return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
};

const members = (schema: Json): Json[] | null => {
  const list = schema['oneOf'] ?? schema['anyOf'];
  return Array.isArray(list) ? list.filter(isObject) : null;
};

const isNullSchema = (schema: Json): boolean => {
  const types = typeList(schema);
  return types.length === 1 && types[0] === 'null';
};

// The schema without its null alternative, and whether null was allowed.
function nonNull(node: Node): { node: Node; nullable: boolean } {
  const resolved = deref(node);
  const types = typeList(resolved.schema);
  if (types.includes('null') && types.length > 1) {
    const rest = types.filter((type) => type !== 'null');
    return {
      node: {
        schema: { ...resolved.schema, type: rest.length === 1 ? rest[0] : rest },
        defs: resolved.defs,
      },
      nullable: true,
    };
  }
  const list = members(resolved.schema);
  if (list && list.some(isNullSchema)) {
    const rest = list.filter((member) => !isNullSchema(member));
    const { oneOf: _oneOf, anyOf: _anyOf, ...others } = resolved.schema;
    const only = rest[0];
    const schema: Json =
      rest.length === 1 &&
      only &&
      Object.keys(others).every((key) => key === 'description' || key === 'default')
        ? only
        : { ...others, anyOf: rest };
    const inner = nonNull({ schema, defs: resolved.defs });
    return { node: inner.node, nullable: true };
  }
  return { node: resolved, nullable: false };
}

const enumValues = (schema: Json): string[] | null => {
  if (typeof schema['const'] === 'string') return [schema['const']];
  const values = schema['enum'];
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : null;
};

const propertiesOf = (schema: Json): Json => {
  const properties = schema['properties'];
  return isObject(properties) ? properties : {};
};

const requiredOf = (schema: Json): string[] => {
  const required = schema['required'];
  return Array.isArray(required)
    ? required.filter((name): name is string => typeof name === 'string')
    : [];
};

// The variants of a union, each resolved, or null when the node is not a union.
function variantsOf(node: Node): Node[] | null {
  const list = members(node.schema);
  if (!list || list.length === 0) return null;
  return list.map((member) => nonNull({ schema: member, defs: node.defs }).node);
}

// The property that tells a union's object variants apart (`type` in codex), if every object
// variant has one with a single value.
function tagOf(variant: Node): { property: string; value: string } | null {
  const properties = propertiesOf(variant.schema);
  const names = Object.keys(properties);
  for (const name of ['type', ...names.filter((entry) => entry !== 'type')]) {
    const property = properties[name];
    if (!isObject(property)) continue;
    const values = enumValues(deref({ schema: property, defs: variant.defs }).schema);
    if (values && values.length === 1 && values[0] !== undefined)
      return { property: name, value: values[0] };
  }
  return null;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();

function unionValues(variants: Node[]): string[] {
  const values: string[] = [];
  for (const variant of variants) {
    const own = enumValues(variant.schema);
    if (own) values.push(...own);
    else {
      const tag = tagOf(variant);
      if (tag) values.push(tag.value);
      else {
        const nested = variantsOf(variant);
        if (nested) values.push(...unionValues(nested));
      }
    }
  }
  return sorted(values);
}

function shapeOf(node: Node, required: boolean): FieldShape {
  const { node: inner, nullable } = nonNull(node);
  const { schema } = inner;
  const values = enumValues(schema);
  if (values) return { type: 'enum', required, nullable, values: sorted(values) };
  const variants = variantsOf(inner);
  if (variants) return { type: 'union', required, nullable, values: unionValues(variants) };
  const types = typeList(schema);
  const type = types[0];
  if (types.length > 1) return { type: 'union', required, nullable, values: sorted(types) };
  if (type === 'integer' || type === 'number') return { type: 'number', required, nullable };
  if (type === 'string' || type === 'boolean' || type === 'null' || type === 'array')
    return { type, required, nullable };
  if (type === 'object' || isObject(schema['properties'])) {
    const additional = schema['additionalProperties'];
    const isMap = isObject(additional) && Object.keys(propertiesOf(schema)).length === 0;
    return { type: isMap ? 'map' : 'object', required, nullable };
  }
  return { type: 'any', required, nullable };
}

interface Step {
  readonly name: string;
  readonly modifiers: readonly string[];
}

export function parsePath(path: string): Step[] {
  if (path === '') return [];
  return path.split('.').map((part) => {
    const match = /^(\w+)((?:\[\]|\{\}|<\w+>)*)$/.exec(part);
    if (!match || match[1] === undefined)
      throw new Error(`Cannot read the field path "${path}" at "${part}"`);
    return { name: match[1], modifiers: match[2]?.match(/\[\]|\{\}|<\w+>/g) ?? [] };
  });
}

// A property of an object, or of every variant of a union (`item.id`); the tag property of a
// union (`item.type`) reads as the enum of all tags.
function propertyAt(node: Node, name: string): { node: Node; required: boolean } | null {
  const { node: inner } = nonNull(node);
  const own = propertiesOf(inner.schema)[name];
  // `true` is JSON Schema for "any value" (codex's JsonValue).
  if (isObject(own) || own === true) {
    return {
      node: { schema: isObject(own) ? own : {}, defs: inner.defs },
      required: requiredOf(inner.schema).includes(name),
    };
  }
  const variants = variantsOf(inner);
  if (!variants) return null;
  const objects = variants.filter((variant) => !enumValues(variant.schema));
  const tags = objects.map(tagOf);
  if (objects.length > 0 && tags.every((tag) => tag?.property === name)) {
    const values = tags.flatMap((tag) => (tag ? [tag.value] : []));
    return { node: { schema: { type: 'string', enum: values }, defs: inner.defs }, required: true };
  }
  const found = objects.map((variant) => propertyAt(variant, name));
  if (found.length === 0 || found.some((entry) => entry === null)) return null;
  const first = found[0];
  if (!first) return null;
  return { node: first.node, required: found.every((entry) => entry?.required) };
}

function variantTagged(node: Node, tag: string): Node | null {
  const { node: inner } = nonNull(node);
  const variants = variantsOf(inner);
  if (!variants) return null;
  for (const candidate of variants) {
    const values = enumValues(candidate.schema);
    if (values?.includes(tag)) return candidate;
    if (tagOf(candidate)?.value === tag) return candidate;
    const nested = variantsOf(candidate);
    if (nested) {
      const found = variantTagged(candidate, tag);
      if (found) return found;
    }
  }
  return null;
}

function applyModifier(node: Node, modifier: string): Node | null {
  const { node: inner } = nonNull(node);
  if (modifier === '[]') {
    const items = inner.schema['items'];
    return isObject(items) ? { schema: items, defs: inner.defs } : null;
  }
  if (modifier === '{}') {
    const values = inner.schema['additionalProperties'];
    return isObject(values) ? { schema: values, defs: inner.defs } : null;
  }
  return variantTagged(inner, modifier.slice(1, -1));
}

type Located =
  | { readonly node: Node; readonly required: boolean }
  // The path is not there; `variant` is the prefix up to a <tag> whose variant is missing.
  | { readonly node: null; readonly variant: string | null };

// The node a path names inside a root, with whether its last property is required.
function locate(root: Node, path: string): Located {
  let current: Node = root;
  let required = true;
  const walked: string[] = [];
  for (const step of parsePath(path)) {
    const found = propertyAt(current, step.name);
    if (!found) return { node: null, variant: null };
    current = found.node;
    required = found.required;
    let part = step.name;
    for (const modifier of step.modifiers) {
      part += modifier;
      const next = applyModifier(current, modifier);
      if (!next)
        return {
          node: null,
          variant: modifier.startsWith('<') ? [...walked, part].join('.') : null,
        };
      current = next;
      required = true;
    }
    walked.push(part);
  }
  return { node: current, required };
}

// Required properties of the object a path names, for objects the adapter builds itself.
function requiredAt(root: Node, path: string): string[] | null {
  const found = locate(root, path);
  if (!found.node) return null;
  const { node } = nonNull(found.node);
  if (variantsOf(node) && Object.keys(propertiesOf(node.schema)).length === 0) return null;
  const tag = tagOf(node)?.property;
  return requiredOf(node.schema).filter((name) => name !== tag);
}

export function describeField(root: Node, path: string): FieldShape | null {
  const found = locate(root, path);
  return found.node ? shapeOf(found.node, found.required) : null;
}

const fileNode = (file: unknown): Node | null => {
  if (!isObject(file)) return null;
  const defs = file['definitions'];
  return { schema: file, defs: isObject(defs) ? defs : {} };
};

export interface MethodRoots {
  readonly params: Node | null;
  readonly result: Node | null;
}

// Where a method's params and result are defined in a generate-json-schema directory, or null
// when that codex does not define the method. Results are `<Name>Response.json` next to the
// union file or in v1/ or v2/, where <Name>Params is the params type.
export function methodRoots(
  files: SchemaFiles,
  kind: MethodKind,
  method: string,
): MethodRoots | null {
  const union = fileNode(files(unionFiles[kind]));
  if (!union) return null;
  for (const member of members(union.schema) ?? []) {
    const properties = propertiesOf(member);
    const methodSchema = properties['method'];
    if (!isObject(methodSchema)) continue;
    if (!enumValues(deref({ schema: methodSchema, defs: union.defs }).schema)?.includes(method))
      continue;
    const paramsSchema = properties['params'];
    const params: Node | null = isObject(paramsSchema)
      ? { schema: paramsSchema, defs: union.defs }
      : null;
    if (kind === 'clientNotification' || kind === 'serverNotification')
      return { params, result: null };
    const ref = isObject(paramsSchema) ? paramsSchema['$ref'] : undefined;
    const paramsName = typeof ref === 'string' ? ref.replace(/^#\/definitions\//, '') : null;
    const responseName = paramsName?.replace(/Params$/, 'Response');
    let result: Node | null = null;
    if (responseName)
      for (const dir of ['', 'v1/', 'v2/']) {
        result = fileNode(files(`${dir}${responseName}.json`));
        if (result) break;
      }
    return { params, result };
  }
  return null;
}

// A field as one release defines it; shape is null where the release lacks it, and
// missingVariant names the union variant on its path that the release lacks, if that is why.
export interface ExtractedField extends FieldUse {
  readonly shape: FieldShape | null;
  readonly missingVariant: string | null;
}

export interface ExtractedMethod {
  readonly kind: MethodKind;
  readonly copes?: boolean;
  // False when the codex release does not define the method.
  readonly defined: boolean;
  readonly params: readonly ExtractedField[];
  readonly result: readonly ExtractedField[];
  // Required properties of each object the adapter builds (keyed `params:<path>` or
  // `result:<path>`), null where the object is missing or not a plain object.
  readonly required: Readonly<Record<string, readonly string[] | null>>;
}

// Objects the adapter builds in what it sends, by path ('' is the params or result itself), each
// with the property names it sets. A variant selected with <tag> is built with its tag.
export function builtObjects(fields: readonly FieldUse[]): Map<string, Set<string>> {
  const built = new Map<string, Set<string>>();
  const at = (path: string) => {
    const names = built.get(path) ?? new Set<string>();
    built.set(path, names);
    return names;
  };
  for (const field of fields) {
    const steps = parsePath(field.path);
    steps.forEach((step, index) => {
      const prefix = steps
        .slice(0, index)
        .map((entry) => `${entry.name}${entry.modifiers.join('')}`);
      at(prefix.join('.')).add(step.name);
      if (step.modifiers.at(-1)?.startsWith('<'))
        at([...prefix, `${step.name}${step.modifiers.join('')}`].join('.'));
    });
  }
  return built;
}

const sentSide = (kind: MethodKind): 'params' | 'result' | null =>
  kind === 'clientRequest' || kind === 'clientNotification'
    ? 'params'
    : kind === 'serverRequest'
      ? 'result'
      : null;

const extractFields = (root: Node | null, fields: readonly FieldUse[]): ExtractedField[] =>
  fields.map((field) => {
    const found = root ? locate(root, field.path) : null;
    return {
      ...field,
      shape: found?.node ? shapeOf(found.node, found.required) : null,
      missingVariant: found && !found.node ? found.variant : null,
    };
  });

export function extractMethod(files: SchemaFiles, method: string, use: MethodUse): ExtractedMethod {
  const roots = methodRoots(files, use.kind, method);
  const required: Record<string, readonly string[] | null> = {};
  const side = sentSide(use.kind);
  if (side && roots) {
    const root = roots[side];
    for (const path of builtObjects(use[side]).keys())
      required[`${side}:${path}`] = root ? requiredAt(root, path) : null;
  }
  return {
    kind: use.kind,
    ...(use.copes ? { copes: true } : {}),
    defined: roots !== null,
    params: extractFields(roots?.params ?? null, use.params),
    result: extractFields(roots?.result ?? null, use.result),
    required,
  };
}

// The generator's half: the fingerprint of the tested release. Fails on a field or method that
// release does not define, so FIELDS never names something that does not exist.
export function fingerprintOf(
  files: SchemaFiles,
  codexVersion: string,
  uses: Readonly<Record<string, MethodUse>>,
): ProtocolFingerprint {
  const methods: Record<string, MethodFingerprint> = {};
  const missing: string[] = [];
  for (const [method, use] of Object.entries(uses)) {
    const extracted = extractMethod(files, method, use);
    if (!extracted.defined) missing.push(method);
    const keep = (side: 'params' | 'result') =>
      extracted[side].flatMap((field) => {
        if (!field.shape) {
          missing.push(`${method} ${side}.${field.path}`);
          return [];
        }
        const { missingVariant: _missingVariant, ...entry } = field;
        return [{ ...entry, shape: field.shape }];
      });
    methods[method] = {
      kind: use.kind,
      ...(use.copes ? { copes: true } : {}),
      params: keep('params'),
      result: keep('result'),
    };
  }
  if (missing.length > 0)
    throw new Error(`codex ${codexVersion} does not define: ${missing.join(', ')}`);
  return { codexVersion, methods };
}

export interface CompatibilityReport {
  readonly compatible: boolean;
  // What breaks wow on this release: missing methods and fields, changed types.
  readonly problems: readonly string[];
  // Fields and methods this release lacks that the adapter does without.
  readonly doesWithout: readonly string[];
}

// A string, an enum of strings and a union with string values carry the same values on the wire:
// none of these changes is a type change. Sent enum values are checked on their own.
const stringLike = new Set<ShapeType>(['string', 'enum', 'union']);
const sameKind = (was: ShapeType, now: ShapeType): boolean =>
  was === now || (stringLike.has(was) && stringLike.has(now) && (was === 'enum' || now === 'enum'));

// The runtime half: compares the tested fingerprint with what an installed release defines. The
// rules (README, "Other codex versions"):
//
// Read fields (codex → wow). Missing is fine when FIELDS marks that the adapter copes, when the
// tested release already allowed null (the generated types made the adapter handle it), or when
// the whole union variant on the path is gone (wow never sees such an item). A changed type, or a
// field that was always there becoming optional or nullable, is a problem. New enum values and
// variants are fine: the adapter ignores what it does not know.
//
// Sent fields (wow → codex). Missing is fine only when the adapter copes. A changed type, an enum
// value or variant the adapter sends that codex no longer accepts, null no longer accepted where
// the adapter sends null, a field the adapter sometimes leaves out becoming required, and a new
// required property in an object the adapter builds are problems.
//
// Methods. A missing request, client notification or handled server request is a problem (codex
// renamed or removed it); a missing notification or request the adapter copes without is not.
export function compareWithInstalled(
  tested: ProtocolFingerprint,
  files: SchemaFiles,
): CompatibilityReport {
  const problems: string[] = [];
  const doesWithout: string[] = [];
  for (const [method, expected] of Object.entries(tested.methods)) {
    const installed = extractMethod(files, method, expected);
    if (!installed.defined) {
      if (expected.copes) doesWithout.push(method);
      else problems.push(`${method} is missing (renamed or removed)`);
      continue;
    }
    const side = sentSide(expected.kind);
    for (const part of ['params', 'result'] as const) {
      const sent = part === side;
      expected[part].forEach((field, index) => {
        const found = installed[part][index];
        const now = found?.shape ?? null;
        const name = `${method} ${part}.${field.path}`;
        const was = field.shape;
        if (!now) {
          const variant = found?.missingVariant;
          if (!sent && variant) {
            const without = `${method} ${part}.${variant}`;
            if (!doesWithout.includes(without)) doesWithout.push(without);
          } else if (field.copes || (!sent && was.nullable)) doesWithout.push(name);
          else problems.push(`${name} is missing`);
          return;
        }
        if (!sameKind(was.type, now.type)) {
          problems.push(`${name} changed from ${was.type} to ${now.type}`);
          return;
        }
        if (sent) {
          const accepted = new Set(now.values ?? []);
          const gone = (field.sends ?? []).filter((value) => !accepted.has(value));
          if (gone.length > 0)
            problems.push(
              `${name} no longer accepts ${gone.map((value) => `"${value}"`).join(', ')}`,
            );
          if (field.sendsNull && !now.nullable) problems.push(`${name} no longer accepts null`);
          if (field.omits && now.required && !now.nullable)
            problems.push(`${name} is now required, and wow does not always send it`);
        } else if (
          !field.copes &&
          was.required &&
          !was.nullable &&
          (!now.required || now.nullable)
        ) {
          problems.push(`${name} may now be absent`);
        }
      });
    }
    if (side) {
      for (const [path, names] of builtObjects(expected[side])) {
        const required = installed.required[`${side}:${path}`];
        if (!required) continue;
        for (const name of required)
          if (!names.has(name))
            problems.push(
              `${method} now requires ${side}.${path === '' ? '' : `${path}.`}${name}, which wow does not send`,
            );
      }
    }
  }
  return { compatible: problems.length === 0, problems, doesWithout };
}
