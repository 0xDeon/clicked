import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 15000,
    // Only the TypeScript sources are tests. `pnpm build` emits a compiled
    // copy of every spec into dist/, which would otherwise be collected and
    // run a second time against stale output.
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
