/**
 * Build a CentOS 8-compatible better-sqlite3 binary for Linux x64.
 *
 * better-sqlite3 v13 ships a Linux prebuild that requires a newer glibc and
 * libstdc++ than CentOS 8 provides. Building directly on ubuntu-latest has the
 * same problem because the output inherits the build host's glibc baseline.
 *
 * This script always builds in Rocky Linux 8, statically links the C++ runtime,
 * verifies the ELF symbol requirements, and replaces the upstream prebuild.
 * Docker is required on every host, including Linux CI runners.
 * Set NODE_DIST_URL to use a Node.js binary mirror when needed.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SQLITE_DIR = join(ROOT, 'node_modules', 'better-sqlite3');
const BUILD_DIR = join(SQLITE_DIR, 'build');
const PREBUILD_FILE = join(SQLITE_DIR, 'prebuilds', 'linux-x64.node');
const CACHE_DIR = join(ROOT, '.cache', 'linux-sqlite');
const CACHED_FILE = join(CACHE_DIR, 'better_sqlite3.node');
const VERSION_STAMP = join(CACHE_DIR, '.version');

const DOCKER_NODE_VERSION = '22.18.0';
const NODE_DIST_URL = (process.env.NODE_DIST_URL ?? 'https://nodejs.org/dist').replace(/\/$/, '');
const BUILD_PROFILE = 'rockylinux8-glibc228-static-cxx-v1';

function readVersion(filePath) {
  const pkg = JSON.parse(readFileSync(filePath, 'utf-8'));
  return pkg.version;
}

function checkVersionStamp(versionKey) {
  try {
    if (existsSync(VERSION_STAMP)) {
      return readFileSync(VERSION_STAMP, 'utf-8').trim() === versionKey;
    }
  } catch { /* ignore */ }
  return false;
}

function writeVersionStamp(versionKey) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(VERSION_STAMP, versionKey, 'utf-8');
}

function isDockerAvailable() {
  try {
    const result = spawnSync('docker', ['--version'], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

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

function buildViaDocker(electronVersion, sqliteVersion) {
  console.log('[build-linux-sqlite] Building via Docker (Rocky Linux 8 / glibc 2.28)...');

  const registry = getNpmRegistry();
  mkdirSync(CACHE_DIR, { recursive: true });
  rmSync(CACHED_FILE, { force: true });

  const cacheDir = CACHE_DIR.replace(/\\/g, '/');
  const binary = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
  const dockerScript = [
    'set -euo pipefail',
    'dnf install -y gcc-toolset-10-gcc gcc-toolset-10-gcc-c++ make python39 tar gzip xz curl binutils > /dev/null',
    `curl -fsSL ${NODE_DIST_URL}/v${DOCKER_NODE_VERSION}/node-v${DOCKER_NODE_VERSION}-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1`,
    'export MANPATH="${MANPATH:-}"',
    'source /opt/rh/gcc-toolset-10/enable',
    'export PYTHON=/usr/bin/python3.9',
    'export npm_config_python=/usr/bin/python3.9',
    'export LDFLAGS="-static-libstdc++ -static-libgcc"',
    'python3.9 --version',
    'mkdir -p /tmp/sqlite-build && cd /tmp/sqlite-build',
    'npm init -y > /dev/null',
    `npm install better-sqlite3@${sqliteVersion} --ignore-scripts --registry ${registry} 2>&1 | tail -5`,
    'rm -f node_modules/better-sqlite3/prebuilds/linux-x64.node',
    `echo "[docker] Rebuilding better-sqlite3 for Electron ${electronVersion}..."`,
    `npx @electron/rebuild@4.2.0 -v ${electronVersion} -f -w better-sqlite3 --arch x64 --build-from-source 2>&1 | tail -20`,
    'echo "[docker] Verifying CentOS 8 compatibility..."',
    `required_glibc=$(readelf --version-info ${binary} | grep -o "GLIBC_[0-9.]*" | sort -Vu | tail -1)`,
    `required_glibcxx=$(readelf --version-info ${binary} | grep -o "GLIBCXX_[0-9.]*" | sort -Vu | tail -1 || true)`,
    'test -n "$required_glibc"',
    'test "$(printf "%s\\n" "$required_glibc" "GLIBC_2.28" | sort -V | tail -1)" = "GLIBC_2.28"',
    'test -z "$required_glibcxx" || test "$(printf "%s\\n" "$required_glibcxx" "GLIBCXX_3.4.25" | sort -V | tail -1)" = "GLIBCXX_3.4.25"',
    `! readelf -d ${binary} | grep -Eq "libstdc\\+\\+\\.so|libgcc_s\\.so"`,
    `! ldd ${binary} | grep -q "not found"`,
    'echo "[docker] Maximum required glibc: $required_glibc"',
    'echo "[docker] Maximum required glibcxx: ${required_glibcxx:-none}"',
    'echo "[docker] Running SQLite create/insert/select smoke test..."',
    `node -e 'const Database=require("./node_modules/better-sqlite3");const db=new Database(":memory:");db.exec("CREATE TABLE smoke(value TEXT NOT NULL)");db.prepare("INSERT INTO smoke(value) VALUES (?)").run("__SQLITE_OK__");const row=db.prepare("SELECT value FROM smoke").get();db.close();if(!row||row.value!=="__SQLITE_OK__")process.exit(1)'`,
    'mkdir -p /output',
    `cp ${binary} /output/better_sqlite3.node`,
    'echo "[docker] Build complete!"',
  ].join(' && ');

  const dockerArgs = [
    'run', '--rm',
    '--platform', 'linux/amd64',
    '-v', `${cacheDir}:/output`,
    'rockylinux:8',
    'bash', '-c', dockerScript,
  ];

  console.log('[build-linux-sqlite] Launching Docker container...');
  console.log('[build-linux-sqlite]   Image: rockylinux:8 (linux/amd64)');
  console.log(`[build-linux-sqlite]   Node.js: ${DOCKER_NODE_VERSION} (build runner only)`);
  console.log(`[build-linux-sqlite]   Node.js download: ${NODE_DIST_URL}`);
  console.log('[build-linux-sqlite]   Target glibc: <= 2.28 (CentOS 8)');
  console.log(`[build-linux-sqlite]   Electron: ${electronVersion}`);
  console.log(`[build-linux-sqlite]   better-sqlite3: ${sqliteVersion}`);
  console.log(`[build-linux-sqlite]   Registry: ${registry}\n`);

  const result = spawnSync('docker', dockerArgs, {
    stdio: 'inherit',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(
      'Docker build failed. Make sure Docker is running and can access the configured npm registry.'
    );
  }

  if (!existsSync(CACHED_FILE)) {
    throw new Error(`Docker build output not found: ${CACHED_FILE}`);
  }
}

function installCachedPrebuild() {
  mkdirSync(dirname(PREBUILD_FILE), { recursive: true });
  copyFileSync(CACHED_FILE, PREBUILD_FILE);
  console.log(`[build-linux-sqlite] Installed verified prebuild at ${PREBUILD_FILE}`);
}

function preparePackageLayout() {
  // Keep only the verified prebuild. A host build must never become fallback.
  rmSync(BUILD_DIR, { recursive: true, force: true });
}

async function main() {
  console.log('[build-linux-sqlite] Starting...\n');

  if (!existsSync(SQLITE_DIR)) {
    console.error('[build-linux-sqlite] ERROR: node_modules/better-sqlite3 not found.');
    console.error('[build-linux-sqlite] Run `npm install` first.');
    process.exit(1);
  }

  const electronVersion = readVersion(join(ROOT, 'node_modules', 'electron', 'package.json'));
  const sqliteVersion = readVersion(join(SQLITE_DIR, 'package.json'));
  const versionKey = `electron-${electronVersion}_sqlite-${sqliteVersion}_${BUILD_PROFILE}`;

  console.log(`[build-linux-sqlite] Electron version: ${electronVersion}`);
  console.log(`[build-linux-sqlite] better-sqlite3 version: ${sqliteVersion}`);
  console.log('[build-linux-sqlite] Target: linux-x64, glibc <= 2.28');
  console.log(`[build-linux-sqlite] Host platform: ${platform()}\n`);

  const force = process.argv.includes('--force');
  if (!force && existsSync(CACHED_FILE) && checkVersionStamp(versionKey)) {
    installCachedPrebuild();
    preparePackageLayout();
    const stats = statSync(PREBUILD_FILE);
    console.log(`[build-linux-sqlite] Reused verified Linux prebuild (${(stats.size / 1024).toFixed(0)} KB).`);
    console.log('[build-linux-sqlite] Use --force to rebuild.');
    return;
  }

  if (!isDockerAvailable()) {
    console.error(
      `[build-linux-sqlite] ERROR: Docker is required on ${platform()} so better-sqlite3 is always built against the pinned CentOS 8 baseline.`
    );
    process.exit(1);
  }

  try {
    buildViaDocker(electronVersion, sqliteVersion);
    installCachedPrebuild();
    preparePackageLayout();
  } catch (err) {
    console.error(`[build-linux-sqlite] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  writeVersionStamp(versionKey);
  console.log(`[build-linux-sqlite] Wrote version stamp: ${versionKey}`);

  const stats = statSync(PREBUILD_FILE);
  console.log(`\n[build-linux-sqlite] Success! better_sqlite3.node (${(stats.size / 1024).toFixed(0)} KB)`);
  console.log(`[build-linux-sqlite]   Location: ${PREBUILD_FILE}`);
  console.log('[build-linux-sqlite]   Verified for: CentOS/Rocky Linux 8 (glibc 2.28)');
}

main().catch((err) => {
  console.error('[build-linux-sqlite] Unexpected error:', err);
  process.exit(1);
});
