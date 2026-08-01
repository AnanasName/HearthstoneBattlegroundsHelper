import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Прогон fixture-логов целиком — десятки мегабайт, дефолтных 5 с не хватит.
    testTimeout: 30_000,
  },
});
