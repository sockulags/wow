import fg from 'fast-glob';

export type ArtifactDetector = (cwd: string, globs: readonly string[]) => Promise<string[]>;

// Files in the project folder matching a step's expected artifact globs, as forward-slash paths
// relative to the folder. A missing folder finds nothing.
export const detectArtifacts: ArtifactDetector = async (cwd, globs) => {
  if (globs.length === 0) return [];
  const found = await fg([...globs], {
    cwd,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  return found.toSorted();
};
