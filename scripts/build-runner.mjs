/**
 * Build the socverify-runner into a standalone binary using Bun's --compile.
 *
 * This script:
 *   1. Locates Bun on the local machine (PATH, ~/.bun/bin, BUN_INSTALL, …)
 *   2. If Bun is not found, downloads it automatically from GitHub releases
 *   3. If the Bun executable path contains non-ASCII characters (e.g. Chinese
 *      username on Windows), copies it to an ASCII-safe temporary location —
 *      `bun build --compile` fails with ENOENT when its own exe path is non-ASCII
 *   4. Runs `bun build --compile` from the engine's coding-agent directory
 *      (so workspace packages resolve correctly)
 *   5. Outputs the binary to resources/binaries/socverify-runner[.exe]
 *
 * Prerequisites:
 *   - engine/oh-my-pi submodule initialized (`git submodule update --init --recursive`)
 *   - Engine dependencies installed (`cd engine/oh-my-pi && bun install`)
 *   - Bun >= 1.3.14 (auto-downloaded if missing)
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir, platform, arch } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const IS_WIN = platform() === 'win32';
const BUN_EXE_NAME = IS_WIN ? 'bun.exe' : 'bun';
const MIN_BUN_VERSION = [1, 3, 14];

const RUNNER_SRC = join(ROOT, 'runner', 'index.ts');
const ENGINE_CODING_AGENT = join(ROOT, 'engine', 'oh-my-pi', 'packages', 'coding-agent');
const ENGINE_SDK = join(ENGINE_CODING_AGENT, 'src', 'sdk.ts');
const OUTPUT_DIR = join(ROOT, 'resources', 'binaries');
const OUTPUT_NAME = IS_WIN ? 'socverify-runner.exe' : 'socverify-runner';
const OUTPUT_PATH = join(OUTPUT_DIR, OUTPUT_NAME);

// ─── Utilities ───────────────────────────────────────────

/** Check whether a string contains only ASCII characters. */
function isAscii(str) {
  return /^[\x00-\x7F]*$/.test(str);
}

/**
 * Find an ASCII-safe directory for caching the copied/downloaded Bun binary.
 * Tries (in order): project .cache/bun → os.tmpdir() → fixed fallback path.
 */
function getAsciiSafeCacheDir() {
  const candidates = [
    join(ROOT, '.cache', 'bun'),
    join(tmpdir(), 'socverify-bun'),
    IS_WIN ? 'C:\\Temp\\socverify-bun' : '/tmp/socverify-bun',
  ];
  for (const dir of candidates) {
    if (isAscii(dir)) return dir;
  }
  // Last resort — even if non-ASCII, at least we tried
  return candidates[candidates.length - 1];
}

// ─── Bun discovery ───────────────────────────────────────

/**
 * Search the local machine for the Bun executable.
 *
 * Checks (in priority order):
 *   1. BUN_INSTALL environment variable
 *   2. ~/.bun/bin/bun[.exe]
 *   3. `where`/`which bun` results (filtered to .exe on Windows)
 *
 * Returns the absolute path to bun, or null if not found.
 */
function findBunExecutable() {
  const candidates = [];

  // 1. BUN_INSTALL env var (set by Bun's official installer)
  if (process.env.BUN_INSTALL) {
    candidates.push(join(process.env.BUN_INSTALL, 'bin', BUN_EXE_NAME));
  }

  // 2. ~/.bun/bin/ (default install location)
  candidates.push(join(homedir(), '.bun', 'bin', BUN_EXE_NAME));

  // 3. `where` / `which` — collect all results
  const lookupCmd = IS_WIN ? 'where' : 'which';
  const result = spawnSync(lookupCmd, ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status === 0 && result.stdout.trim()) {
    const paths = result.stdout.trim().split(/\r?\n/);
    for (const p of paths) {
      const trimmed = p.trim();
      if (!trimmed) continue;
      // On Windows, prefer .exe over .cmd / .ps1 wrappers
      if (IS_WIN && !trimmed.toLowerCase().endsWith('.exe')) continue;
      candidates.push(trimmed);
    }
  }

  // Return first candidate that actually exists
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Check Bun version meets the minimum requirement. */
function checkBunVersion(bunPath) {
  const result = spawnSync(bunPath, ['--version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    console.error('[build-runner] ERROR: Failed to get Bun version.');
    process.exit(1);
  }
  const version = result.stdout.trim();
  console.log(`[build-runner] Bun version: ${version}`);

  const parts = version.split('.').map(Number);
  for (let i = 0; i < MIN_BUN_VERSION.length; i++) {
    const installed = parts[i] ?? 0;
    const required = MIN_BUN_VERSION[i];
    if (installed > required) return version;
    if (installed < required) {
      console.error(
        `[build-runner] ERROR: Bun >= ${MIN_BUN_VERSION.join('.')} required, found ${version}`,
      );
      process.exit(1);
    }
  }
  return version;
}

// ─── Bun download (fallback) ─────────────────────────────

/** Get the Bun download URL for the current platform. */
function getBunDownloadUrl() {
  const p = platform();
  const a = arch();
  const base = 'https://github.com/oven-sh/bun/releases/latest/download';

  if (p === 'win32' && a === 'x64') return `${base}/bun-windows-x64.zip`;
  if (p === 'win32' && a === 'arm64') return `${base}/bun-windows-arm64.zip`;
  if (p === 'darwin' && a === 'x64') return `${base}/bun-darwin-x64.zip`;
  if (p === 'darwin' && a === 'arm64') return `${base}/bun-darwin-aarch64.zip`;
  if (p === 'linux' && a === 'x64') return `${base}/bun-linux-x64.zip`;
  if (p === 'linux' && a === 'arm64') return `${base}/bun-linux-aarch64.zip`;

  return null;
}

/**
 * Download and extract the Bun binary to destDir.
 * Returns the path to the extracted bun executable.
 */
async function downloadBun(destDir) {
  const url = getBunDownloadUrl();
  if (!url) {
    console.error(`[build-runner] ERROR: Unsupported platform: ${platform()}-${arch()}`);
    process.exit(1);
  }

  mkdirSync(destDir, { recursive: true });
  const zipPath = join(destDir, 'bun.zip');

  console.log(`[build-runner] Downloading Bun from: ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(zipPath, buffer);

  // Extract the zip
  console.log(`[build-runner] Extracting to: ${destDir}`);
  if (IS_WIN) {
    execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'pipe' });
  } else {
    execSync(`unzip -o '${zipPath}' -d '${destDir}'`, { stdio: 'pipe' });
  }

  // Clean up the zip file
  rmSync(zipPath, { force: true });

  // The zip contains the bun binary at the root
  const bunPath = join(destDir, BUN_EXE_NAME);
  if (!existsSync(bunPath)) {
    throw new Error(`Bun binary not found after extraction at ${bunPath}`);
  }

  // Make executable on Unix
  if (!IS_WIN) {
    execSync(`chmod +x '${bunPath}'`, { stdio: 'pipe' });
  }

  return bunPath;
}

// ─── ASCII-safe path handling ────────────────────────────

/**
 * If the Bun executable path contains non-ASCII characters, copy it to an
 * ASCII-safe temporary location.
 *
 * `bun build --compile` copies its own executable into the output binary.
 * On Windows, if the exe path contains non-ASCII characters (e.g. a Chinese
 * username like C:\Users\杨雅坤\...), the copy fails with ENOENT.
 *
 * Returns the ASCII-safe bun path.
 */
function ensureAsciiSafeBunPath(bunPath) {
  if (isAscii(bunPath)) return bunPath;

  const cacheDir = getAsciiSafeCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const safeBunPath = join(cacheDir, BUN_EXE_NAME);

  console.log(`[build-runner] Bun path contains non-ASCII characters:`);
  console.log(`[build-runner]   original: ${bunPath}`);
  console.log(`[build-runner]   copied to: ${safeBunPath}`);

  copyFileSync(bunPath, safeBunPath);

  // Make executable on Unix
  if (!IS_WIN) {
    execSync(`chmod +x '${safeBunPath}'`, { stdio: 'pipe' });
  }

  return safeBunPath;
}

/**
 * If the system temp directory (TEMP/TMP) contains non-ASCII characters,
 * return an ASCII-safe alternative path. Returns null if the system temp
 * is already ASCII-safe.
 */
function getAsciiSafeTempEnv() {
  const sysTmp = tmpdir();
  if (isAscii(sysTmp)) return null;

  // Use the same cache dir's parent as a safe temp location
  const safeTemp = IS_WIN ? 'C:\\Temp' : '/tmp';
  mkdirSync(safeTemp, { recursive: true });
  console.log(`[build-runner] System temp dir contains non-ASCII characters:`);
  console.log(`[build-runner]   original: ${sysTmp}`);
  console.log(`[build-runner]   using: ${safeTemp}`);
  return safeTemp;
}

// ─── Bun resolution (find → download → ASCII-safe) ──────

/**
 * Resolve a usable Bun executable path.
 *
 * Flow:
 *   1. Search the local machine
 *   2. If not found, download from GitHub releases
 *   3. Verify version >= minimum
 *   4. Copy to ASCII-safe path if needed
 */
async function resolveBun() {
  // 1. Try to find Bun on the machine
  let bunPath = findBunExecutable();

  if (bunPath) {
    console.log(`[build-runner] Found Bun: ${bunPath}`);
  } else {
    // 2. Not found — download it
    console.log('[build-runner] Bun not found locally. Downloading...');
    const cacheDir = getAsciiSafeCacheDir();
    bunPath = await downloadBun(cacheDir);
    console.log(`[build-runner] Downloaded Bun: ${bunPath}`);
  }

  // 3. Check version
  checkBunVersion(bunPath);

  // 4. Ensure ASCII-safe path
  const safeBunPath = ensureAsciiSafeBunPath(bunPath);

  return safeBunPath;
}

// ─── Pre-flight checks ──────────────────────────────────

function checkEngine() {
  if (!existsSync(ENGINE_SDK)) {
    console.error('[build-runner] ERROR: Engine submodule not found.');
    console.error('[build-runner] Initialize it with: git submodule update --init --recursive');
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'engine', 'oh-my-pi', 'node_modules'))) {
    console.error('[build-runner] ERROR: Engine dependencies not installed.');
    console.error('[build-runner] Install them with: cd engine/oh-my-pi && bun install');
    process.exit(1);
  }
  console.log('[build-runner] Engine submodule: OK');
}

function checkRunnerSource() {
  if (!existsSync(RUNNER_SRC)) {
    console.error(`[build-runner] ERROR: Runner source not found at ${RUNNER_SRC}`);
    process.exit(1);
  }
  console.log(`[build-runner] Runner source: ${RUNNER_SRC}`);
}

// ─── Build ───────────────────────────────────────────────

function buildRunner(bunPath) {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // If the system temp dir contains non-ASCII characters, override it.
  // `bun build --compile` uses the temp dir to stage the binary copy.
  const safeTemp = getAsciiSafeTempEnv();
  const env = { ...process.env };
  if (safeTemp) {
    env.TEMP = safeTemp;
    env.TMP = safeTemp;
  }

  // Run from the engine's coding-agent package directory so that
  // workspace packages (@oh-my-pi/pi-coding-agent and its deps) resolve.
  // Use the absolute path to bun and the entry file for reliability.
  const cmd = `"${bunPath}" build --compile "${RUNNER_SRC}" --outfile "${OUTPUT_PATH}"`;
  console.log(`[build-runner] Running: ${cmd}`);
  console.log(`[build-runner] CWD: ${ENGINE_CODING_AGENT}`);

  try {
    execSync(cmd, {
      cwd: ENGINE_CODING_AGENT,
      stdio: 'inherit',
      env,
    });
  } catch (err) {
    console.error('[build-runner] Build failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!existsSync(OUTPUT_PATH)) {
    console.error(`[build-runner] ERROR: Output binary not found at ${OUTPUT_PATH}`);
    process.exit(1);
  }

  console.log(`[build-runner] Built successfully: ${OUTPUT_PATH}`);
}

// ─── Main ────────────────────────────────────────────────

console.log('[build-runner] Starting runner binary build...\n');
checkEngine();
checkRunnerSource();
const bunPath = await resolveBun();
buildRunner(bunPath);
console.log('\n[build-runner] Done. Binary is ready for packaging.');
