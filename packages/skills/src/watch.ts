import { watch } from 'chokidar';
import type { SkillRoot } from './scan.js';

export interface SkillWatcher {
  close(): Promise<void>;
}

export type WatchFactory = (dirs: readonly string[], onChange: () => void) => SkillWatcher;

// Watches <root>/<skill>/SKILL.md and <root>/<skill>/agents/openai.yaml, hence depth 2.
export const chokidarWatch: WatchFactory = (dirs, onChange) => {
  const watcher = watch([...dirs], { ignoreInitial: true, depth: 2 });
  watcher.on('all', () => onChange());
  // A root that disappears or cannot be read is picked up again by the next scan.
  watcher.on('error', () => onChange());
  return { close: () => watcher.close() };
};

export function watchSkillRoots(
  roots: readonly SkillRoot[],
  onChange: () => void,
  factory: WatchFactory = chokidarWatch,
): SkillWatcher {
  return factory(
    roots.map((root) => root.dir),
    onChange,
  );
}
