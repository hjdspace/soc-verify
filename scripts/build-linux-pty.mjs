/**
 * Build node-pty native binary for Linux (linux-x64).
 *
 * Problem:
 *   node-pty does not ship Linux prebuilds. A binary compiled on a modern
 *   distro can also require a newer glibc than enterprise targets such as
 *   CentOS 8 (glibc 2.28), causing the packaged AppImage to fall back to
 *   log mode even though pty.node is present.
 *
 * Solution:
 *   Build in a pinned Rocky Linux 8 container, statically link the C++
 *   runtime, and reject binaries that require glibc newer than 2.28. The
 *   resulting pty.node is placed in prebuilds/linux-x64/.
 *
 * Usage:
 *   node scripts/build-linux-pty.mjs           # build if missing
 *   node scripts/build-linux-pty.mjs --force   # force rebuild
 *
 * Requirements:
 *   - Docker must be running
 *
 * Environment variables:
 *   NPM_REGISTRY  - override npm registry (e.g. https://registry.npmmirror.com)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PTY_DIR = join(ROOT, 'node_modules', 'node-pty');
const BUILD_DIR = join(PTY_DIR, 'build');
const PREBUILD_DIR = join(PTY_DIR, 'prebuilds', 'linux-x64');
const PREBUILD_FILE = join(PREBUILD_DIR, 'pty.node');
const CACHE_DIR = join(ROOT, '.cache', 'linux-pty');
const VERSION_STAMP = join(CACHE_DIR, '.version');

const IS_WIN = platform() === 'win32';
const DOCKER_NODE_VERSION = '22.18.0';
const BUILD_PROFILE = 'rockylinux8-glibc228-static-cxx-v2';

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

// ─── Reproducible Linux build ───────────────────────────

function buildViaDocker(electronVersion, ptyVersion) {
  console.log('[build-linux-pty] Building via Docker (Rocky Linux 8 / glibc 2.28)...');

  const registry = getNpmRegistry();
  mkdirSync(CACHE_DIR, { recursive: true });

  // Convert path for Docker volume mount (Windows needs forward slashes)
  const cacheDir = CACHE_DIR.replace(/\\/g, '/');

  // Node is only the build runner. The native binary is compiled and linked
  // inside Rocky Linux 8, which fixes the maximum glibc baseline at 2.28.
  const dockerScript = [
    'set -euo pipefail',
    'dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python39 tar gzip xz curl binutils > /dev/null',
    `curl -fsSL https://nodejs.org/dist/v${DOCKER_NODE_VERSION}/node-v${DOCKER_NODE_VERSION}-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1`,
    'source /opt/rh/gcc-toolset-10/enable',
    'export PYTHON=/usr/bin/python3.9',
    'export npm_config_python=/usr/bin/python3.9',
    'python3.9 --version',
    'export LDFLAGS="-static-libstdc++ -static-libgcc"',
    'echo "[docker] Setting up build environment..."',
    'mkdir -p /tmp/pty-build && cd /tmp/pty-build',
    'npm init -y > /dev/null',
    `npm install node-pty@${ptyVersion} --ignore-scripts --registry ${registry} 2>&1 | tail -5`,
    `echo "[docker] Rebuilding node-pty for Electron ${electronVersion}..."`,
    `npx @electron/rebuild@4.2.0 -v ${electronVersion} -f -w node-pty --arch x64 --build-from-source 2>&1 | tail -20`,
    'echo "[docker] Verifying CentOS 8 compatibility..."',
    'required_glibc=$(readelf --version-info node_modules/node-pty/build/Release/pty.node | grep -o "GLIBC_[0-9.]*" | sort -Vu | tail -1)',
    'required_glibcxx=$(readelf --version-info node_modules/node-pty/build/Release/pty.node | grep -o "GLIBCXX_[0-9.]*" | sort -Vu | tail -1)',
    'test -n "$required_glibc"',
    'test "$(printf "%s\\n" "$required_glibc" "GLIBC_2.28" | sort -V | tail -1)" = "GLIBC_2.28"',
    'test -z "$required_glibcxx" || test "$(printf "%s\\n" "$required_glibcxx" "GLIBCXX_3.4.25" | sort -V | tail -1)" = "GLIBCXX_3.4.25"',
    '! readelf -d node_modules/node-pty/build/Release/pty.node | grep -q "libstdc++.so"',
    'echo "[docker] Maximum required glibc: $required_glibc"',
    'echo "[docker] Maximum required glibcxx: ${required_glibcxx:-none}"',
    '! ldd node_modules/node-pty/build/Release/pty.node | grep -q "not found"',
    'echo "[docker] Running PTY spawn/input/output/resize/exit smoke test..."',
    `node -e 'const pty=require("./node_modules/node-pty");let out="";const p=pty.spawn("/bin/bash",[],{cols:80,rows:24});const timer=setTimeout(()=>{console.error(out);process.exit(1)},5000);p.onData(d=>out+=d);p.onExit(e=>{clearTimeout(timer);process.exit(e.exitCode===0&&out.includes("__PTY_OK__")?0:1)});p.resize(100,30);p.write("echo __PTY_OK__; exit\\n")'`,
    'echo "[docker] Extracting pty.node..."',
    'mkdir -p /output',
    'cp node_modules/node-pty/build/Release/pty.node /output/pty.node',
    'echo "[docker] Build complete!"',
  ].join(' && ');

  const dockerArgs = [
    'run', '--rm',
    '--platform', 'linux/amd64',
    '-v', `${cacheDir}:/output`,
    'rockylinux:8',
    'bash', '-c', dockerScript,
  ];

  console.log('[build-linux-pty] Launching Docker container...');
  console.log('[build-linux-pty]   Image: rockylinux:8 (linux/amd64)');
  console.log(`[build-linux-pty]   Node.js: ${DOCKER_NODE_VERSION} (build runner only)`);
  console.log('[build-linux-pty]   Target glibc: <= 2.28 (CentOS 8)');
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
      'Make sure Docker is running and can access the configured npm registry.\n' +
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

function preparePackageLayout() {
  // node-pty checks build/Release before prebuilds/. Removing this directory
  // prevents a stale host or modern-Linux binary from shadowing our verified
  // CentOS 8-compatible prebuild in the AppImage.
  rmSync(BUILD_DIR, { recursive: true, force: true });
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
  const versionKey = `electron-${electronVersion}_pty-${ptyVersion}_${BUILD_PROFILE}`;

  console.log(`[build-linux-pty] Electron version: ${electronVersion}`);
  console.log(`[build-linux-pty] node-pty version: ${ptyVersion}`);
  console.log(`[build-linux-pty] Target: linux-x64`);
  console.log(`[build-linux-pty] Host platform: ${platform()}\n`);

  // Check if already built (skip if exists and version matches)
  const force = process.argv.includes('--force');
  if (!force && existsSync(PREBUILD_FILE) && checkVersionStamp(versionKey)) {
    const stats = statSync(PREBUILD_FILE);
    preparePackageLayout();
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
    if (!isDockerAvailable()) {
      throw new Error(
        `Docker is required on ${platform()} so node-pty is always built against the pinned CentOS 8 baseline.`
      );
    }
    buildViaDocker(electronVersion, ptyVersion);
    preparePackageLayout();
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
