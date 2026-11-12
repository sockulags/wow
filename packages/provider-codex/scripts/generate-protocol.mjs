// Regenerates src/protocol/generated from the protocol definitions of an installed codex binary.
//
//   pnpm --filter @wow/provider-codex generate:protocol [path/to/codex]
//
// `codex app-server generate-ts` writes TypeScript for the whole app-server protocol. This script
// keeps only the methods the adapter uses (METHODS below) and the types they reach, adds the `.js`
// extensions NodeNext needs, writes typed method maps read from ClientRequest.ts,
// ServerNotification.ts and ServerRequest.ts, and records the codex version. A method the installed
// codex no longer defines fails the script instead of leaving stale names in the adapter.
//
// It also writes fingerprint.ts: the fields of FIELDS below with their types, read from
// `codex app-server generate-json-schema`. The adapter compares it with the schema of an installed
// codex of another version (src/compat). A field FIELDS names that the release does not define
// fails the script. Needs Node 22.18 or newer, which imports src/compat/schema.ts as TypeScript.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const METHODS = {
  clientRequests: [
    'initialize',
    'account/read',
    'model/list',
    'thread/start',
    'thread/resume',
    'turn/start',
    'turn/interrupt',
  ],
  clientNotifications: ['initialized'],
  serverNotifications: [
    'error',
    'thread/tokenUsage/updated',
    'turn/started',
    'turn/completed',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'serverRequest/resolved',
  ],
  serverRequests: [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
  ],
};

// The fields the adapter sends and reads, per method of METHODS. Paths are described in
// src/compat/schema.ts. Suffixes: `?` the adapter copes when codex lacks the field (on a method:
// the notification or request); `~` the adapter leaves the sent field out on some requests;
// `=null` it may send null; `=a|b` the enum values or union tags it sends. When the adapter starts
// to send or read another field, add it here and regenerate.
const toolItem = [
  'item.type',
  'item.id',
  'item<commandExecution>.command',
  'item<commandExecution>.cwd?',
  'item<fileChange>.changes',
  'item<fileChange>.changes[].path',
  'item<fileChange>.changes[].kind.type',
  'item<mcpToolCall>.server',
  'item<mcpToolCall>.tool',
  'item<mcpToolCall>.arguments',
  'item<dynamicToolCall>.namespace?',
  'item<dynamicToolCall>.tool',
  'item<dynamicToolCall>.arguments',
  'item<webSearch>.query',
  'item<imageView>.path',
];
const delta = ['threadId', 'itemId', 'delta'];
const approvalPolicy = 'approvalPolicy=on-request|untrusted|never';
const sandbox = 'sandbox=read-only|workspace-write|danger-full-access';
const FIELDS = {
  initialize: {
    params: ['clientInfo.name', 'clientInfo.title', 'clientInfo.version', 'capabilities=null'],
    result: ['userAgent'],
  },
  'account/read': {
    params: ['refreshToken'],
    result: [
      'account',
      'account.type',
      'account<chatgpt>.email?',
      'account<chatgpt>.planType?',
      'requiresOpenaiAuth',
    ],
  },
  'model/list': {
    params: ['cursor=null', 'includeHidden'],
    result: [
      'data',
      'data[].model',
      'data[].displayName',
      'data[].description',
      'data[].hidden',
      'data[].isDefault',
      'data[].supportedReasoningEfforts',
      'data[].supportedReasoningEfforts[].reasoningEffort',
      'data[].defaultReasoningEffort',
      'data[].inputModalities?',
      'nextCursor?',
    ],
  },
  'thread/start': {
    params: ['cwd', 'model', approvalPolicy, sandbox],
    result: ['thread.id'],
  },
  'thread/resume': {
    params: ['threadId', 'cwd', 'model', approvalPolicy, sandbox, 'excludeTurns?'],
    result: ['thread.id'],
  },
  'turn/start': {
    params: [
      'threadId',
      'input',
      'input[]<text>.text',
      'input[]<text>.text_elements',
      'input[]<localImage>.path?',
      'cwd',
      'model',
      'effort',
      approvalPolicy,
      'sandboxPolicy~=readOnly|workspaceWrite|dangerFullAccess',
      'sandboxPolicy<readOnly>.networkAccess',
      'sandboxPolicy<workspaceWrite>.writableRoots',
      'sandboxPolicy<workspaceWrite>.networkAccess',
      'sandboxPolicy<workspaceWrite>.excludeTmpdirEnvVar',
      'sandboxPolicy<workspaceWrite>.excludeSlashTmp',
      'sandboxPolicy<dangerFullAccess>',
    ],
    result: ['turn.id'],
  },
  'turn/interrupt': { params: ['threadId', 'turnId'] },
  initialized: {},
  'error?': {
    params: ['threadId', 'willRetry', 'error.message', 'error.additionalDetails?'],
  },
  'thread/tokenUsage/updated?': {
    params: [
      'threadId',
      'tokenUsage.total.totalTokens',
      'tokenUsage.total.inputTokens',
      'tokenUsage.total.cachedInputTokens',
      'tokenUsage.total.cacheWriteInputTokens?',
      'tokenUsage.total.outputTokens',
      'tokenUsage.total.reasoningOutputTokens',
      'tokenUsage.last.totalTokens',
      'tokenUsage.modelContextWindow?',
    ],
  },
  'turn/started?': { params: ['threadId', 'turn.id'] },
  'turn/completed': {
    params: ['threadId', 'turn.id', 'turn.status', 'turn.error?', 'turn.error.message?'],
  },
  'turn/plan/updated?': {
    params: ['threadId', 'turnId', 'plan', 'plan[].step', 'plan[].status'],
  },
  'item/started': { params: ['threadId', ...toolItem] },
  'item/completed': {
    params: [
      'threadId',
      ...toolItem,
      'item<agentMessage>.text',
      'item<reasoning>.summary',
      'item<commandExecution>.aggregatedOutput?',
      'item<commandExecution>.status',
      'item<commandExecution>.exitCode?',
      'item<fileChange>.changes[].diff?',
      'item<fileChange>.status',
      'item<mcpToolCall>.status',
      'item<mcpToolCall>.error?',
      'item<mcpToolCall>.error.message?',
      'item<mcpToolCall>.result?',
      'item<mcpToolCall>.result.content?',
      'item<dynamicToolCall>.status',
      'item<dynamicToolCall>.contentItems?',
      'item<dynamicToolCall>.success?',
    ],
  },
  'item/agentMessage/delta?': { params: delta },
  'item/reasoning/summaryTextDelta?': { params: delta },
  'item/reasoning/textDelta?': { params: delta },
  'item/commandExecution/outputDelta?': { params: delta },
  'item/fileChange/outputDelta?': { params: delta },
  'serverRequest/resolved?': { params: ['requestId'] },
  'item/commandExecution/requestApproval': {
    params: ['threadId', 'command?', 'reason?'],
    result: ['decision=accept|acceptForSession|decline'],
  },
  'item/fileChange/requestApproval': {
    params: ['threadId', 'itemId', 'reason?'],
    result: ['decision=accept|acceptForSession|decline'],
  },
  'item/permissions/requestApproval?': {
    params: [
      'threadId',
      'reason?',
      'permissions',
      'permissions.network?',
      'permissions.fileSystem?',
    ],
    result: [
      'permissions',
      'permissions.network~',
      'permissions.fileSystem~',
      'scope=turn|session',
    ],
  },
  'item/tool/requestUserInput?': {
    params: [
      'threadId',
      'questions',
      'questions[].id',
      'questions[].header?',
      'questions[].question',
      'questions[].options?',
      'questions[].options[].label',
      'questions[].options[].description',
    ],
    result: ['answers', 'answers{}.answers'],
  },
};

// "path?~=a|b" → {path, copes, omits, sendsNull, sends}
const fieldUse = (entry) => {
  const match = /^([^?~=]+)([?~]*)(?:=(.*))?$/.exec(entry);
  if (!match) throw new Error(`Cannot read the FIELDS entry "${entry}"`);
  const [, path, flags, values] = match;
  return {
    path,
    ...(flags.includes('?') ? { copes: true } : {}),
    ...(flags.includes('~') ? { omits: true } : {}),
    ...(values === 'null' ? { sendsNull: true } : {}),
    ...(values && values !== 'null' ? { sends: values.split('|') } : {}),
  };
};

const kinds = {
  clientRequests: 'clientRequest',
  clientNotifications: 'clientNotification',
  serverNotifications: 'serverNotification',
  serverRequests: 'serverRequest',
};
const kindOf = new Map(
  Object.entries(kinds).flatMap(([group, kind]) => METHODS[group].map((method) => [method, kind])),
);
const uses = {};
for (const [key, use] of Object.entries(FIELDS)) {
  const method = key.replace(/\?$/, '');
  const kind = kindOf.get(method);
  if (!kind) throw new Error(`FIELDS names ${method}, which METHODS does not list`);
  uses[method] = {
    kind,
    ...(key.endsWith('?') ? { copes: true } : {}),
    params: (use.params ?? []).map(fieldUse),
    result: (use.result ?? []).map(fieldUse),
  };
}
for (const method of kindOf.keys())
  if (!uses[method]) throw new Error(`FIELDS does not describe ${method}`);

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(packageDir, 'src', 'protocol', 'generated');
const codex = process.argv[2] ?? process.env['CODEX_BIN'] ?? 'codex';
// The npm-installed codex is a .cmd shim on Windows, which only starts through a shell.
const shell = process.platform === 'win32';

const versionText = execFileSync(codex, ['--version'], { encoding: 'utf8', shell }).trim();
const versionMatch = /(\d+\.\d+\.\d+\S*)$/.exec(versionText);
if (!versionMatch) throw new Error(`Cannot read a version from "${versionText}"`);
const codexVersion = versionMatch[1];

const work = mkdtempSync(join(tmpdir(), 'wow-codex-protocol-'));
try {
  execFileSync(codex, ['app-server', 'generate-ts', '--out', work], { stdio: 'inherit', shell });
  const schemaDir = join(work, 'json-schema');
  execFileSync(codex, ['app-server', 'generate-json-schema', '--out', schemaDir], {
    stdio: 'inherit',
    shell,
  });
  const { fingerprintOf } = await import(
    pathToFileURL(join(packageDir, 'src', 'compat', 'schema.ts')).href
  );
  const schemaFile = (file) => {
    const full = join(schemaDir, ...file.split('/'));
    return existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : undefined;
  };
  const fingerprint = fingerprintOf(schemaFile, codexVersion, uses);
  const read = (file) => readFileSync(join(work, file), 'utf8');
  const importsOf = (file) =>
    [...read(file).matchAll(/import type \{ (\w+) \} from "(\.{1,2}\/[^"]+)"/g)].map(
      ([, name, from]) => ({
        name,
        file: posix.normalize(posix.join(posix.dirname(file), `${from}.ts`)),
      }),
    );

  const missing = [];
  const fileOf = new Map();
  const pick = (unionFile, pattern, names, withResponse) => {
    const union = new Map([...read(unionFile).matchAll(pattern)].map((m) => [m[1], m[2]]));
    const paths = new Map(importsOf(unionFile).map((entry) => [entry.name, entry.file]));
    return names.flatMap((method) => {
      const params = union.get(method);
      const paramsFile = params && paths.get(params);
      if (!params || !paramsFile) {
        missing.push(method);
        return [];
      }
      fileOf.set(params, paramsFile);
      if (!withResponse) return [{ method, params }];
      const response = params.replace(/Params$/, 'Response');
      const responseFile = posix.join(posix.dirname(paramsFile), `${response}.ts`);
      if (!existsSync(join(work, responseFile))) {
        missing.push(`${method} (${response})`);
        return [];
      }
      fileOf.set(response, responseFile);
      return [{ method, params, response }];
    });
  };
  const request = /"method": "([^"]+)", id: RequestId, params: (\w+)/g;
  const requests = pick('ClientRequest.ts', request, METHODS.clientRequests, true);
  const incoming = pick('ServerRequest.ts', request, METHODS.serverRequests, true);
  const notifications = pick(
    'ServerNotification.ts',
    /"method": "([^"]+)", "params": (\w+)/g,
    METHODS.serverNotifications,
    false,
  );
  const clientNotifications = new Set(
    [...read('ClientNotification.ts').matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]),
  );
  for (const name of METHODS.clientNotifications)
    if (!clientNotifications.has(name)) missing.push(name);
  if (missing.length > 0)
    throw new Error(`codex ${codexVersion} does not define: ${missing.join(', ')}`);
  fileOf.set('RequestId', 'RequestId.ts');

  const keep = new Set();
  const queue = [...fileOf.values()];
  while (queue.length > 0) {
    const file = queue.pop();
    if (keep.has(file)) continue;
    keep.add(file);
    for (const entry of importsOf(file)) queue.push(entry.file);
  }

  rmSync(outDir, { recursive: true, force: true });
  for (const file of keep) {
    mkdirSync(dirname(join(outDir, file)), { recursive: true });
    writeFileSync(
      join(outDir, file),
      read(file).replace(/from "(\.{1,2}\/[^"]+)"/g, 'from "$1.js"'),
    );
  }

  const names = [...fileOf.keys()].toSorted();
  const lines = [
    `// Generated by scripts/generate-protocol.mjs from codex ${codexVersion}. Do not edit by hand.`,
    '',
    ...names.map(
      (name) => `import type { ${name} } from './${fileOf.get(name).replace(/\.ts$/, '.js')}';`,
    ),
    '',
    `export type { ${names.join(', ')} };`,
    '',
    '// The codex version these definitions were generated from.',
    `export const codexProtocolVersion = '${codexVersion}';`,
    '',
    'export interface ClientRequests {',
    ...requests.map((e) => `  '${e.method}': { params: ${e.params}; result: ${e.response} };`),
    '}',
    '',
    `export type ClientNotificationMethod = ${METHODS.clientNotifications.map((m) => `'${m}'`).join(' | ')};`,
    '',
    'export interface ServerNotifications {',
    ...notifications.map((e) => `  '${e.method}': ${e.params};`),
    '}',
    '',
    'export interface ServerRequests {',
    ...incoming.map((e) => `  '${e.method}': { params: ${e.params}; result: ${e.response} };`),
    '}',
    '',
  ];
  writeFileSync(join(outDir, 'index.ts'), lines.join('\n'));
  writeFileSync(
    join(outDir, 'fingerprint.ts'),
    [
      `// Generated by scripts/generate-protocol.mjs from codex ${codexVersion}. Do not edit by hand.`,
      '// The fields the adapter sends and reads, with their types in that release (src/compat).',
      '',
      "import type { ProtocolFingerprint } from '../../compat/schema.js';",
      '',
      `export const codexProtocolFingerprint: ProtocolFingerprint = ${JSON.stringify(fingerprint)};`,
      '',
    ].join('\n'),
  );

  const prettier = createRequire(join(packageDir, 'package.json')).resolve(
    'prettier/bin/prettier.cjs',
  );
  execFileSync(process.execPath, [prettier, '--write', '--log-level', 'warn', outDir], {
    stdio: 'inherit',
  });
  process.stdout.write(
    `Wrote ${keep.size + 2} files for codex ${codexVersion} to ${relative(packageDir, outDir)}\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
