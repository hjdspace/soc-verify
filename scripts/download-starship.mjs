#!/usr/bin/env node
/**
 * Download the correct Starship binary for the current platform.
 *
 * Usage:
 *   node scripts/download-starship.mjs              # 用 package.json 的 starshipVersion（默认）
 *   node scripts/download-starship.mjs v1.21.1     # 下载指定 tag
 *   node scripts/download-starship.mjs latest       # 下载最新版
 *   node scripts/download-starship.mjs --force      # 强制重新下载
 *   node scripts/download-starship.mjs v1.21.1 --force
 *
 * 二进制放置在 resources/binaries/ 下，命名约定：
 *   starship-{platform}-{arch}[.exe]
 *
 * Starship GitHub Release asset 命名约定（参考 v1.26.0 release）：
 *   Windows x64:  starship-x86_64-pc-windows-msvc.zip      （zip 压缩包，内含 starship.exe）
 *   Windows arm64: starship-aarch64-pc-windows-msvc.zip    （同上）
 *   Linux x64:    starship-x86_64-unknown-linux-musl.tar.gz  （tar.gz 压缩包）
 *   Linux arm64:  starship-aarch64-unknown-linux-musl.tar.gz
 *   macOS x64:    starship-x86_64-apple-darwin.tar.gz
 *   macOS arm64:  starship-aarch64-apple-darwin.tar.gz
 *
 * 下载后统一命名为 starship-{platform}-{arch}[.exe]，与 officecli 命名风格一致。
 * 若二进制已存在则跳过下载（除非传 --force）。
 * 下载失败不阻断构建，只打印警告（运行时降级——无 Starship 则不启用 Prompt 美化）。
 * 下载完成后用 `starship --version` 验证可执行。
 *
 * 参考：scripts/download-officecli.mjs
 */

import { existsSync, mkdirSync, createWriteStream, renameSync, statSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

import './tls-self-heal.mjs';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = join(__dirname, '..', 'resources', 'binaries');
const USER_AGENT = 'SoCVerify-Starship-Downloader';

// ===== 从 package.json 读取固定版本号 =====

function readStarshipVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const version = pkg.starshipVersion;
    if (typeof version === 'string' && version.length > 0) {
      return version;
    }
  } catch {
    // 读取失败时回退到 latest
  }
  return 'latest';
}

// ===== Platform detection =====

/**
 * 获取当前平台的 Starship asset 信息。
 *
 * 返回 GitHub Release 中该平台对应的 asset 文件名，
 * 以及下载后应保存的本地文件名（统一命名约定）。
 */
function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  let platformName; // 本地命名用：win / mac / linux
  let assetName; // GitHub Release asset 文件名

  if (platform === 'win32') {
    platformName = 'win';
    if (arch === 'x64') {
      assetName = 'starship-x86_64-pc-windows-msvc.zip';
    } else if (arch === 'arm64') {
      assetName = 'starship-aarch64-pc-windows-msvc.zip';
    } else {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
  } else if (platform === 'darwin') {
    platformName = 'mac';
    if (arch === 'x64') {
      assetName = 'starship-x86_64-apple-darwin.tar.gz';
    } else if (arch === 'arm64') {
      assetName = 'starship-aarch64-apple-darwin.tar.gz';
    } else {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
  } else if (platform === 'linux') {
    platformName = 'linux';
    // Linux 使用 musl 静态链接版（兼容性更好，且 arm64 只有 musl 版）
    if (arch === 'x64') {
      assetName = 'starship-x86_64-unknown-linux-musl.tar.gz';
    } else if (arch === 'arm64') {
      assetName = 'starship-aarch64-unknown-linux-musl.tar.gz';
    } else {
      throw new Error(`Unsupported architecture: ${arch}`);
    }
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  // 统一命名：starship-{platform}-{arch}[.exe]
  const exeName = `starship-${platformName}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  return { platformName, arch, exeName, assetName, platform };
}

// ===== GitHub API =====

const GITHUB_API = 'https://api.github.com/repos/starship/starship/releases';

async function fetchRelease(tag) {
  // tag 为 'latest' 或具体版本号（如 'v1.21.1'）
  const url = tag === 'latest' ? `${GITHUB_API}/latest` : `${GITHUB_API}/tags/${tag}`;
  console.log(`[Starship] Fetching release info: ${tag} from ${url}`);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`);
  }

  return resp.json();
}

// ===== Download =====

async function downloadFile(url, destPath) {
  console.log(`[Starship] Downloading: ${url}`);
  console.log(`[Starship] Destination: ${destPath}`);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const contentLength = resp.headers.get('content-length');
  if (contentLength) {
    console.log(`[Starship] File size: ${(parseInt(contentLength) / 1024 / 1024).toFixed(1)} MB`);
  }

  const tmpPath = destPath + '.tmp';
  const stream = createWriteStream(tmpPath);

  const reader = resp.body.getReader();
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stream.write(Buffer.from(value));
    }
  };

  try {
    await pump();
    stream.end();
    renameSync(tmpPath, destPath);
    console.log(`[Starship] Download complete.`);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

/**
 * 从 tar.gz 压缩包中提取 starship 二进制到目标路径。
 *
 * Starship 的 tar.gz 包内只有一个 `starship` 可执行文件（无子目录），
 * 使用系统 tar 命令解压到临时目录后移动到目标路径。
 */
async function extractFromTarGz(archivePath, destPath) {
  const tmpExtractDir = join(tmpdir(), `starship-extract-${Date.now()}`);
  mkdirSync(tmpExtractDir, { recursive: true });

  try {
    // 使用系统 tar 解压
    await execAsync(`tar -xzf "${archivePath}" -C "${tmpExtractDir}"`);

    // 查找解压出的 starship 二进制（通常直接在目录根）
    const starshipBinary = join(tmpExtractDir, 'starship');
    if (!existsSync(starshipBinary)) {
      throw new Error('starship binary not found in tar.gz archive');
    }

    // 移动到目标路径
    renameSync(starshipBinary, destPath);
    console.log(`[Starship] Extracted to: ${destPath}`);
  } finally {
    // 清理临时目录
    try {
      if (existsSync(tmpExtractDir)) {
        await execAsync(`rm -rf "${tmpExtractDir}"`);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * 从 zip 压缩包中提取 starship.exe 到目标路径。
 *
 * Starship 的 Windows zip 包内只有一个 `starship.exe` 可执行文件，
 * 使用 jszip（项目已有依赖）解压。
 */
async function extractFromZip(archivePath, destPath) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(archivePath));

  // 查找 zip 中的 starship.exe（按 basename 匹配，兼容子目录结构）
  const entryKey = Object.keys(zip.files).find((key) => {
    const base = key.split('/').pop();
    return base === 'starship.exe' && !zip.files[key].dir;
  });

  if (!entryKey) {
    throw new Error('starship.exe not found in zip archive');
  }

  const content = await zip.files[entryKey].async('nodebuffer');
  writeFileSync(destPath, content);
  console.log(`[Starship] Extracted starship.exe (${(content.length / 1024 / 1024).toFixed(1)} MB) to: ${destPath}`);
}

// ===== Main =====

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  // 命令行 tag 优先，否则用 package.json 的 starshipVersion
  const cliTag = args.find((a) => !a.startsWith('-'));
  const tag = cliTag || readStarshipVersion();

  const { exeName, assetName, platform } = getPlatformInfo();

  // 确保目标目录存在
  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }

  const targetPath = join(TARGET_DIR, exeName);

  // 已存在则跳过（除非 --force）
  if (existsSync(targetPath) && !force) {
    const stats = statSync(targetPath);
    if (stats.size > 0) {
      console.log(`[Starship] Binary already exists: ${targetPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`[Starship] Use --force to re-download.`);

      // 验证可执行
      try {
        const result = spawnSync(targetPath, ['--version'], { timeout: 5000, encoding: 'utf-8' });
        if (result.status === 0) {
          console.log(`[Starship] Version: ${result.stdout.trim()}`);
        }
      } catch {
        /* ignore version check errors */
      }
      return;
    }
  }

  // 获取 release 信息
  let release;
  try {
    release = await fetchRelease(tag);
  } catch (err) {
    console.error(`[Starship] Failed to fetch release info: ${err.message}`);
    console.error(`[Starship] You can manually download from: https://github.com/starship/starship/releases`);
    console.error(`[Starship] Place the binary at: ${targetPath}`);
    console.warn(`[Starship] Build will continue without the binary. Prompt beautification will be disabled at runtime.`);
    return;
  }

  // 查找匹配的 asset
  const assets = release.assets || [];
  const asset = assets.find((a) => a.name === assetName);

  if (!asset) {
    console.error(`[Starship] No matching asset found for ${assetName}`);
    console.error(`[Starship] Available assets:`);
    assets.forEach((a) => console.error(`  - ${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`));
    console.error(`[Starship] You can manually download from: ${release.html_url || 'https://github.com/starship/starship/releases'}`);
    console.warn(`[Starship] Build will continue without the binary. Prompt beautification will be disabled at runtime.`);
    return;
  }

  console.log(`[Starship] Release: ${release.tag_name || tag}`);
  console.log(`[Starship] Asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

  // 下载
  try {
    // 所有平台都是压缩包：Windows 是 .zip，Unix 是 .tar.gz
    const archivePath = join(TARGET_DIR, assetName + '.tmp.download');
    await downloadFile(asset.browser_download_url, archivePath);

    // 解压
    if (assetName.endsWith('.zip')) {
      await extractFromZip(archivePath, targetPath);
    } else {
      await extractFromTarGz(archivePath, targetPath);
    }

    // 清理压缩包
    if (existsSync(archivePath)) {
      try {
        unlinkSync(archivePath);
      } catch {
        /* ignore */
      }
    }

    // Unix 上设置可执行权限
    if (platform !== 'win32') {
      try {
        spawnSync('chmod', ['+x', targetPath]);
      } catch {
        /* ignore */
      }
    }

    // 验证
    const result = spawnSync(targetPath, ['--version'], { timeout: 5000, encoding: 'utf-8' });
    if (result.status === 0) {
      console.log(`[Starship] Verification OK. Version: ${result.stdout.trim()}`);
    } else {
      console.warn(`[Starship] Binary downloaded but version check failed (may still work).`);
    }
  } catch (err) {
    console.error(`[Starship] Download failed: ${err.message}`);
    console.warn(`[Starship] Build will continue without the binary. Prompt beautification will be disabled at runtime.`);
  }
}

main().catch((err) => {
  console.error(`[Starship] Fatal error: ${err.message}`);
  console.warn(`[Starship] Build will continue without the binary. Prompt beautification will be disabled at runtime.`);
});
