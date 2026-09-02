/**
 * Nerd Font 目录解析与字体文件发现（Issue #1）。
 *
 * 目录优先级（与 officecli/binary.ts 的三级回退模式一致）：
 *   1. 打包模式：`process.resourcesPath/fonts/`（electron-builder extraResources）
 *   2. 开发模式：项目根 `resources/fonts/`
 *
 * 字体未下载时目录为空 / 不存在，调用方降级处理（不崩溃，回退 fallback 字体）。
 */

import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NERD_FONT_FACES, type NerdFontFace } from '../../shared/nerd-fonts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 打包模式字体目录（process.resourcesPath/fonts） */
function packagedFontsDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
  return join(resourcesPath, 'fonts');
}

/** 开发模式字体目录（项目根 resources/fonts） */
function devFontsDir(): string {
  return resolve(__dirname, '../../resources/fonts');
}

/**
 * 解析 Nerd Font 目录。
 *
 * 打包模式优先 `process.resourcesPath/fonts`，不存在时回退到 dev 的
 * `resources/fonts`；两者都不可用时返回 null（字体未下载的降级场景）。
 */
export function resolveNerdFontsDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
  if (resourcesPath) {
    const packaged = packagedFontsDir();
    if (existsSync(packaged)) return packaged;
  }
  const dev = devFontsDir();
  if (existsSync(dev)) return dev;
  return null;
}

/**
 * 列出实际存在的字体 face。
 *
 * 按 `shared/nerd-fonts.ts` 的 NERD_FONT_FACES 清单逐一检查字体文件是否存在，
 * 只返回磁盘上真实存在的 face（部分缺失时按需降级，例如只打包了 Regular）。
 *
 * @param dir 字体目录；缺省时内部调用 resolveNerdFontsDir() 解析
 */
export function listNerdFontFaces(dir?: string | null): NerdFontFace[] {
  const fontsDir = dir === undefined ? resolveNerdFontsDir() : dir;
  if (!fontsDir) return [];
  return NERD_FONT_FACES.filter((face) => existsSync(join(fontsDir, face.fileName)));
}
