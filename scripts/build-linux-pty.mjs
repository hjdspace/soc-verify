/**
 * Build node-pty native binary for Linux (linux-x64).
 *
 * Problem:
 *   node-pty 1.1.0 ships prebuilds for darwin (macOS) and win32 (Windows),
 *   but NOT for Linux. When packaging a Linux AppImage on Windows/macOS,
 *   the Linux pty.node binary is missing, causing terminal functionality
 *   to fail on Linux with:
 *     "Cannot find module './prebuilds/linux-x64//pty.node'"
 *
 * Solution:
 *   This script compiles node-pty for Linux + Electron ABI:
 *   - On Linux: compiles directly using @electron/rebuild
 *   - On Windows/macOS: uses Docker to cross-compile in a Linux container
 *   The resulting pty.node is placed in prebuilds/linux-x64/ where
 *   node-pty's loadNativeModule() finds it at runtime.
 *
 * Usage:
 *   node scripts/build-linux-pty.mjs           # build if missing
 *   node scripts/build-linux-pty.mjs --force   # force rebuild
 *
 * Requirements:
 *   - On Windows/macOS: Docker Desktop must be running
 *   - On Linux: build-essential, python3, make must be installed
 *
 * Environment variables:
 *   NPM_REGISTRY  - override npm registry (e.g. https://registry.npmmirror.com)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PTY_DIR = join(ROOT, 'node_modules', 'node-pty');
const PREBUILD_DIR = join(PTY_DIR, 'prebuilds', 'linux-x64');
const PREBUILD_FILE = join(PREBUILD_DIR, 'pty.node');
const CACHE_DIR = join(ROOT, '.cache', 'linux-pty');
const VERSION_STAMP = join(CACHE_DIR, '.version');

const IS_LINUX = platform() === 'linux';
const IS_WIN = platform() === 'win32';

// ─── Version resolution ─────────────────────────────────

function readVersion(filePath) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf-8'));
  return pkg.version;
}

// ─── Version stamp ──────────────────────────────────────

function checkVersionStamp(versionKey) {
  try {
    if (existsSync(VERSION_STAMP)) {
      const stamp = readFileSync(VERSION_STAMP, 'utf-8').trim();
      return stamp === versionKey;
    }
  } catch { /* ignore */ }
  return false;
}

function writeVersionStamp(versionKey) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(VERSION_STAMP, versionKey, 'utf-8');
}

// ─── Docker detection ───────────────────────────────────

function isDockerAvailable() {
  try {
    const result = spawnSync('docker', ['--version'], {
      stdio: 'pipe',
      shell: IS_WIN,
      encoding: 'utf-8',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ─── NPM registry ───────────────────────────────────────

function getNpmRegistry() {
  // Check environment variable override
  if (process.env.NPM_REGISTRY) return process.env.NPM_REGISTRY;
  // Check project .npmrc for registry config
  try {
    const npmrcPath = join(ROOT, '.npmrc');
    if (existsSync(npmrcPath)) {
      const content = readFileSync(npmrcPath, 'utf-8');
      const match = content.match(/^registry\s*=\s*(.+)$/m);
      if (match) return match[1].trim();
    }
  } catch { /* ignore */ }
  // Default npm registry
  return 'https://registry.npmjs.org/';
}

// ─── Build on Linux (direct) ────────────────────────────

function buildOnLinux(electronVersion, ptyVersion) {
  console.log('[build-linux-pty] Building on Linux directly...');

  // Run @electron/rebuild to compile node-pty for Electron's ABI
  const result = spawnSync('npx', [
    '@electron/rebuild',
    '-v', electronVersion,
    '-f', '-w', 'node-pty',
    '--arch', 'x64',
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(
      '@electron/rebuild failed.\n' +
      'Make sure build tools are installed:\n' +
      '  Ubuntu/Debian: sudo apt install build-essential python3 make\n' +
      '  Fedora/RHEL:   sudo dnf install gcc-c++ make python3'
    );
  }

  // The binary is at node_modules/node-pty/build/Release/pty.node
  const builtFile = join(PTY_DIR, 'build', 'Release', 'pty.node');
  if (!existsSync(builtFile)) {
    throw new Error(`Expected build output not found: ${builtFile}`);
  }

  // Copy to prebuilds directory
  mkdirSync(PREBUILD_DIR, { recursive: true });
  copyFileSync(builtFile, PREBUILD_FILE);
  console.log(`[build-linux-pty] Copied to ${PREBUILD_FILE}`);
}

// ─── Build via Docker (cross-compile) ───────────────────

function buildViaDocker(electronVersion, ptyVersion) {
  console.log('[build-linux-pty] Building via Docker (cross-compile)...');

  const registry = getNpmRegistry();
  mkdirSync(CACHE_DIR, { recursive: true });

  // Convert path for Docker volume mount (Windows needs forward slashes)
  const cacheDir = CACHE_DIR.replace(/\\/g, '/');

  // Docker build script: install node-pty, rebuild for Electron, extract pty.node
  const dockerScript = [
    'set -e',
    `echo "[docker] Installing build dependencies..."`,
    'apt-get update -qq && apt-get install -y -qq build-essential python3 make > /dev/null 2>&1',
    'echo "[docker] Setting up build environment..."',
    'mkdir -p /tmp/pty-build && cd /tmp/pty-build',
    'npm init -y > /dev/null',
    `npm install node-pty@${ptyVersion} --registry ${registry} 2>&1 | tail -5`,
    `echo "[docker] Rebuilding node-pty for Electron ${electronVersion}..."`,
    `npx @electron/rebuild -v ${electronVersion} -f -w node-pty --arch x64 2>&1 | tail -10`,
    'echo "[docker] Extracting pty.node..."',
    'mkdir -p /output',
    'cp node_modules/node-pty/build/Release/pty.node /output/pty.node',
    'echo "[docker] Build complete!"',
  ].join(' && ');

  const dockerArgs = [
    'run', '--rm',
    '--platform', 'linux/amd64',
    '-v', `${cacheDir}:/output`,
    'node:22-bookworm',
    'bash', '-c', dockerScript,
  ];

  console.log('[build-linux-pty] Launching Docker container...');
  console.log(`[build-linux-pty]   Image: node:22-bookworm (linux/amd64)`);
  console.log(`[build-linux-pty]   Electron: ${electronVersion}`);
  console.log(`[build-linux-pty]   node-pty: ${ptyVersion}`);
  console.log(`[build-linux-pty]   Registry: ${registry}\n`);

  const result = spawnSync('docker', dockerArgs, {
    stdio: 'inherit',
    shell: IS_WIN,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(
      'Docker build failed.\n' +
      'Make sure Docker Desktop is running.\n' +
      'On Apple Silicon Macs, QEMU emulation will be used (slower but functional).'
    );
  }

  // Copy from cache to prebuilds directory
  const cachedFile = join(CACHE_DIR, 'pty.node');
  if (!existsSync(cachedFile)) {
    throw new Error(`Docker build output not found: ${cachedFile}`);
  }

  mkdirSync(PREBUILD_DIR, { recursive: true });
  copyFileSync(cachedFile, PREBUILD_FILE);
  console.log(`[build-linux-pty] Copied to ${PREBUILD_FILE}`);
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('[build-linux-pty] Starting...\n');

  // Check node-pty exists
  if (!existsSync(PTY_DIR)) {
    console.error('[build-linux-pty] ERROR: node_modules/node-pty not found.');
    console.error('[build-linux-pty] Run `npm install` first.');
    process.exit(1);
  }

  // Read versions
  const electronVersion = readVersion(join(ROOT, 'node_modules', 'electron', 'package.json'));
  const ptyVersion = readVersion(join(PTY_DIR, 'package.json'));
  // Version key includes both versions so stale binaries are detected after upgrades
  const versionKey = `electron-${electronVersion}_pty-${ptyVersion}`;

  console.log(`[build-linux-pty] Electron version: ${electronVersion}`);
  console.log(`[build-linux-pty] node-pty version: ${ptyVersion}`);
  console.log(`[build-linux-pty] Target: linux-x64`);
  console.log(`[build-linux-pty] Host platform: ${platform()}\n`);

  // Check if already built (skip if exists and version matches)
  const force = process.argv.includes('--force');
  if (!force && existsSync(PREBUILD_FILE) && checkVersionStamp(versionKey)) {
    const stats = statSync(PREBUILD_FILE);
    console.log(`[build-linux-pty] Linux prebuild already exists (${(stats.size / 1024).toFixed(0)} KB), skipping.`);
    console.log('[build-linux-pty] Use --force to rebuild.');
    return;
  }

  if (force) {
    console.log('[build-linux-pty] --force specified, rebuilding...\n');
  } else if (existsSync(PREBUILD_FILE)) {
    console.log('[build-linux-pty] Version mismatch detected, rebuilding...\n');
  } else {
    console.log('[build-linux-pty] No Linux prebuild found, building...\n');
  }

  // Build
  try {
    if (IS_LINUX) {
      buildOnLinux(electronVersion, ptyVersion);
    } else {
      if (!isDockerAvailable()) {
        console.error('[build-linux-pty] ERROR: Docker is required for cross-compilation on ' + platform() + '.');
        console.error('');
        console.error('[build-linux-pty] Options:');
        console.error('[build-linux-pty]   1. Install Docker Desktop and run this script again');
        console.error('[build-linux-pty]   2. Build on a Linux machine (or WSL2):');
        console.error('[build-linux-pty]      # In WSL2 or on a Linux machine:');
        console.error('[build-linux-pty]      npm run build:linux-pty');
        console.error('[build-linux-pty]   3. Manually compile on Linux and copy pty.node to:');
        console.error(`[build-linux-pty]      ${PREBUILD_FILE}`);
        console.error('');
        console.error('[build-linux-pty] Manual compilation on Linux:');
        console.error('[build-linux-pty]   sudo apt install build-essential python3 make');
        console.error('[build-linux-pty]   npx @electron/rebuild -v ' + electronVersion + ' -f -w node-pty');
        console.error('[build-linux-pty]   cp node_modules/node-pty/build/Release/pty.node \\');
        console.error('[build-linux-pty]      node_modules/node-pty/prebuilds/linux-x64/pty.node');
        process.exit(1);
      }
      buildViaDocker(electronVersion, ptyVersion);
    }
  } catch (err) {
    console.error(`[build-linux-pty] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Write version stamp
  writeVersionStamp(versionKey);
  console.log(`[build-linux-pty] Wrote version stamp: ${versionKey}`);

  // Verify
  if (existsSync(PREBUILD_FILE)) {
    const stats = statSync(PREBUILD_FILE);
    console.log(`\n[build-linux-pty] Success! pty.node (${(stats.size / 1024).toFixed(0)} KB)`);
    console.log(`[build-linux-pty]   Location: ${PREBUILD_FILE}`);
  } else {
    console.error('\n[build-linux-pty] Failed: pty.node not found after build.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[build-linux-pty] Unexpected error:', err);
  process.exit(1);
});
