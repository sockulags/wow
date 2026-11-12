import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // tsc -b writes declarations to dist/types; keep the bundle beside it, not over it.
  build: { outDir: 'dist/app' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    css: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'web',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      // The e2e server's helpers run in Node; their files end in .vitest.ts so Playwright skips them.
      {
        extends: true,
        test: { name: 'e2e-helpers', include: ['e2e/**/*.vitest.ts'], environment: 'node' },
      },
    ],
  },
});
