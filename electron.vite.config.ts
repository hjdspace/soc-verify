import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        // node-pty is a native module with .node binaries — must not be
        // bundled by Rollup. Without this, the dynamic import('node-pty')
        // gets inlined into the CJS output and fails at runtime because the
        // native binary path resolution breaks.
        // better-sqlite3 is also a native module — same treatment.
        external: ['node-pty', 'better-sqlite3'],
      }
    },
    resolve: {
      alias: {
        '@main': resolve(import.meta.dirname, 'src/main'),
        '@shared': resolve(import.meta.dirname, 'src/shared')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, 'src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(import.meta.dirname, 'src/renderer/src'),
        '@shared': resolve(import.meta.dirname, 'src/shared'),
        '@main': resolve(import.meta.dirname, 'src/main')
      }
    },
    plugins: [react(), tailwindcss()]
  }
});
