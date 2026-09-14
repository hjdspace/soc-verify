#!/usr/bin/env node
/**
 * prepare-pdfjs-runtime — 把 pdfjs 本地运行时物化到 resources/pdfjs（issue 11）。
 *
 * 产物布局（pdf-runtime.ts 的 resolvePdfRuntimePaths 按此解析）：
 *   resources/pdfjs/legacy/build/pdf.mjs + pdf.worker.mjs   legacy ESM 入口 + fake worker
 *   resources/pdfjs/standard_fonts/  cmaps/  wasm/          本地字体/字符映射/解码器
 *   resources/pdfjs/node_modules/@napi-rs/canvas(+平台包)   pdf.mjs 的 createRequire 解析基座
 *
 * 为什么必须复制而不是直接引用 node_modules：
 *  1. pdfjs 在 Node 下从 pdf.mjs 位置 createRequire('@napi-rs/canvas')——
 *     打包后 node_modules 不随 app 出盘，资源必须自包含且与 pdf.mjs 相邻。
 *  2. pdf.mjs 与 pdf.worker.mjs 必须保持相邻（fake worker 就地 import）。
 *  3. 平台包（@napi-rs/canvas-<platform>-<arch>）是 npm optional dependency，
 *     只在当前平台安装；打包机与目标机一致时复制当前平台即可。
 *
 * 用法：npm run prepare:pdfjs（幂等，重复执行重建目录）
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pdfjsDist = join(root, 'node_modules', 'pdfjs-dist');
const canvasPkg = join(root, 'node_modules', '@napi-rs', 'canvas');
const dest = join(root, 'resources', 'pdfjs');

function fail(message) {
  console.error(`[prepare:pdfjs] ${message}`);
  process.exit(1);
}

if (!existsSync(pdfjsDist)) fail('未找到 node_modules/pdfjs-dist，请先 npm install');
if (!existsSync(canvasPkg)) fail('未找到 node_modules/@napi-rs/canvas，请先 npm install');

// ── pdfjs 包内容 ────────────────────────────────────────────────

const version = JSON.parse(readFileSync(join(pdfjsDist, 'package.json'), 'utf-8')).version;

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

cpSync(join(pdfjsDist, 'legacy', 'build'), join(dest, 'legacy', 'build'), { recursive: true });
cpSync(join(pdfjsDist, 'standard_fonts'), join(dest, 'standard_fonts'), { recursive: true });
cpSync(join(pdfjsDist, 'cmaps'), join(dest, 'cmaps'), { recursive: true });
cpSync(join(pdfjsDist, 'wasm'), join(dest, 'wasm'), { recursive: true });

// ── @napi-rs/canvas（pdfjs 的 DOMMatrix/ImageData 垫片基座） ────

const canvasDest = join(dest, 'node_modules', '@napi-rs', 'canvas');
cpSync(canvasPkg, canvasDest, { recursive: true });

// 平台二进制是 sibling optional dependency（@napi-rs/canvas-<platform>-<arch>[-msvc]），
// 复制当前平台对应的包（gnu/musl 变体同名前缀都带上）。
const currentPrefix = `canvas-${process.platform}-${process.arch}`;
const siblings = readdirSync(join(root, 'node_modules', '@napi-rs'));
const picked = siblings.filter((n) => n.startsWith(currentPrefix));
for (const name of picked) {
  cpSync(
    join(root, 'node_modules', '@napi-rs', name),
    join(dest, 'node_modules', '@napi-rs', name),
    { recursive: true },
  );
}

// ── 自检 ────────────────────────────────────────────────────────

const required = [
  join(dest, 'legacy', 'build', 'pdf.mjs'),
  join(dest, 'legacy', 'build', 'pdf.worker.mjs'),
  join(dest, 'standard_fonts'),
  join(dest, 'cmaps'),
  join(dest, 'wasm'),
  join(canvasDest, 'index.js'),
];
for (const p of required) {
  if (!existsSync(p)) fail(`产物自检失败：缺少 ${p}`);
}

console.log(
  `[prepare:pdfjs] pdfjs-dist ${version} → resources/pdfjs 已就绪`
    + `（平台包: ${picked.join(', ') || '无'}），产物经 extraResources 随包分发为 <resources>/pdfjs`,
);
