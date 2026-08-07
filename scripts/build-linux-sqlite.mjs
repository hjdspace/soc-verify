/**
 * Build better-sqlite3 native binary for Linux (linux-x64) with old glibc.
 *
 * Problem:
 *   better-sqlite3 v13 ships prebuilt binaries compiled on a modern Linux
 *   (glibc >= 2.29). When the AppImage runs on an older enterprise Linux
 *   (e.g. CentOS 7 with glibc 2.17, Ubuntu 18.04 with glibc 2.27), the
 *   binary fails to load:
 *     "/lib64/libm.so.6: version `GLIBC_2.29' not found"
 *
 * Solution:
 *   Cross-compile better-sqlite3 from source in a Docker container based on
 *   CentOS 7 (glibc 2.17) with devtoolset-11 (GCC 11 for C++20 support).
 *   The resulting .node binary is linked against glibc 2.17, making it
 *   compatible with virtually all Linux distributions still in use.
 *
 *   - On Linux: compiles directly using @electron/rebuild
 *   - On Windows/macOS: uses Docker to cross-compile in a CentOS 7 container
 *
 *   The compiled binary replaces the prebuilt one at
 *   `node_modules/better-sqlite3/prebuilds/linux-x64.node`.
 *
 * Usage:
 *   node scripts/build-linux-sqlite.mjs           # build if missing
 *   node scripts/build-linux-sqlite.mjs --force   # force rebuild
 *
 * Requirements:
 *   - On Windows/macOS: Docker must be running
 *   - On Linux: build-essential, python3, make, g++-10 (or newer) must be installed
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

const SQLITE_DIR = join(ROOT, 'node_modules', 'better-sqlite3');
const PREBUILD_FILE = join(SQLITE_DIR, 'prebuilds', 'linux-x64.node');
const CACHE_DIR = join(ROOT, '.cache', 'linux-sqlite');
const VERSION_STAMP = join(CACHE_DIR, '.version');

const IS_LINUX = platform() === 'linux';
const IS_WIN = platform() === 'win32';

// Node.js 18 LTS — last version with official CentOS 7 / glibc 2.17 support.
// better-sqlite3 v13 requires Node.js >= 22, but that's only an engines field;
// the build scripts (deps/copy.js, lib/binding.js) use basic fs/path APIs
// that work fine on Node.js 18. @electron/rebuild compiles against
// Electron's V8 headers, not the host Node.js, so the version mismatch
// doesn't affect the output binary.
const DOCKER_NODE_VERSION = '18.20.6';

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
  if (process.env.NPM_REGISTRY) return process.env.NPM_REGISTRY;
  try {
    const npmrcPath = join(ROOT, '.npmrc');
    if (existsSync(npmrcPath)) {
      const content = readFileSync(npmrcPath, 'utf-8');
      const match = content.match(/^registry\s*=\s*(.+)$/m);
      if (match) return match[1].trim();
    }
  } catch { /* ignore */ }
  return 'https://registry.npmjs.org/';
}

// ─── Build on Linux (direct) ────────────────────────────

function buildOnLinux(electronVersion, _sqliteVersion) {
  console.log('[build-linux-sqlite] Building on Linux directly...');

  // Remove the prebuilt binary so binding.gyp's prebuild_exists check
  // returns 0, forcing a full source compilation.
  if (existsSync(PREBUILD_FILE)) {
    console.log('[build-linux-sqlite] Removing existing prebuilt binary to force source build...');
    spawnSync('rm', ['-f', PREBUILD_FILE], { stdio: 'inherit' });
  }

  const result = spawnSync('npx', [
    '@electron/rebuild',
    '-v', electronVersion,
    '-f', '-w', 'better-sqlite3',
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
      '  Ubuntu/Debian: sudo apt install build-essential python3 make g++-10\n' +
      '  Fedora/RHEL:   sudo dnf install gcc-c++ make python3\n' +
      '\n' +
      'Note: better-sqlite3 requires C++20 (-std=c++20).\n' +
      '  GCC 10+ is required. On Ubuntu 18.04, install from PPA:\n' +
      '    sudo add-apt-repository ppa:ubuntu-toolchain-r/test\n' +
      '    sudo apt install g++-10\n' +
      '    sudo update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-10 100'
    );
  }

  // The binary is at node_modules/better-sqlite3/build/Release/better_sqlite3.node
  const builtFile = join(SQLITE_DIR, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(builtFile)) {
    throw new Error(`Expected build output not found: ${builtFile}`);
  }

  // Copy to prebuilds directory
  mkdirSync(dirname(PREBUILD_FILE), { recursive: true });
  copyFileSync(builtFile, PREBUILD_FILE);
  console.log(`[build-linux-sqlite] Copied to ${PREBUILD_FILE}`);

  // Note about glibc compatibility
  console.warn('[build-linux-sqlite] WARNING: Direct build links against the host glibc.');
  console.warn('[build-linux-sqlite] For maximum compatibility, use Docker cross-compile (run on Windows/macOS).');
}

// ─── Build via Docker (cross-compile with old glibc) ────

function buildViaDocker(electronVersion, sqliteVersion) {
  console.log('[build-linux-sqlite] Building via Docker (CentOS 7 + devtoolset-11)...');
  console.log('[build-linux-sqlite] Target glibc: 2.17 (maximum compatibility)');

  const registry = getNpmRegistry();
  mkdirSync(CACHE_DIR, { recursive: true });

  // Convert path for Docker volume mount (Windows needs forward slashes)
  const cacheDir = CACHE_DIR.replace(/\\/g, '/');

  // Docker build script using CentOS 7 + devtoolset-11
  // - CentOS 7 provides glibc 2.17 (oldest still in use in enterprise)
  // - devtoolset-11 provides GCC 11 with C++20 support (-std=c++20)
  // - Node.js 18 is downloaded as a binary (NodeSource doesn't support CentOS 7)
  // - --engine-strict=false bypasses better-sqlite3 v13's Node.js >= 22 requirement
  // - Prebuilt binary is removed to force source compilation
  const dockerScript = [
    'set -e',
    `echo "[docker] === CentOS 7 + devtoolset-11 build environment ==="`,

    // ── Fix CentOS 7 repos (EOL — redirect to vault.centos.org) ──
    `echo "[docker] Fixing CentOS 7 repositories (EOL)..."`,
    'sed -i \'s/mirrorlist/#mirrorlist/g\' /etc/yum.repos.d/CentOS-*.repo || true',
    'sed -i \'s|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g\' /etc/yum.repos.d/CentOS-*.repo || true',

    // ── Install SCL (Software Collections) for devtoolset ──
    `echo "[docker] Installing centos-release-scl..."`,
    'yum install -y centos-release-scl > /dev/null 2>&1',
    'sed -i \'s/mirrorlist/#mirrorlist/g\' /etc/yum.repos.d/CentOS-SCLo-*.repo || true',
    'sed -i \'s|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g\' /etc/yum.repos.d/CentOS-SCLo-*.repo || true',

    // ── Install build tools ──
    `echo "[docker] Installing devtoolset-11 (GCC 11), make, python3..."`,
    'yum install -y devtoolset-11-gcc devtoolset-11-gcc-c++ make python3 > /dev/null 2>&1',

    // ── Install Node.js 18 (binary download, avoids NodeSource CentOS 7 issues) ──
    `echo "[docker] Installing Node.js ${DOCKER_NODE_VERSION}..."`,
    `curl -fsSL https://nodejs.org/dist/v${DOCKER_NODE_VERSION}/node-v${DOCKER_NODE_VERSION}-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1`,
    'node --version && npm --version',

    // ── Set up build environment ──
    `echo "[docker] Setting up build environment..."`,
    'mkdir -p /tmp/sqlite-build && cd /tmp/sqlite-build',
    'npm init -y > /dev/null',

    // ── Install better-sqlite3 (bypass engines check) ──
    `echo "[docker] Installing better-sqlite3@${sqliteVersion}..."`,
    `npm install better-sqlite3@${sqliteVersion} --engine-strict=false --registry ${registry} 2>&1 | tail -5`,

    // ── Remove prebuilt binary to force source compilation ──
    `echo "[docker] Removing prebuilt linux-x64 binary to force source build..."`,
    'rm -f node_modules/better-sqlite3/prebuilds/linux-x64.node',

    // ── Enable devtoolset-11 and rebuild for Electron ──
    `echo "[docker] Rebuilding better-sqlite3 for Electron ${electronVersion}..."`,
    `echo "[docker] Using GCC 11 (devtoolset-11) for C++20 support..."`,
    'source /opt/rh/devtoolset-11/enable',
    'gcc --version | head -1',
    `npx @electron/rebuild -v ${electronVersion} -f -w better-sqlite3 --arch x64 2>&1 | tail -20`,

    // ── Extract the compiled binary ──
    `echo "[docker] Extracting better_sqlite3.node..."`,
    'mkdir -p /output',
    'cp node_modules/better-sqlite3/build/Release/better_sqlite3.node /output/better_sqlite3.node',
    'echo "[docker] Build complete!"',
  ].join(' && ');

  const dockerArgs = [
    'run', '--rm',
    '--platform', 'linux/amd64',
    '-v', `${cacheDir}:/output`,
    'centos:7',
    'bash', '-c', dockerScript,
  ];

  console.log('[build-linux-sqlite] Launching Docker container...');
  console.log(`[build-linux-sqlite]   Image: centos:7 (linux/amd64)`);
  console.log(`[build-linux-sqlite]   GCC: devtoolset-11 (GCC 11, C++20)`);
  console.log(`[build-linux-sqlite]   Node.js: ${DOCKER_NODE_VERSION} (build tool only)`);
  console.log(`[build-linux-sqlite]   Electron: ${electronVersion}`);
  console.log(`[build-linux-sqlite]   better-sqlite3: ${sqliteVersion}`);
  console.log(`[build-linux-sqlite]   Registry: ${registry}\n`);

  const result = spawnSync('docker', dockerArgs, {
    stdio: 'inherit',
    shell: IS_WIN,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(
      'Docker build failed.\n' +
      'Make sure Docker is running.\n' +
      'On Apple Silicon Macs, QEMU emulation will be used (slower but functional).\n' +
      '\n' +
      'If centos:7 image pull fails, try:\n' +
      '  docker pull centos:7\n' +
      '  docker pull quay.io/centos/centos:7'
    );
  }

  // Copy from cache to prebuilds directory
  const cachedFile = join(CACHE_DIR, 'better_sqlite3.node');
  if (!existsSync(cachedFile)) {
    throw new Error(`Docker build output not found: ${cachedFile}`);
  }

  mkdirSync(dirname(PREBUILD_FILE), { recursive: true });
  copyFileSync(cachedFile, PREBUILD_FILE);
  console.log(`[build-linux-sqlite] Copied to ${PREBUILD_FILE}`);
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('[build-linux-sqlite] Starting...\n');

  // Check better-sqlite3 exists
  if (!existsSync(SQLITE_DIR)) {
    console.error('[build-linux-sqlite] ERROR: node_modules/better-sqlite3 not found.');
    console.error('[build-linux-sqlite] Run `npm install` first.');
    process.exit(1);
  }

  // Read versions
  const electronVersion = readVersion(join(ROOT, 'node_modules', 'electron', 'package.json'));
  const sqliteVersion = readVersion(join(SQLITE_DIR, 'package.json'));
  // Version key includes both versions so stale binaries are detected after upgrades
  const versionKey = `electron-${electronVersion}_sqlite-${sqliteVersion}`;

  console.log(`[build-linux-sqlite] Electron version: ${electronVersion}`);
  console.log(`[build-linux-sqlite] better-sqlite3 version: ${sqliteVersion}`);
  console.log(`[build-linux-sqlite] Target: linux-x64 (glibc 2.17+)`);
  console.log(`[build-linux-sqlite] Host platform: ${platform()}\n`);

  // Check if already built (skip if exists and version matches)
  const force = process.argv.includes('--force');
  if (!force && existsSync(PREBUILD_FILE) && checkVersionStamp(versionKey)) {
    const stats = statSync(PREBUILD_FILE);
    console.log(`[build-linux-sqlite] Linux prebuild already exists (${(stats.size / 1024).toFixed(0)} KB), skipping.`);
    console.log('[build-linux-sqlite] Use --force to rebuild.');
    return;
  }

  if (force) {
    console.log('[build-linux-sqlite] --force specified, rebuilding...\n');
  } else if (existsSync(PREBUILD_FILE)) {
    console.log('[build-linux-sqlite] Version mismatch detected, rebuilding...\n');
  } else {
    console.log('[build-linux-sqlite] No compatible Linux prebuild found, building...\n');
  }

  // Build
  try {
    if (IS_LINUX) {
      buildOnLinux(electronVersion, sqliteVersion);
    } else {
      if (!isDockerAvailable()) {
        console.error('[build-linux-sqlite] ERROR: Docker is required for cross-compilation on ' + platform() + '.');
        console.error('');
        console.error('[build-linux-sqlite] Options:');
        console.error('[build-linux-sqlite]   1. Install Docker Desktop and run this script again');
        console.error('[build-linux-sqlite]   2. Build on a Linux machine (or WSL2):');
        console.error('[build-linux-sqlite]      # In WSL2 or on a Linux machine:');
        console.error('[build-linux-sqlite]      npm run build:linux-sqlite');
        console.error('[build-linux-sqlite]   3. Manually compile on Linux and copy better_sqlite3.node to:');
        console.error(`[build-linux-sqlite]      ${PREBUILD_FILE}`);
        console.error('');
        console.error('[build-linux-sqlite] Manual compilation on Linux:');
        console.error('[build-linux-sqlite]   # Requires GCC 10+ (for C++20 support)');
        console.error('[build-linux-sqlite]   rm -f node_modules/better-sqlite3/prebuilds/linux-x64.node');
        console.error('[build-linux-sqlite]   npx @electron/rebuild -v ' + electronVersion + ' -f -w better-sqlite3');
        console.error('[build-linux-sqlite]   cp node_modules/better-sqlite3/build/Release/better_sqlite3.node \\');
        console.error('[build-linux-sqlite]      node_modules/better-sqlite3/prebuilds/linux-x64.node');
        process.exit(1);
      }
      buildViaDocker(electronVersion, sqliteVersion);
    }
  } catch (err) {
    console.error(`[build-linux-sqlite] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Write version stamp
  writeVersionStamp(versionKey);
  console.log(`[build-linux-sqlite] Wrote version stamp: ${versionKey}`);

  // Verify
  if (existsSync(PREBUILD_FILE)) {
    const stats = statSync(PREBUILD_FILE);
    console.log(`\n[build-linux-sqlite] Success! better_sqlite3.node (${(stats.size / 1024).toFixed(0)} KB)`);
    console.log(`[build-linux-sqlite]   Location: ${PREBUILD_FILE}`);
    console.log(`[build-linux-sqlite]   Compiled with: glibc 2.17 (CentOS 7) + GCC 11 (devtoolset-11)`);
    console.log(`[build-linux-sqlite]   Compatible with: all Linux distributions with glibc >= 2.17`);
  } else {
    console.error('\n[build-linux-sqlite] Failed: better_sqlite3.node not found after build.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[build-linux-sqlite] Unexpected error:', err);
  process.exit(1);
});
