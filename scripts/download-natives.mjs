/**
 * Extract pi_natives native addon from the omp full binary.
 *
 * The runner binary (socverify-runner) is compiled with `bun build --compile`,
 * which bundles all JS/TS code but CANNOT embed native addons (.node files)
 * because the Rust toolchain required to build them is unavailable.
 *
 * The omp engine's loader (loader-state.js) searches for the native addon in
 * several locations at runtime, including `execDir` — the directory containing
 * the runner executable (i.e. `resources/binaries/` in the packaged app).
 *
 * GitHub releases for oh-my-pi do NOT publish individual `.node` files; they
 * only publish full omp binaries (e.g. `omp-windows-x64.exe`, ~155MB) that
 * have the native addon embedded. This script:
 *
 *   1. Detects the engine version from `engine/oh-my-pi/packages/natives/package.json`
 *   2. Checks if the required .node files already exist (with version match)
 *   3. If not, downloads the matching omp binary for the current platform
 *   4. Extracts .node files directly from the embedded tar archive (primary method)
 *      OR runs the omp binary briefly to trigger extraction (fallback method)
 *   5. Copies the extracted .node files to `resources/binaries/`
 *   6. Caches the omp binary in `.cache/omp/` for future runs
 *   7. Writes a version stamp to track the extracted version
 *
 * The `.node` files in `resources/binaries/` are then packaged by
 * electron-builder's `extraResources` config and found by the runner at runtime.
 *
 * Optimization notes:
 *   - Only requires the "baseline" variant for x64 (works on all x64 CPUs)
 *   - Omp binary is cached in `.cache/omp/` to avoid re-downloading 155MB
 *   - Direct extraction is faster than running the binary (no process startup)
 *   - Version stamp ensures stale .node files are re-extracted after submodule update
 *
 * Usage:
 *   node scripts/download-natives.mjs
 *   node scripts/download-natives.mjs --version 16.4.0
 *
 * Environment variables:
 *   OMP_NATIVES_VERSION  - override the omp version (e.g. "16.4.0")
 *   OMP_NATIVES_OWNER    - override the GitHub owner (default: "can1357")
 *   OMP_NATIVES_REPO     - override the GitHub repo (default: "oh-my-pi")
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BINARIES_DIR = join(ROOT, 'resources', 'binaries');
const ENGINE_NATIVES_PKG = join(ROOT, 'engine', 'oh-my-pi', 'packages', 'natives', 'package.json');
const ENGINE_ROOT_PKG = join(ROOT, 'engine', 'oh-my-pi', 'package.json');
const OMP_CACHE_DIR = join(ROOT, '.cache', 'omp');
const VERSION_STAMP_FILE = join(BINARIES_DIR, '.natives-version');

const GITHUB_OWNER = process.env.OMP_NATIVES_OWNER ?? 'can1357';
const GITHUB_REPO = process.env.OMP_NATIVES_REPO ?? 'oh-my-pi';

const IS_WIN = platform() === 'win32';

// ─── Version resolution ─────────────────────────────────

/**
 * Resolve the omp engine version.
 *
 * Priority:
 *   1. --version CLI argument / OMP_NATIVES_VERSION env var
 *   2. engine/oh-my-pi/packages/natives/package.json "version" field
 *   3. engine/oh-my-pi/package.json "version" field
 *   4. Error (don't guess — version mismatch causes native addon load failures)
 */
function resolveOmpVersion() {
  // 1. CLI argument
  const versionArg = process.argv.find((a) => a.startsWith('--version='));
  if (versionArg) return versionArg.split('=')[1];
  const versionIdx = process.argv.indexOf('--version');
  if (versionIdx !== -1 && process.argv[versionIdx + 1]) {
    return process.argv[versionIdx + 1];
  }
  if (process.env.OMP_NATIVES_VERSION) return process.env.OMP_NATIVES_VERSION;

  // 2. Engine natives package.json (authoritative — the .node version sentinel
  //    is derived from this version)
  try {
    if (existsSync(ENGINE_NATIVES_PKG)) {
      const pkg = JSON.parse(readFileSync(ENGINE_NATIVES_PKG, 'utf-8'));
      if (pkg.version) {
        console.log(`[download-natives] omp version: ${pkg.version} (from natives/package.json)`);
        return pkg.version;
      }
    }
  } catch { /* ignore */ }

  // 3. Engine root package.json
  try {
    if (existsSync(ENGINE_ROOT_PKG)) {
      const pkg = JSON.parse(readFileSync(ENGINE_ROOT_PKG, 'utf-8'));
      if (pkg.version) {
        console.log(`[download-natives] omp version: ${pkg.version} (from engine package.json)`);
        return pkg.version;
      }
    }
  } catch { /* ignore */ }

  console.error('[download-natives] ERROR: Could not detect omp version.');
  console.error('[download-natives] The engine submodule must be initialized:');
  console.error('[download-natives]   git submodule update --init --recursive');
  console.error('[download-natives] Or specify explicitly:');
  console.error('[download-natives]   node scripts/download-natives.mjs --version 16.4.0');
  process.exit(1);
}

// ─── Version stamp ─────────────────────────────────────

/**
 * Check if the .node files are stale (version mismatch).
 *
 * Returns true if the version stamp matches the current version, false otherwise.
 */
function checkVersionStamp(version) {
  try {
    if (existsSync(VERSION_STAMP_FILE)) {
      const stamp = readFileSync(VERSION_STAMP_FILE, 'utf-8').trim();
      return stamp === version;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Write the version stamp file after successful extraction.
 */
function writeVersionStamp(version) {
  mkdirSync(BINARIES_DIR, { recursive: true });
  writeFileSync(VERSION_STAMP_FILE, version, 'utf-8');
}

// ─── Platform detection ─────────────────────────────────

/**
 * Get the omp binary asset name and the expected .node file names for the
 * current platform.
 *
 * Note: For x64, we only require the "baseline" variant. The "modern" (AVX2) variant
 * is an optional optimization, but we force baseline extraction to ensure the
 * .node files exist and work on all x64 CPUs.
 */
function getPlatformInfo() {
  const p = platform();
  const a = arch();

  let platformTag;
  let ompAssetName;

  if (p === 'win32' && a === 'x64') {
    platformTag = 'win32-x64';
    ompAssetName = 'omp-windows-x64.exe';
  } else if (p === 'linux' && a === 'x64') {
    platformTag = 'linux-x64';
    ompAssetName = 'omp-linux-x64';
  } else if (p === 'darwin' && a === 'x64') {
    platformTag = 'darwin-x64';
    ompAssetName = 'omp-darwin-x64';
  } else if (p === 'darwin' && a === 'arm64') {
    platformTag = 'darwin-arm64';
    ompAssetName = 'omp-darwin-arm64';
  } else if (p === 'linux' && a === 'arm64') {
    platformTag = 'linux-arm64';
    ompAssetName = 'omp-linux-arm64';
  } else {
    console.error(`[download-natives] Unsupported platform: ${p}-${a}`);
    process.exit(1);
  }

  // Only require the baseline variant for x64 — it works on all x64 CPUs.
  // The "modern" (AVX2) variant is an optional optimization but causes perpetual
  // re-downloads because the extraction process forces baseline.
  // Non-x64 platforms have a single "default" variant.
  const nodeFiles = a === 'x64'
    ? [`pi_natives.${platformTag}-baseline.node`]
    : [`pi_natives.${platformTag}.node`];

  return { platformTag, ompAssetName, nodeFiles };
}

// ─── Download ───────────────────────────────────────────

function buildOmpDownloadUrl(version, assetName) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tag}/${assetName}`;
}

async function downloadFile(url, destPath) {
  console.log(`[download-natives] Downloading: ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = dirname(destPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(destPath, buffer);
  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
  console.log(`[download-natives] Saved: ${destPath} (${sizeMB} MB)`);
  return buffer.length;
}

// ─── Native addon extraction ────────────────────────────

/**
 * Get the natives cache directory: ~/.omp/natives/<version>/.
 * Mirrors the logic in loader-state.js getNativesDir().
 */
function getVersionedNativesDir(version) {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  let nativesDir;
  if (xdgDataHome && existsSync(join(xdgDataHome, 'omp'))) {
    nativesDir = join(xdgDataHome, 'omp', 'natives');
  } else {
    nativesDir = join(homedir(), '.omp', 'natives');
  }
  return join(nativesDir, version);
}

/**
 * Extract .node files directly from the omp binary file.
 *
 * The omp binary is a Bun --compile output. The embedded addon archive
 * (embedded-addons.<platform>.tar.gz) is stored as a Bun asset within the
 * binary. We search for gzip magic bytes and try to extract a valid tar
 * archive containing .node files.
 *
 * This is the primary extraction method because it's faster than running the
 * binary (no process startup overhead) and can extract all matching .node files.
 */
async function extractNativesFromBinary(ompBinaryPath, nodeFiles, platformTag) {
  console.log('[download-natives] Extracting .node files from omp binary...');

  const zlib = await import('node:zlib');
  const binaryBuffer = readFileSync(ompBinaryPath);
  const results = [];

  // Search for gzip magic bytes (0x1f 0x8b 0x08) — the embedded archive is
  // a gzip-compressed tar containing the .node files.
  const gzipMagic = Buffer.from([0x1f, 0x8b, 0x08]);
  let offset = 0;

  while (offset < binaryBuffer.length - 512) {
    const found = binaryBuffer.indexOf(gzipMagic, offset);
    if (found === -1) break;

    // Try to decompress from this offset
    try {
      const chunk = binaryBuffer.subarray(found);
      const decompressed = zlib.gunzipSync(chunk);

      // Check if it's a tar archive containing .node files
      if (decompressed.length > 512) {
        const extracted = parseTarForNodeFiles(decompressed, nodeFiles);
        if (extracted.length > 0) {
          console.log(`[download-natives] Found embedded archive at offset ${found}`);
          mkdirSync(BINARIES_DIR, { recursive: true });
          for (const { filename, data } of extracted) {
            const destPath = join(BINARIES_DIR, filename);
            writeFileSync(destPath, data);
            const sizeMB = (data.length / (1024 * 1024)).toFixed(1);
            console.log(`[download-natives] Extracted: ${filename} (${sizeMB} MB)`);
            results.push(filename);
          }
          if (results.length === nodeFiles.length) {
            console.log(`[download-natives] Extracted all required .node files (${results.length}/${nodeFiles.length})`);
            return results;
          }
        }
      }
    } catch {
      // Not a valid gzip stream at this offset — continue searching
    }

    offset = found + 1;
  }

  if (results.length > 0) {
    console.log(`[download-natives] Partial extraction: ${results.length}/${nodeFiles.length} files extracted`);
    return results;
  }

  console.warn('[download-natives] Direct extraction failed — no .node files found in binary');
  return [];
}

/**
 * Fallback: run the omp binary briefly to trigger native addon extraction.
 *
 * The omp binary, when its agent starts, imports @oh-my-pi/pi-natives which
 * calls loadNative(). loadNative() detects the embedded addon and extracts
 * the .node files to ~/.omp/natives/<version>/.
 *
 * We close stdin immediately so the agent exits quickly after extraction.
 */
function runOmpToExtractNatives(ompBinaryPath, version) {
  console.log('[download-natives] Running omp binary to extract native addons (fallback)...');

  // Delete the versioned natives dir first to force re-extraction
  const versionedDir = getVersionedNativesDir(version);
  if (existsSync(versionedDir)) {
    rmSync(versionedDir, { recursive: true, force: true });
  }

  // Run with stdin closed (pipe empty input) and a timeout.
  // The agent will start, import natives (triggering extraction), then exit.
  const result = spawnSync(ompBinaryPath, [], {
    input: '',
    timeout: 30000,  // 30 second timeout
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_NATIVE_VARIANT: 'baseline' }, // force baseline to avoid AVX2 detection overhead
    windowsHide: true,
  });

  // The process may exit with an error (no TTY, no API key, etc.) but that's OK —
  // the native addon extraction happens during module initialization, before any
  // agent logic runs.
  if (result.error) {
    console.warn(`[download-natives] omp binary run had an error: ${result.error.message}`);
  } else {
    const exitCode = result.status;
    console.log(`[download-natives] omp binary exited with code ${exitCode} (expected — extraction happens on startup)`);
  }

  // Check if the .node files were extracted
  if (!existsSync(versionedDir)) {
    console.warn('[download-natives] Natives directory not created after running omp binary.');
    return null;
  }

  const entries = readdirSync(versionedDir);
  const nodeFiles = entries.filter((f) => f.endsWith('.node'));
  if (nodeFiles.length === 0) {
    console.warn(`[download-natives] No .node files found in ${versionedDir}`);
    return null;
  }

  console.log(`[download-natives] Found ${nodeFiles.length} .node file(s) in ${versionedDir}:`);
  for (const f of nodeFiles) {
    const stats = statSync(join(versionedDir, f));
    console.log(`[download-natives]   ${f} (${(stats.size / (1024 * 1024)).toFixed(1)} MB)`);

    // Copy to BINARIES_DIR immediately
    const destPath = join(BINARIES_DIR, f);
    copyFileSync(join(versionedDir, f), destPath);
  }

  return { versionedDir, nodeFiles };
}

/**
 * Parse a tar buffer and extract .node files matching the expected names.
 */
function parseTarForNodeFiles(tarBuffer, expectedNames) {
  const results = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    // Check for end-of-archive (two consecutive zero blocks)
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (tarBuffer[offset + i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    // Parse tar header
    const name = tarBuffer.toString('utf8', offset, offset + 100).replace(/\0/g, '');
    const sizeStr = tarBuffer.toString('utf8', offset + 124, offset + 136).replace(/\0/g, '').trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeflag = tarBuffer[offset + 156];

    offset += 512;

    if (typeflag === 0 || typeflag === 0x30) { // regular file
      const baseName = name.split('/').pop();
      if (expectedNames.includes(baseName) && size > 0 && offset + size <= tarBuffer.length) {
        results.push({ filename: baseName, data: tarBuffer.subarray(offset, offset + size) });
      }
    }

    // Skip to next block boundary
    offset += Math.ceil(size / 512) * 512;
  }

  return results;
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('[download-natives] Starting native addon extraction...\n');

  const version = resolveOmpVersion();
  const { platformTag, ompAssetName, nodeFiles } = getPlatformInfo();
  console.log(`[download-natives] platform: ${platformTag}`);
  console.log(`[download-natives] expected .node files: ${nodeFiles.join(', ')}`);
  console.log(`[download-natives] omp binary: ${ompAssetName}\n`);

  // Check if all .node files already exist AND version stamp matches
  const existing = nodeFiles.filter((name) => existsSync(join(BINARIES_DIR, name)));
  const versionMatches = checkVersionStamp(version);
  if (existing.length === nodeFiles.length && versionMatches) {
    console.log('[download-natives] All native addons already exist with correct version. Skipping.');
    for (const name of existing) {
      const stats = statSync(join(BINARIES_DIR, name));
      console.log(`[download-natives]   ${name} (${(stats.size / (1024 * 1024)).toFixed(1)} MB)`);
    }
    return;
  }

  if (!versionMatches) {
    console.log('[download-natives] Version mismatch detected. Re-extracting native addons.');
  } else {
    console.log(`[download-natives] Missing .node files: ${nodeFiles.filter(n => !existing.includes(n)).join(', ')}`);
  }

  // Ensure cache directory exists
  mkdirSync(OMP_CACHE_DIR, { recursive: true });

  // Check if omp binary is already cached
  const cachedBinaryPath = join(OMP_CACHE_DIR, ompAssetName);
  const ompBinaryPath = existsSync(cachedBinaryPath) ? cachedBinaryPath : join(BINARIES_DIR, `_omp-temp-${ompAssetName}`);
  let downloaded = !existsSync(cachedBinaryPath);

  if (downloaded) {
    // Download the omp binary
    const ompUrl = buildOmpDownloadUrl(version, ompAssetName);
    try {
      await downloadFile(ompUrl, ompBinaryPath);
    } catch (err) {
      console.error(`[download-natives] Failed to download omp binary: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[download-natives] URL: ${ompUrl}`);
      console.error('[download-natives] The AI Agent will not work without the native addon.');
      process.exit(1);
    }

    // Make the binary executable on Unix
    if (!IS_WIN) {
      try { chmodSync(ompBinaryPath, 0o755); } catch { /* best-effort */ }
    }

    // Copy to cache for future runs
    if (ompBinaryPath !== cachedBinaryPath) {
      try {
        copyFileSync(ompBinaryPath, cachedBinaryPath);
        console.log(`[download-natives] Cached omp binary to: ${cachedBinaryPath}`);
      } catch (err) {
        console.warn(`[download-natives] Failed to cache omp binary: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    console.log(`[download-natives] Using cached omp binary: ${cachedBinaryPath}`);
  }

  // Method 1: Direct extraction from binary (faster, no process startup)
  let extractedFiles = await extractNativesFromBinary(ompBinaryPath, nodeFiles, platformTag);
  let extracted = null;

  if (extractedFiles.length > 0) {
    extracted = { versionedDir: null, nodeFiles: extractedFiles };
  }

  // Method 2: Fallback — run the omp binary to trigger extraction
  if (!extracted || extracted.nodeFiles.length === 0) {
    console.log('[download-natives] Direct extraction incomplete or failed. Running omp binary as fallback...');
    extracted = runOmpToExtractNatives(ompBinaryPath, version);
  }

  // Clean up the temp omp binary (but keep the cached one)
  if (ompBinaryPath !== cachedBinaryPath) {
    try {
      rmSync(ompBinaryPath, { force: true });
      console.log('[download-natives] Cleaned up temp omp binary.');
    } catch {
      // Best-effort cleanup
    }
  }

  if (!extracted || extracted.nodeFiles.length === 0) {
    console.error('[download-natives] ERROR: Failed to extract native addons!');
    console.error('[download-natives] Both methods (direct extraction, run binary) failed.');
    process.exit(1);
  }

  // Verify we have the required files
  const missing = nodeFiles.filter(n => !extracted.nodeFiles.includes(n));
  if (missing.length > 0) {
    console.warn(`[download-natives] Warning: Missing .node files: ${missing.join(', ')}`);
    console.warn('[download-natives] The app may not work correctly without these files.');
  }

  // Write version stamp
  writeVersionStamp(version);
  console.log(`[download-natives] Wrote version stamp: ${version}`);

  console.log('\n[download-natives] Done. Native addons are ready for packaging.');
}

main().catch((err) => {
  console.error('[download-natives] Unexpected error:', err);
  process.exit(1);
});
