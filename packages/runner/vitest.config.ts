import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Matches the default discovery this package relied on before this
    // config existed: unit tests live in test/*.test.ts.
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entrypoint wires signal handlers and calls main() at import
      // time — it is exercised by running the service, not unit tests.
      exclude: ['src/index.ts'],
      // Enforced floors, ratcheted up as coverage improves.
      thresholds: {
        lines: 30,
        statements: 30,
        functions: 40,
        branches: 78,
      },
    },
  },
});
