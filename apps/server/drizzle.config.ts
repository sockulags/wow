import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @wow/server db:generate` writes a new migration after a schema change.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
  casing: 'snake_case',
});
