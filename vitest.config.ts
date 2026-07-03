import { defineConfig } from 'vitest/config';

// vitest 3 pin + ≥80% coverage gate.
// Coverage threshold is exercised by `npm run test:coverage` in CI; the
// default `npm test` runs without coverage instrumentation for speed.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
