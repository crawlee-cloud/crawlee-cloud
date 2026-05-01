import { defineConfig } from 'vitest/config';

// CLI integration tests live under test/integration/ and require a running
// API server at localhost:3000. They're invoked via the dedicated
// `test:integration` script (see vitest.integration.config.ts) — exclude
// them from the default discovery so a plain `vitest run` (CI's unit-tests
// job, contributors running `npm test` without infra up) doesn't try to
// hit the network.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    // The cli package has no non-integration tests yet. Without this,
    // a workspace-level `vitest run` exits 1 here ("no test files found")
    // and fails CI. Once a unit test lands, this can come out.
    passWithNoTests: true,
  },
});
