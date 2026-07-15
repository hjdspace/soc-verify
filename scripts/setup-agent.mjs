/**
 * Postinstall script: ensures the socverify-runner binary is available.
 *
 * Strategy:
 *   1. Check if a pre-built runner binary already exists in resources/binaries/
 *   2. If not, download it from GitHub releases
 *   3. If download fails (e.g., no release yet), print a helpful message
 *
 * This script runs automatically on `npm install` via the "postinstall" script.
 * It can also be run manually: `npm run setup:agent`
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BINARIES_DIR = join(ROOT, 'resources', 'binaries');
const BINARY_NAME = platform() === 'win32' ? 'socverify-runner.exe' : 'socverify-runner';
const BINARY_PATH = join(BINARIES_DIR, BINARY_NAME);

const REQUIRE_BINARY = process.argv.includes('--require-binary');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

// GitHub release configuration. Environment variables are useful for forks.
const GITHUB_OWNER = process.env.SOCVERIFY_RELEASE_OWNER ?? 'hjdspace';
const GITHUB_REPO = process.env.SOCVERIFY_RELEASE_REPO ?? 'soc-verify';
const RELEASE_TAG = process.env.SOCVERIFY_RUNNER_TAG ?? `v${PACKAGE_JSON.version}`;

// ─── Platform detection ─────────────────────────────────

function getPlatformAsset() {
  const p = platform();
  const a = process.arch; // x64, arm64

  if (p === 'win32' && a === 'x64') return 'socverify-runner-windows-x64.exe';
  if (p === 'win32' && a === 'arm64') return 'socverify-runner-windows-arm64.exe';
  if (p === 'darwin' && a === 'x64') return 'socverify-runner-darwin-x64';
  if (p === 'darwin' && a === 'arm64') return 'socverify-runner-darwin-arm64';
  if (p === 'linux' && a === 'x64') return 'socverify-runner-linux-x64';
  if (p === 'linux' && a === 'arm64') return 'socverify-runner-linux-arm64';

  console.warn(`[setup-agent] Unsupported platform: ${p}-${a}`);
  return null;
}

// ─── Download ─────────────────────────────────────────────

async function downloadFile(url, destPath) {
  // Use fetch (available in Node 18+)
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { writeFileSync } = await import('node:fs');
  writeFileSync(destPath, buffer);

  // Make executable on Unix
  if (platform() !== 'win32') {
    const { chmodSync } = await import('node:fs');
    chmodSync(destPath, 0o755);
  }
}

async function findReleaseAsset(apiUrl, assetName) {
  console.log(`[setup-agent] Querying GitHub release: ${apiUrl}`);

  const response = await fetch(apiUrl, {
    headers: { 'User-Agent': 'soc-verify-setup-agent' },
  });

  if (!response.ok) {
    console.warn(`[setup-agent] GitHub API returned ${response.status}.`);
    return null;
  }

  const release = await response.json();
  const assets = release?.assets ?? [];
  const asset = assets.find((a) => a.name === assetName);
  return asset?.browser_download_url ?? null;
}

async function downloadFromGitHubRelease() {
  const assetName = getPlatformAsset();
  if (!assetName) return false;

  const taggedReleaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}`;
  const latestReleaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

  try {
    const downloadUrl =
      (await findReleaseAsset(taggedReleaseUrl, assetName)) ??
      (await findReleaseAsset(latestReleaseUrl, assetName));

    if (!downloadUrl) {
      console.warn(`[setup-agent] Asset "${assetName}" not found in "${RELEASE_TAG}" or latest release.`);
      return false;
    }

    console.log(`[setup-agent] Downloading: ${downloadUrl}`);
    await downloadFile(downloadUrl, BINARY_PATH);
    console.log(`[setup-agent] Downloaded to: ${BINARY_PATH}`);
    return true;
  } catch (err) {
    console.warn(`[setup-agent] Download failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Fallback: check for Bun + engine ────────────────────

function checkBunAvailable() {
  const result = spawnSync(platform() === 'win32' ? 'where' : 'which', ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function checkEnginePresent() {
  const sdkPath = join(ROOT, 'engine', 'oh-my-pi', 'packages', 'coding-agent', 'src', 'sdk.ts');
  return existsSync(sdkPath);
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log('[setup-agent] Checking for socverify-runner binary...');

  // 1. Check if binary already exists
  if (existsSync(BINARY_PATH)) {
    const stats = statSync(BINARY_PATH);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    console.log(`[setup-agent] Binary found: ${BINARY_PATH} (${sizeMB} MB)`);
    return;
  }

  // 2. Try downloading from GitHub releases
  console.log('[setup-agent] Binary not found locally. Attempting download...');
  const downloaded = await downloadFromGitHubRelease();
  if (downloaded) {
    console.log('[setup-agent] Binary downloaded successfully.');
    return;
  }

  // 3. Fallback: check if Bun + engine are available (script mode)
  console.log('[setup-agent] Download failed. Checking for Bun + engine fallback...');
  const hasBun = checkBunAvailable();
  const hasEngine = checkEnginePresent();

  if (REQUIRE_BINARY) {
    console.error('[setup-agent] A prebuilt runner binary is required for packaging.');
    console.error('[setup-agent] Run `npm run build:runner` or publish/download a GitHub release runner asset.');
    process.exit(1);
  }

  if (hasBun && hasEngine) {
    console.log('[setup-agent] Bun and engine submodule detected. AI Agent will run in script mode.');
    return;
  }

  // 4. Neither binary nor Bun+engine available
  console.warn('[setup-agent] ═══════════════════════════════════════════════════════');
  console.warn('[setup-agent]  AI Agent binary not available.');
  console.warn('[setup-agent]  To enable AI Agent, choose one of:');
  console.warn('[setup-agent]    1. Build the binary: npm run build:runner');
  console.warn('[setup-agent]       (requires Bun + engine submodule)');
  console.warn('[setup-agent]    2. Install Bun: https://bun.sh/docs/installation');
  console.warn('[setup-agent]       and initialize submodule: git submodule update --init --recursive');
  console.warn('[setup-agent] ═══════════════════════════════════════════════════════');

  if (!hasBun) console.warn('[setup-agent]   ✗ Bun not found in PATH');
  if (!hasEngine) console.warn('[setup-agent]   ✗ Engine submodule not initialized');
}

main().catch((err) => {
  console.error('[setup-agent] Unexpected error:', err);
  if (REQUIRE_BINARY) process.exit(1);
  // Don't fail npm install — just warn
});
