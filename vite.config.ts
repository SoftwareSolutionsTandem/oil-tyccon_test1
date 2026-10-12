import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Относительные пути — сборку можно открыть с любого хостинга (например, GitHub Pages).
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
