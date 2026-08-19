#!/usr/bin/env node
/**
 * Download the draw.io desktop CLI for bundling (Linux only).
 *
 * Usage:
 *   node scripts/download-drawio.mjs            # 用 package.json 的 drawioDesktopVersion
 *   node scripts/download-drawio.mjs --force    # 强制重新下载解压
 *
 * Linux：下载官方 AppImage 到临时目录，`--appimage-extract` 自解压（无需
 * FUSE / binutils / xz），把产物移动到 resources/binaries/drawio-linux-<arch>/。
 * 该目录由 electron-builder extraResources 随应用打包，内网 Linux 可直接导出。
 *
 * Windows / macOS：不内置（体积与许可分发考虑）。应用内预览页检测不到
 * CLI 时引导用户从官网下载安装（drawio-desktop releases）。
 *
 * 下载失败不阻断构建，只打印警告（运行时降级处理）。
 */

import { existsSync, mkdirSync, createWriteStream, rmSync, cpSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import './tls-self-heal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_BASE = join(__dirname, '..', 'resources', 'binaries');
const USER_AGENT = 'SoCVerify-Drawio-Downloader';
const GITHUB_API = 'https://api.github.com/repos/jgraph/drawio-desktop/releases';

function readDrawioVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    if (typeof pkg.drawioDesktopVersion === 'string' && pkg.drawioDesktopVersion.length > 0) {
      return pkg.drawioDesktopVersion;
    }
  } catch {
    // 读取失败回退 latest
  }
  return 'latest';
}

function linuxAssetName(arch) {
  // 官方 AppImage 命名：drawio-x86_64-<ver>.AppImage / drawio-arm64-<ver>.AppImage
  return arch === 'arm64' ? /drawio-arm64-.*\.AppImage$/ : /drawio-x86_64-.*\.AppImage$/;
}

async function fetchRelease(tag) {
  const url = tag === 'latest' ? `${GITHUB_API}/latest` : `${GITHUB_API}/tags/${tag}`;
  console.log(`[drawio] Fetching release info: ${tag}`);
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

function downloadFile(url, destPath) {
  console.log(`[drawio] Downloading: ${url}`);
  return new Promise((resolvePromise, rejectPromise) => {
    fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' })
      .then((resp) => {
        if (!resp.ok) {
          rejectPromise(new Error(`Download failed: HTTP ${resp.status}`));
          return;
        }
        const len = resp.headers.get('content-length');
        if (len) console.log(`[drawio] File size: ${(parseInt(len) / 1024 / 1024).toFixed(1)} MB`);
        const stream = createWriteStream(destPath);
        const reader = resp.body.getReader();
        const pump = async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stream.write(Buffer.from(value));
          }
        };
        pump()
          .then(() => {
            stream.end();
            resolvePromise();
          })
          .catch((err) => {
            stream.destroy();
            rejectPromise(err);
          });
      })
      .catch(rejectPromise);
  });
}

async function main() {
  const force = process.argv.includes('--force');
  const tag = readDrawioVersion();

  if (process.platform !== 'linux') {
    console.log(`[drawio] Skipped: ${process.platform} 不内置 draw.io CLI（应用内引导用户本机安装）。`);
    return;
  }

  const archName = process.arch === 'arm64' ? 'arm64' : 'x64';
  const targetDir = join(TARGET_BASE, `drawio-linux-${archName}`);

  // 已存在则跳过（除非 --force）
  const bundledBinary = join(targetDir, 'drawio');
  if (!force && existsSync(bundledBinary) && statSync(bundledBinary).size > 0) {
    console.log(`[drawio] Bundled drawio already exists: ${bundledBinary}`);
    console.log('[drawio] Use --force to re-download.');
    return;
  }

  let release;
  try {
    release = await fetchRelease(tag);
  } catch (err) {
    console.error(`[drawio] Failed to fetch release info: ${err.message}`);
    console.error('[drawio] Build will continue without bundled drawio.');
    return;
  }

  const assets = release.assets || [];
  const asset = assets.find((a) => linuxAssetName(archName).test(a.name));
  if (!asset) {
    console.error(`[drawio] No AppImage asset found for ${archName} in ${release.tag_name}`);
    console.error(`[drawio] Available: ${assets.map((a) => a.name).join(', ')}`);
    console.error('[drawio] Build will continue without bundled drawio.');
    return;
  }
  console.log(`[drawio] Release: ${release.tag_name}  Asset: ${asset.name}`);

  // 临时目录：下载 AppImage → 自解压 → 移动产物
  const workDir = join(tmpdir(), `socverify-drawio-${Date.now()}`);
  const appImagePath = join(workDir, asset.name);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(TARGET_BASE, { recursive: true });

  try {
    await downloadFile(asset.browser_download_url, appImagePath);

    // 自解压（Type-2 AppImage 无需 FUSE）
    spawnSync('chmod', ['+x', appImagePath]);
    console.log('[drawio] Extracting AppImage (--appimage-extract)...');
    const extract = spawnSync(appImagePath, ['--appimage-extract'], { cwd: workDir, timeout: 300_000 });
    const squashfsRoot = join(workDir, 'squashfs-root');
    if (extract.status !== 0 || !existsSync(join(squashfsRoot, 'drawio'))) {
      throw new Error(`AppImage self-extract failed (exit ${extract.status}).`);
    }

    // 移动产物到目标目录
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(squashfsRoot, targetDir, { recursive: true });
    spawnSync('chmod', ['+x', join(targetDir, 'drawio')]);

    // 验证 CLI 可用（--version 退出码 0 即可）
    const verify = spawnSync(join(targetDir, 'drawio'), ['--version'], { timeout: 60_000, encoding: 'utf-8' });
    if (verify.status === 0) {
      console.log('[drawio] Verification OK.');
    } else {
      console.warn('[drawio] Binary extracted but --version check failed (may still work headless).');
    }
    console.log(`[drawio] Bundled at: ${targetDir}`);
  } catch (err) {
    console.error(`[drawio] ${err.message}`);
    console.error('[drawio] Build will continue without bundled drawio (export degrades at runtime).');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[drawio] Fatal error: ${err.message}`);
  console.warn('[drawio] Build will continue without bundled drawio.');
});
