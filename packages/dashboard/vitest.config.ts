import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" → "./src/*" path alias.
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
    // Node by default; files that need a DOM (localStorage, window) opt in
    // with a `// @vitest-environment jsdom` pragma.
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Components and pages are exercised by hand/e2e for now — the unit
      // suite covers the lib layer, so scope the metric to what the tests
      // are responsible for. Widen this as component tests land.
      include: ['src/lib/**/*.ts'],
    },
  },
});
