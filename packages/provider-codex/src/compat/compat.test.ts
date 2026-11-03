import { describe, expect, it } from 'vitest';
import { codexProtocolFingerprint } from '../protocol/generated/fingerprint.js';
import {
  builtObjects,
  compareWithInstalled,
  fingerprintOf,
  parsePath,
  type FieldEntry,
  type MethodFingerprint,
  type ProtocolFingerprint,
} from './schema.js';
import { CompatibilityCache } from './check.js';
import { filesOf, synthesizeSchema } from './synthesize.js';
import { compareCodexVersions, parseCodexVersion } from './version.js';

type Json = Record<string, unknown>;

const tested = codexProtocolFingerprint;

// A copy of the tested fingerprint with one method changed, as another release would define it.
function changed(
  method: string,
  change: (entry: MethodFingerprint) => MethodFingerprint | undefined,
): ProtocolFingerprint {
  const methods: Record<string, MethodFingerprint> = {};
  for (const [name, entry] of Object.entries(tested.methods)) {
    const next = name === method ? change(entry) : entry;
    if (next) methods[name] = next;
  }
  return { codexVersion: '0.164.0', methods };
}

const withoutField =
  (path: string, side: 'params' | 'result' = 'params') =>
  (entry: MethodFingerprint) => ({
    ...entry,
    [side]: entry[side].filter((field: FieldEntry) => field.path !== path),
  });

const withShape =
  (path: string, shape: Partial<FieldEntry['shape']>, side: 'params' | 'result' = 'params') =>
  (entry: MethodFingerprint) => ({
    ...entry,
    [side]: entry[side].map((field: FieldEntry) =>
      field.path === path ? { ...field, shape: { ...field.shape, ...shape } } : field,
    ),
  });

const compare = (installed: ProtocolFingerprint) =>
  compareWithInstalled(tested, filesOf(synthesizeSchema(installed)));

describe('protocol fingerprint', () => {
  it('reads back from a schema made from it', () => {
    const files = filesOf(synthesizeSchema(tested));
    expect(fingerprintOf(files, tested.codexVersion, tested.methods)).toEqual(tested);
  });

  it('is compatible with an identical release', () => {
    expect(compare({ ...tested, codexVersion: '0.164.0' })).toEqual({
      compatible: true,
      problems: [],
      doesWithout: [],
    });
  });

  it('is compatible with a release that adds fields, variants and methods', () => {
    const files = synthesizeSchema(tested);
    const union = files.get('ServerNotification.json') as { oneOf: Json[]; definitions: Json };
    union.oneOf.push({
      properties: { method: { enum: ['thread/goal/updated'] }, params: { type: 'object' } },
    });
    for (const definition of Object.values(union.definitions) as Json[]) {
      (definition['properties'] as Json)['addedLater'] = { type: 'string' };
    }
    const thread = files.get('v2/Method3Response.json') as Json;
    (thread['properties'] as Json)['extra'] = { type: 'boolean' };
    expect(compareWithInstalled(tested, filesOf(files))).toMatchObject({ compatible: true });
  });

  it('does without fields and notifications marked as optional', () => {
    const installed = changed('thread/resume', withoutField('excludeTurns'));
    const withoutDelta = changed('item/reasoning/textDelta', () => undefined);
    expect(compare(installed)).toEqual({
      compatible: true,
      problems: [],
      doesWithout: ['thread/resume params.excludeTurns'],
    });
    expect(compare(withoutDelta).doesWithout).toEqual(['item/reasoning/textDelta']);
  });

  it('does without a read field that was already nullable, and a removed item variant', () => {
    const noNamespace = changed('item/started', withoutField('item<dynamicToolCall>.namespace'));
    expect(compare(noNamespace)).toMatchObject({ compatible: true });
    const noVariant = changed('item/started', (entry) => ({
      ...entry,
      params: entry.params
        .filter((field) => !field.path.startsWith('item<webSearch>'))
        .map((field) =>
          field.path === 'item.type'
            ? {
                ...field,
                shape: {
                  ...field.shape,
                  values: (field.shape.values ?? []).filter((value) => value !== 'webSearch'),
                },
              }
            : field,
        ),
    }));
    expect(compare(noVariant)).toEqual({
      compatible: true,
      problems: [],
      doesWithout: ['item/started params.item<webSearch>'],
    });
  });

  it('lists a missing required field, a changed type and a field that became optional', () => {
    const installed = changed('turn/completed', (entry) =>
      withShape('turn.id', { type: 'number' })(
        withShape('threadId', { required: false })(withoutField('turn.status')(entry)),
      ),
    );
    expect(compare(installed)).toEqual({
      compatible: false,
      problems: [
        'turn/completed params.threadId may now be absent',
        'turn/completed params.turn.id changed from string to number',
        'turn/completed params.turn.status is missing',
      ],
      doesWithout: [],
    });
  });

  it('names a renamed method as missing', () => {
    const methods = { ...tested.methods };
    const start = methods['turn/start'];
    delete methods['turn/start'];
    if (start) methods['turn/begin'] = start;
    expect(compare({ codexVersion: '0.164.0', methods })).toMatchObject({
      compatible: false,
      problems: ['turn/start is missing (renamed or removed)'],
    });
  });

  it('checks what wow sends: values, null and new required fields', () => {
    const files = synthesizeSchema(
      changed('thread/start', withShape('sandbox', { values: ['read-only', 'workspace-write'] })),
    );
    const requests = files.get('ClientRequest.json') as { definitions: Record<string, Json> };
    const initialize = requests.definitions['Method0Params'] as Json;
    (initialize['properties'] as Json)['protocolVersion'] = { type: 'string' };
    (initialize['required'] as string[]).push('protocolVersion');
    (initialize['properties'] as Json)['capabilities'] = { type: 'object' };
    expect(compareWithInstalled(tested, filesOf(files)).problems).toEqual([
      'initialize params.capabilities no longer accepts null',
      'initialize now requires params.protocolVersion, which wow does not send',
      'thread/start params.sandbox no longer accepts "danger-full-access"',
    ]);
  });

  it('knows which objects wow builds', () => {
    const built = builtObjects([
      { path: 'clientInfo.name' },
      { path: 'input[]<text>.text' },
      { path: 'sandboxPolicy<dangerFullAccess>' },
    ]);
    expect(Object.fromEntries([...built].map(([key, names]) => [key, [...names]]))).toEqual({
      '': ['clientInfo', 'input', 'sandboxPolicy'],
      clientInfo: ['name'],
      'input[]<text>': ['text'],
      'sandboxPolicy<dangerFullAccess>': [],
    });
    expect(() => parsePath('a..b')).toThrow(/Cannot read the field path/);
  });
});

describe('codex versions', () => {
  it('reads versions from the user agent part, --version and pre-releases', () => {
    expect(parseCodexVersion('0.164.0')).toEqual({
      major: 0,
      minor: 164,
      patch: 0,
      prerelease: '',
    });
    expect(parseCodexVersion('codex-cli 0.166.0')).toMatchObject({ minor: 166 });
    expect(parseCodexVersion('0.167.0-alpha.4')).toMatchObject({ prerelease: 'alpha.4' });
    expect(parseCodexVersion('codex')).toBeNull();
  });

  it('orders versions', () => {
    expect(compareCodexVersions('0.164.0', '0.166.0')).toBeLessThan(0);
    expect(compareCodexVersions('0.166.0', '0.166.0')).toBe(0);
    expect(compareCodexVersions('1.0.0', '0.166.0')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.167.0-alpha.2', '0.167.0')).toBeLessThan(0);
    expect(compareCodexVersions('0.167.0-alpha.10', '0.167.0-alpha.9')).toBeGreaterThan(0);
    expect(compareCodexVersions('x', '0.166.0')).toBeNull();
  });
});

describe('CompatibilityCache', () => {
  it('computes once per binary and version, and forgets a failure', async () => {
    const cache = new CompatibilityCache<string>();
    let runs = 0;
    const compute = () => {
      runs += 1;
      return Promise.resolve(`run ${runs}`);
    };
    await expect(cache.get('/bin/codex', '0.164.0', compute)).resolves.toBe('run 1');
    await expect(cache.get('/bin/codex', '0.164.0', compute)).resolves.toBe('run 1');
    await expect(cache.get('/bin/codex', '0.165.0', compute)).resolves.toBe('run 2');
    await expect(cache.get('/other/codex', '0.164.0', compute)).resolves.toBe('run 3');
    await expect(
      cache.get('/bin/codex', '0.163.0', () => Promise.reject(new Error('timed out'))),
    ).rejects.toThrow('timed out');
    await expect(cache.get('/bin/codex', '0.163.0', compute)).resolves.toBe('run 4');
    expect(cache.size).toBe(4);
  });
});
