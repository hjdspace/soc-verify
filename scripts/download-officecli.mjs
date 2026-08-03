#!/usr/bin/env node
/**
 * Download the correct OfficeCLI binary for the current platform.
 *
 * Usage:
 *   node scripts/download-officecli.mjs              # 用 package.json 的 officecliVersion（默认）
 *   node scripts/download-officecli.mjs v1.0.0       # 下载指定 tag
 *   node scripts/download-officecli.mjs latest       # 下载最新版
 *   node scripts/download-officecli.mjs --force      # 强制重新下载
 *   node scripts/download-officecli.mjs v1.0.0 --force
 *
 * 二进制放置在 resources/binaries/ 下，命名约定：
 *   officecli-{platform}-{arch}[.exe]
 *
 * 若二进制已存在则跳过下载（除非传 --force）。
 * 下载失败时不阻断构建，只打印警告（运行时降级处理）。
 * 下载完成后用 `officecli --version` 验证可执行。
 *
 * 参考：SpaceCode 的 scripts/download-officecli.mjs
 */

import { existsSync, mkdirSync, createWriteStream, renameSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = join(__dirname, '..', 'resources', 'binaries');
const USER_AGENT = 'SoCVerify-OfficeCLI-Downloader';

// ===== 从 package.json 读取固定版本号 =====

function readOfficecliVersion() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const version = pkg.officecliVersion;
    if (typeof version === 'string' && version.length > 0) {
      return version;
    }
  } catch {
    // 读取失败时回退到 latest
  }
  return 'latest';
}

// ===== Platform detection =====

function getPlatformInfo() {
  const platform = process.platform;
  const arch = process.arch;

  let platformName;
  if (platform === 'win32') platformName = 'win';
  else if (platform === 'darwin') platformName = 'mac';
  else if (platform === 'linux') platformName = 'linux';
  else throw new Error(`Unsupported platform: ${platform}`);

  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  const exeName = `officecli-${platformName}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  return { platformName, arch, exeName, platform };
}

// ===== GitHub API =====

const GITHUB_API = 'https://api.github.com/repos/iOfficeAI/OfficeCLI/releases';

async function fetchRelease(tag) {
  // tag 为 'latest' 或具体版本号（如 'v1.0.0'）
  const url = tag === 'latest' ? `${GITHUB_API}/latest` : `${GITHUB_API}/tags/${tag}`;
  console.log(`[OfficeCLI] Fetching release info: ${tag} from ${url}`);

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
  console.log(`[OfficeCLI] Downloading: ${url}`);
  console.log(`[OfficeCLI] Destination: ${destPath}`);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });

  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const contentLength = resp.headers.get('content-length');
  if (contentLength) {
    console.log(`[OfficeCLI] File size: ${(parseInt(contentLength) / 1024 / 1024).toFixed(1)} MB`);
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
    console.log(`[OfficeCLI] Download complete.`);
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

// ===== Main =====

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  // 命令行 tag 优先，否则用 package.json 的 officecliVersion
  const cliTag = args.find((a) => !a.startsWith('-'));
  const tag = cliTag || readOfficecliVersion();

  const { exeName, platform } = getPlatformInfo();

  // 确保目标目录存在
  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }

  const targetPath = join(TARGET_DIR, exeName);

  // 已存在则跳过（除非 --force）
  if (existsSync(targetPath) && !force) {
    const stats = statSync(targetPath);
    if (stats.size > 0) {
      console.log(`[OfficeCLI] Binary already exists: ${targetPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`[OfficeCLI] Use --force to re-download.`);

      // 验证可执行
      try {
        const result = spawnSync(targetPath, ['--version'], { timeout: 5000, encoding: 'utf-8' });
        if (result.status === 0) {
          console.log(`[OfficeCLI] Version: ${result.stdout.trim()}`);
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
    console.error(`[OfficeCLI] Failed to fetch release info: ${err.message}`);
    console.error(`[OfficeCLI] You can manually download from: https://github.com/iOfficeAI/OfficeCLI/releases`);
    console.error(`[OfficeCLI] Place the binary at: ${targetPath}`);
    console.warn(`[OfficeCLI] Build will continue without the binary. Users can download it via the in-app download button.`);
    return;
  }

  // 查找匹配的 asset
  const assets = release.assets || [];
  const asset = assets.find((a) => a.name === exeName);

  if (!asset) {
    console.error(`[OfficeCLI] No matching asset found for ${exeName}`);
    console.error(`[OfficeCLI] Available assets:`);
    assets.forEach((a) => console.error(`  - ${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`));
    console.error(`[OfficeCLI] You can manually download from: ${release.html_url || 'https://github.com/iOfficeAI/OfficeCLI/releases'}`);
    console.warn(`[OfficeCLI] Build will continue without the binary. Users can download it via the in-app download button.`);
    return;
  }

  console.log(`[OfficeCLI] Release: ${release.tag_name || tag}`);
  console.log(`[OfficeCLI] Asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

  // 下载
  try {
    await downloadFile(asset.browser_download_url, targetPath);

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
      console.log(`[OfficeCLI] Verification OK. Version: ${result.stdout.trim()}`);
    } else {
      console.warn(`[OfficeCLI] Binary downloaded but version check failed (may still work).`);
    }
  } catch (err) {
    console.error(`[OfficeCLI] Download failed: ${err.message}`);
    console.warn(`[OfficeCLI] Build will continue without the binary. Users can download it via the in-app download button.`);
  }
}

main().catch((err) => {
  console.error(`[OfficeCLI] Fatal error: ${err.message}`);
  console.warn(`[OfficeCLI] Build will continue without the binary. Users can download it via the in-app download button.`);
});
