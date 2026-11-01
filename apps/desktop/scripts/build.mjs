// Builds the desktop app into out/:
//   out/main/index.js       Electron main (ESM), everything but electron bundled
//   out/preload/index.cjs   sandboxed preload (CommonJS, as Electron requires)
//   out/server/server.mjs   the server bundle, started by main with ELECTRON_RUN_AS_NODE=1
//   out/server/...          files the server reads beside its sources, at their repository paths
//   out/server/native/better-sqlite3   the one native dependency, with its N-API prebuilds
//   out/renderer/           the built web app (apps/web/dist/app)
//   out/assets/             window and tray icons
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(desktopDir, '../..');
const outDir = path.join(desktopDir, 'out');
const serverDir = path.join(repoRoot, 'apps', 'server');
const webDist = path.join(repoRoot, 'apps', 'web', 'dist', 'app');

// Bundled CommonJS (ws, drizzle) calls require() for Node built-ins, which an ESM bundle only has
// through createRequire.
const esmRequireBanner = {
  js: "import { createRequire as __wowCreateRequire } from 'node:module'; const require = __wowCreateRequire(import.meta.url);",
};
// Optional speedups that ws loads inside try/catch.
const optionalNative = ['bufferutil', 'utf-8-validate'];

const toPosix = (file) => file.split(path.sep).join('/');
const isRepoSource = (file) =>
  file.startsWith(repoRoot + path.sep) && !file.split(path.sep).includes('node_modules');

// Server code finds files next to its sources with `new URL('<relative>', import.meta.url)`
// (package.json, migrations, Outlook fixtures, bridge.ps1). In one bundle every module would share
// the bundle's URL, so each module's import.meta.url is replaced by its repository path resolved
// against the bundle, and every file such an expression names is copied to that same place.
function serverAssetsPlugin(assets) {
  const literalUrl = /new URL\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
  return {
    name: 'wow-server-assets',
    setup(context) {
      context.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        if (!isRepoSource(args.path)) return undefined;
        const source = await readFile(args.path, 'utf8');
        if (!source.includes('import.meta.url')) return undefined;
        for (const match of source.matchAll(literalUrl)) {
          assets.add(path.resolve(path.dirname(args.path), match[2]));
        }
        const relative = JSON.stringify(toPosix(path.relative(repoRoot, args.path)));
        const contents = source.replaceAll(
          'import.meta.url',
          `new URL(${relative}, import.meta.url).href`,
        );
        const loader = path.extname(args.path).slice(1).replace(/^[cm]/, '');
        return { contents, loader, resolveDir: path.dirname(args.path) };
      });
    },
  };
}

// better-sqlite3 stays outside the bundle and is imported from a path next to it. Not from a
// node_modules folder: electron-builder leaves node_modules out of extraResources.
const sqliteImport = './native/better-sqlite3/lib/index.js';
const nativeSqlitePlugin = {
  name: 'wow-native-sqlite',
  setup(context) {
    context.onResolve({ filter: /^better-sqlite3$/ }, () => ({
      path: sqliteImport,
      external: true,
    }));
  },
};

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function buildServer() {
  const assets = new Set();
  const target = path.join(outDir, 'server');
  await build({
    stdin: {
      contents: [
        `import { installShutdownBridge } from ${JSON.stringify(path.join(desktopDir, 'src/server/shutdown-bridge.ts'))};`,
        'installShutdownBridge(process);',
        `await import(${JSON.stringify(path.join(serverDir, 'src/main.ts'))});`,
      ].join('\n'),
      resolveDir: desktopDir,
      sourcefile: 'server-entry.ts',
      loader: 'ts',
    },
    outfile: path.join(target, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    banner: esmRequireBanner,
    external: optionalNative,
    plugins: [nativeSqlitePlugin, serverAssetsPlugin(assets)],
    logLevel: 'warning',
  });
  for (const asset of assets) {
    if (!(await exists(asset))) throw new Error(`Server asset not found: ${asset}`);
    await cp(asset, path.join(target, path.relative(repoRoot, asset)), { recursive: true });
  }
  // better-sqlite3 13 ships N-API prebuilds for each platform and loads them at runtime; N-API
  // binaries run under Electron's Node unchanged, so nothing is rebuilt.
  const serverRequire = createRequire(path.join(serverDir, 'package.json'));
  const sqliteDir = path.dirname(serverRequire.resolve('better-sqlite3/package.json'));
  const sqliteTarget = path.join(target, path.dirname(path.dirname(sqliteImport)));
  for (const entry of ['package.json', 'LICENSE', 'lib', 'prebuilds']) {
    await cp(path.join(sqliteDir, entry), path.join(sqliteTarget, entry), { recursive: true });
  }
  return [...assets].map((asset) => toPosix(path.relative(repoRoot, asset)));
}

async function buildMain() {
  await build({
    entryPoints: [path.join(desktopDir, 'src/main/index.ts')],
    outfile: path.join(outDir, 'main', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    banner: esmRequireBanner,
    external: ['electron', ...optionalNative],
    logLevel: 'warning',
  });
  await build({
    entryPoints: [path.join(desktopDir, 'src/preload/index.ts')],
    outfile: path.join(outDir, 'preload', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
  });
}

async function copyRenderer() {
  if (!(await exists(path.join(webDist, 'index.html'))))
    throw new Error(
      `Build the web app first (pnpm --filter @wow/web build): ${webDist} is missing`,
    );
  await cp(webDist, path.join(outDir, 'renderer'), { recursive: true });
  await cp(path.join(desktopDir, 'build', 'icon.png'), path.join(outDir, 'assets', 'icon.png'));
  await cp(path.join(desktopDir, 'build', 'tray.png'), path.join(outDir, 'assets', 'tray.png'));
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const [assets] = await Promise.all([buildServer(), buildMain(), copyRenderer()]);
process.stdout.write(`desktop build written to ${outDir}\nserver assets: ${assets.join(', ')}\n`);
