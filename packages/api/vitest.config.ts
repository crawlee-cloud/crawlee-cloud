import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Enforced floors, ratcheted up as coverage improves. Set via
      // `npm run test:coverage` in CI; a drop below these fails the build.
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 74,
      },
    },
  },
});
