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
    // forks 池：每个测试文件在独立子进程中运行，天然隔离全局状态、mock 和定时器
    pool: 'forks',
    // isolate: true（默认）确保每个测试文件获得干净的模块注册表
    isolate: true,
    // 开启文件级并行执行（原 fileParallelism: false 导致 ~190 个测试文件全部串行）
    fileParallelism: true,
    // 限制最大并行 worker 数，避免内存/CPU 过载
    maxWorkers: 8,
  },
});
