import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['packages/format/src/**'],
      exclude: ['**/*.test.ts', '**/cli.ts', '**/index.ts'],
    },
  },
});
