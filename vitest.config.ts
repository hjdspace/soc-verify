import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    globals: true,
    setupFiles: ['tests/setup.ts'],
  },
});
