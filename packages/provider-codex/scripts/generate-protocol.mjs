// Regenerates src/protocol/generated from the protocol definitions of an installed codex binary.
//
//   pnpm --filter @wow/provider-codex generate:protocol [path/to/codex]
//
// `codex app-server generate-ts` writes TypeScript for the whole app-server protocol. This script
// keeps only the methods the adapter uses (METHODS below) and the types they reach, adds the `.js`
// extensions NodeNext needs, writes typed method maps read from ClientRequest.ts,
// ServerNotification.ts and ServerRequest.ts, and records the codex version. A method the installed
// codex no longer defines fails the script instead of leaving stale names in the adapter.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const prettier = createRequire(join(packageDir, 'package.json')).resolve(
    'prettier/bin/prettier.cjs',
  );
  execFileSync(process.execPath, [prettier, '--write', '--log-level', 'warn', outDir], {
    stdio: 'inherit',
  });
  process.stdout.write(
    `Wrote ${keep.size + 1} files for codex ${codexVersion} to ${relative(packageDir, outDir)}\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
