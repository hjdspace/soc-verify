#!/usr/bin/env node
/**
 * Download Nerd Fonts (JetBrainsMono Nerd Font + MesloLGS NF) to resources/fonts/.
 *
 * Usage:
 *   node scripts/download-nerd-fonts.mjs              # 用 package.json 的 nerdFontsVersion（默认）
 *   node scripts/download-nerd-fonts.mjs v3.4.0       # 下载指定 tag
 *   node scripts/download-nerd-fonts.mjs latest       # 下载最新版
 *   node scripts/download-nerd-fonts.mjs --force      # 强制重新下载
 *
 * 字体放置在 resources/fonts/ 下，通过 CSS @font-face（local-resource://）加载。
 *
 * - JetBrainsMono Nerd Font：从 ryanoasis/nerd-fonts GitHub Release 下载
 *   JetBrainsMono.zip，提取 4 个常规变体（Regular/Bold/Italic/BoldItalic）
 *   TTF 文件已入库（共 ~10MB），已存在则跳过下载，避免每次下载 123MB zip
 *   --force 时：优先从本地 zip 提取（若存在），避免重新下载
 * - MesloLGS NF：从 romkatv/powerlevel10k-media 仓库下载官方 'MesloLGS NF'
 *   family 字体（ryanoasis 的 Meslo 变体 family 名为 "MesloLGS Nerd Font"，
 *   与 p10k/Starship 生态约定的 'MesloLGS NF' 不同，故采用 romkatv 分发版）
 *
 * 已存在则跳过下载（除非传 --force）。
 * 下载失败不阻断构建，只打印警告（运行时降级为 fallback 字体）。
 *
 * 字体文件清单须与 src/shared/nerd-fonts.ts 的 NERD_FONT_FACES 保持一致。
 */

import { existsSync, mkdirSync, createWriteStream, renameSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './tls-self-heal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = join(__dirname, '..', 'resources', 'fonts');
const USER_AGENT = 'SoCVerify-NerdFonts-Downloader';

// ===== 从 package.json 读取固定版本号 =====

function readNerdFontVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const version = pkg.nerdFontsVersion;
    if (typeof version === 'string' && version.length > 0) {
      return version;
    }
  } catch {
    // 读取失败时回退到 latest
  }
  return 'latest';
}

// ===== 字体清单（与 src/shared/nerd-fonts.ts 的 NERD_FONT_FACES 保持一致）=====

/** JetBrainsMono Nerd Font Release zip 内需提取的 ttf 变体 */
const JETBRAINS_ZIP_ASSET = 'JetBrainsMono.zip';
const JETBRAINS_TTF_FILES = [
  'JetBrainsMonoNerdFont-Regular.ttf',
  'JetBrainsMonoNerdFont-Bold.ttf',
  'JetBrainsMonoNerdFont-Italic.ttf',
  'JetBrainsMonoNerdFont-BoldItalic.ttf',
];

/** MesloLGS NF 直链（romkatv/powerlevel10k-media 官方分发，family 名即 'MesloLGS NF'） */
const MESLO_TTF_URLS = {
  'MesloLGS NF Regular.ttf':
    'https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Regular.ttf',
  'MesloLGS NF Bold.ttf':
    'https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold.ttf',
  'MesloLGS NF Italic.ttf':
    'https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Italic.ttf',
  'MesloLGS NF Bold Italic.ttf':
    'https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold%20Italic.ttf',
};

// ===== Download =====

async function downloadFile(url, destPath) {
  console.log(`[NerdFonts] Downloading: ${url}`);
  console.log(`[NerdFonts] Destination: ${destPath}`);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const contentLength = resp.headers.get('content-length');
  if (contentLength) {
    console.log(`[NerdFonts] File size: ${(parseInt(contentLength) / 1024 / 1024).toFixed(1)} MB`);
  }

  const tmpPath = destPath + '.tmp';
  const stream = createWriteStream(tmpPath);
  const reader = resp.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.write(Buffer.from(value));
    }
    stream.end();
  } finally {
    stream.close();
  }

  renameSync(tmpPath, destPath);
  return destPath;
}

/** 从 Release zip 提取指定 ttf 文件（按 basename 匹配，兼容子目录结构） */
async function extractTtfsFromZip(zipPath, ttfNames, destDir) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(zipPath));

  const extracted = [];
  for (const name of ttfNames) {
    const entry = Object.keys(zip.files).find((key) => {
      const base = key.split('/').pop();
      return base === name && !zip.files[key].dir;
    });
    if (!entry) {
      console.warn(`[NerdFonts] Warning: ${name} not found in ${zipPath}`);
      continue;
    }
    const content = await zip.files[entry].async('nodebuffer');
    const dest = join(destDir, name);
    writeFileSync(dest, content);
    extracted.push(dest);
    console.log(`[NerdFonts] Extracted: ${name} (${(content.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  return extracted;
}

async function downloadJetBrainsMono(tag, force) {
  const allPresent = JETBRAINS_TTF_FILES.every((name) => {
    const p = join(TARGET_DIR, name);
    return existsSync(p) && statSync(p).size > 0;
  });
  if (allPresent && !force) {
    console.log('[NerdFonts] JetBrainsMono Nerd Font already exists, skipping. Use --force to re-download.');
    return;
  }

  const zipPath = join(TARGET_DIR, JETBRAINS_ZIP_ASSET);

  // 优先从本地 zip 提取（避免重新下载 123MB）
  if (existsSync(zipPath) && statSync(zipPath).size > 0) {
    console.log('[NerdFonts] Found local JetBrainsMono.zip, extracting from it...');
    try {
      const extracted = await extractTtfsFromZip(zipPath, JETBRAINS_TTF_FILES, TARGET_DIR);
      if (extracted.length > 0) {
        console.log('[NerdFonts] Extracted from local zip, no download needed.');
        return;
      }
      console.warn('[NerdFonts] Local zip did not contain expected ttf files, falling back to download.');
    } catch (err) {
      console.warn(`[NerdFonts] Failed to extract from local zip: ${err.message}, falling back to download.`);
    }
  }

  // 本地 zip 不存在或提取失败，从远程下载
  const url =
    tag === 'latest'
      ? `https://github.com/ryanoasis/nerd-fonts/releases/latest/download/${JETBRAINS_ZIP_ASSET}`
      : `https://github.com/ryanoasis/nerd-fonts/releases/download/${tag}/${JETBRAINS_ZIP_ASSET}`;

  try {
    await downloadFile(url, zipPath);
    const extracted = await extractTtfsFromZip(zipPath, JETBRAINS_TTF_FILES, TARGET_DIR);
    if (extracted.length === 0) {
      console.error('[NerdFonts] No expected ttf variants found in the release zip.');
    }
  } finally {
    // 清理临时 zip（体积大，不留在仓库/打包目录）
    if (existsSync(zipPath)) {
      try {
        unlinkSync(zipPath);
      } catch {
        /* ignore */
      }
    }
  }
}

async function downloadMesloLgs(force) {
  for (const [name, url] of Object.entries(MESLO_TTF_URLS)) {
    const dest = join(TARGET_DIR, name);
    if (existsSync(dest) && statSync(dest).size > 0 && !force) {
      console.log(`[NerdFonts] ${name} already exists, skipping.`);
      continue;
    }
    await downloadFile(url, dest);
  }
}

// ===== Main =====

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  // 命令行 tag 优先，否则用 package.json 的 nerdFontsVersion
  const cliTag = args.find((a) => !a.startsWith('-'));
  const tag = cliTag || readNerdFontVersion();

  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }

  console.log(`[NerdFonts] Nerd Fonts version: ${tag}`);

  try {
    await downloadJetBrainsMono(tag, force);
  } catch (err) {
    console.error(`[NerdFonts] JetBrainsMono download failed: ${err.message}`);
    console.warn('[NerdFonts] Build will continue without JetBrainsMono Nerd Font (runtime falls back to system monospace).');
  }

  try {
    await downloadMesloLgs(force);
  } catch (err) {
    console.error(`[NerdFonts] MesloLGS NF download failed: ${err.message}`);
    console.warn('[NerdFonts] Build will continue without MesloLGS NF (runtime falls back to system monospace).');
  }

  // 汇总
  const downloaded = [...JETBRAINS_TTF_FILES, ...Object.keys(MESLO_TTF_URLS)].filter((name) => {
    const p = join(TARGET_DIR, name);
    return existsSync(p) && statSync(p).size > 0;
  });
  console.log(`[NerdFonts] Done. ${downloaded.length}/8 font files available in ${TARGET_DIR}`);
}

main().catch((err) => {
  console.error(`[NerdFonts] Fatal error: ${err.message}`);
  console.warn('[NerdFonts] Build will continue without Nerd Fonts (runtime falls back to system monospace).');
});
