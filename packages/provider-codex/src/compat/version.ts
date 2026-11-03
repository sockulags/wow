export interface CodexVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  // "alpha.1" in 0.167.0-alpha.1; empty for a release.
  readonly prerelease: string;
}

// Reads "0.164.0", "codex-cli 0.164.0" (`codex --version`) or "0.167.0-alpha.1".
export function parseCodexVersion(text: string): CodexVersion | null {
  const match = /(?:^|[\s/v])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+\S*)?\s*$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

const comparePrerelease = (a: string, b: string): number => {
  if (a === b) return 0;
  // A release is newer than any of its pre-releases.
  if (a === '') return 1;
  if (b === '') return -1;
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (order !== 0) return Math.sign(order);
  }
  return 0;
};

// Negative when a is older than b, positive when newer, 0 when equal; null when either is not a
// version.
export function compareCodexVersions(a: string, b: string): number | null {
  const left = parseCodexVersion(a);
  const right = parseCodexVersion(b);
  if (!left || !right) return null;
  return (
    Math.sign(left.major - right.major) ||
    Math.sign(left.minor - right.minor) ||
    Math.sign(left.patch - right.patch) ||
    comparePrerelease(left.prerelease, right.prerelease)
  );
}
