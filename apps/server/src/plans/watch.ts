import { watch } from 'chokidar';
import path from 'node:path';

// One folder to watch. With `only`, the folder is watched for that one entry appearing or going
// away and nothing else in it.
export interface PlansWatchTarget {
  readonly dir: string;
  readonly only: string | null;
}

export interface PlansWatchOptions {
  // How long a file must keep its size before a change to it is reported.
  readonly settleMs: number;
}

export interface PlansWatcher {
  close(): Promise<void>;
}

// Resolves once the watcher reports changes, so a read that follows cannot miss one.
export type PlansWatchFactory = (
  targets: readonly PlansWatchTarget[],
  onChange: () => void,
  options: PlansWatchOptions,
) => PlansWatcher | Promise<PlansWatcher>;

export const chokidarPlansWatch: PlansWatchFactory = async (targets, onChange, { settleMs }) => {
  const folders = targets.filter((target) => target.only === null).map((target) => target.dir);
  const awaited = targets.flatMap((target) =>
    target.only === null ? [] : [{ dir: target.dir, entry: path.join(target.dir, target.only) }],
  );
  const watchers = [
    // <intents>/<id>/{intent,spec,plan}.md, hence depth 1. An editor that saves in place empties
    // the file before it writes it, and a read in between would see an empty plan with no later
    // change to correct it, so a change is only reported once the file has stopped growing.
    ...(folders.length > 0
      ? [
          watch(folders, {
            ignoreInitial: true,
            depth: 1,
            ...(settleMs > 0 ? { awaitWriteFinish: { stabilityThreshold: settleMs } } : {}),
          }),
        ]
      : []),
    ...(awaited.length > 0
      ? [
          watch(
            awaited.map((target) => target.dir),
            {
              ignoreInitial: true,
              depth: 0,
              ignored: (file) => {
                const found = path.resolve(file);
                return !awaited.some((target) => found === target.dir || found === target.entry);
              },
            },
          ),
        ]
      : []),
  ];
  for (const watcher of watchers) {
    watcher.on('all', () => onChange());
    // A folder that disappears or cannot be read is picked up again by the next read.
    watcher.on('error', () => onChange());
  }
  await Promise.all(
    watchers.map(
      (watcher) =>
        new Promise<void>((resolve) => {
          watcher.once('ready', resolve);
        }),
    ),
  );
  return {
    close: async () => {
      await Promise.all(watchers.map((watcher) => watcher.close()));
    },
  };
};
