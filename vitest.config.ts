import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 90,
        lines: 80,
      },
    },
  },
});
