import { defineConfig } from 'vitest/config';

// Many server tests make a Git repository, a bare remote and a clone before each case. On the
// Windows runner starting those processes now and then takes several seconds each, and three
// cases in a row once ran out of the ten seconds a hook gets by default. A hook that really
// hangs still fails, later.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
