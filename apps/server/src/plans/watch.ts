import { watch } from 'chokidar';

// An intents folder to watch. Only folders that exist are watched: chokidar waits for a missing
// one by watching the folder above it, and on Windows a watched folder cannot be renamed or
// removed, so that would hold the project folder.
export interface PlansWatchTarget {
  readonly dir: string;
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
  const folders = targets.map((target) => target.dir);
  const watchers =
    // <intents>/<id>/{intent,spec,plan}.md, hence depth 1. An editor that saves in place empties
    // the file before it writes it, and a read in between would see an empty plan with no later
    // change to correct it, so a change is only reported once the file has stopped growing.
    folders.length > 0
      ? [
          watch(folders, {
            ignoreInitial: true,
            depth: 1,
            ...(settleMs > 0 ? { awaitWriteFinish: { stabilityThreshold: settleMs } } : {}),
          }),
        ]
      : [];
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
