import { defineConfig } from 'vitest/config';

// These tests start a real server, SQLite file and often a Git repository each. On the Windows
// runner single cases take 4 to 5 seconds and hooks longer, which is the default limit.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });
