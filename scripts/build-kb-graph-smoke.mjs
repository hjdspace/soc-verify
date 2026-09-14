/**
 * 构建图视图冒烟 harness（issue 26）。
 *
 * 复用 electron.vite.config.ts 的 renderer 段（同一套 alias / React 插件 /
 * Tailwind），只替换三件事：root、入口 HTML、以及把 @renderer/lib/trpc
 * 换成 harness 的传输替身。这样冒烟跑到的组件、CSS 处理与分包规则与产品
 * 渲染进程一致，而不是另起一套「看起来差不多」的配置。
 */

import { build } from 'vite';
import { createJiti } from 'jiti';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harnessRoot = resolve(repositoryRoot, 'tests', 'smoke', 'kb-graph');
const outDir = process.env.KB_GRAPH_SMOKE_OUT ?? resolve(repositoryRoot, 'dist', 'kb-graph-smoke');

const jiti = createJiti(import.meta.url, { interopDefault: true });
const loaded = await jiti.import(resolve(repositoryRoot, 'electron.vite.config.ts'));
const config = loaded.default ?? loaded;
const rendererConfig = config.renderer;
if (!rendererConfig) throw new Error('electron.vite.config.ts 缺少 renderer 配置');

const aliases = [
  // 传输层替身必须先于 @renderer 别名匹配
  { find: /^@renderer\/lib\/trpc$/, replacement: resolve(harnessRoot, 'stub-trpc.ts') },
  ...Object.entries(rendererConfig.resolve?.alias ?? {}).map(([find, replacement]) => ({
    find,
    replacement,
  })),
];

await build({
  configFile: false,
  root: harnessRoot,
  // file:// 加载需要相对路径
  base: './',
  mode: 'production',
  plugins: rendererConfig.plugins ?? [],
  resolve: { alias: aliases },
  // 布局 worker 使用 { type: 'module' }，需要 ES 输出才能保留 import 语义
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: true,
    // 与打包目标一致（Electron 43 = Chromium 138 级别）
    target: 'chrome134',
    sourcemap: false,
    minify: false,
    rollupOptions: { input: resolve(harnessRoot, 'index.html') },
  },
});

process.stdout.write(`[kb-graph-smoke] harness 构建完成：${outDir}\n`);
