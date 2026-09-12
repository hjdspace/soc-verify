/**
 * Wrapper for electron-builder that handles TLS certificate issues.
 *
 * Problem:
 *   In corporate/VPN environments with SSL inspection, electron-builder's
 *   HTTP requests fail with "unable to verify the first certificate".
 *   Node.js bundles its own CA list and doesn't use the system CA store
 *   by default, so custom root CAs installed by the proxy are not trusted.
 *
 * Solution:
 *   1. Try with `--use-system-ca` (Node.js 19+) — uses the OS CA store
 *   2. If that flag is not supported, fall back to
 *      `NODE_TLS_REJECT_UNAUTHORIZED=0` (disables TLS verification entirely)
 *
 * Usage:
 *   node scripts/run-electron-builder.mjs --win
 *   node scripts/run-electron-builder.mjs
 *   node scripts/run-electron-builder.mjs --win --compression-level 9
 *
 * Compression level:
 *   electron-builder maps yml `compression: normal|maximum` to 7z `-mx=9`
 *   for the NSIS app archive (app-builder-lib/out/targets/archive.js,
 *   compute7zCompressArgs). For this app (~817MB, 31k files) that single
 *   step takes ~5.5 minutes of pure CPU time. The env var
 *   ELECTRON_BUILDER_COMPRESSION_LEVEL (single digit 0-9) overrides the yml
 *   setting; `--compression-level N` sets it from the CLI.
 *
 *   Defaults:
 *     - CI (release.yml): no override → full -mx=9 compression, smallest
 *       published installer.
 *     - Local: 3 → ~24s instead of ~5.5min (installer grows ~45MB). Pass
 *       `--compression-level 9` for a locally-built, size-optimized installer.
 */

import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, access, constants } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MAX_RETRIES = 5;
const BASE_DELAY_SEC = 30;

// Only GitHub Actions publishes installer assets (and needs the 503 retry
// loop for the GitHub API). Locally GITHUB_ACTIONS is unset — but note some
// machines set CI globally, so CI is intentionally NOT used here.
const IS_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

// ─── Pre-build cleanup ───────────────────────────────────────────────────────
// Remove the dist directory before building. On Windows, leftover files from a
// previous build can be locked by Explorer / antivirus / the previous electron
// instance, causing EPERM on rename during electron-builder's extraction step.
// Only run before the first attempt; on retry, keep the existing dist so
// electron-builder can skip re-packaging and only retry the publish step.
async function cleanDist(force) {
  const distDir = join(ROOT, 'dist');
  if (!force) return; // skip on retry
  try {
    await access(distDir, constants.F_OK);
    console.log('[electron-builder] Cleaning dist directory...');
    await rm(distDir, { recursive: true, force: true });
    console.log('[electron-builder] dist directory cleaned.');
  } catch {
    // dist doesn't exist — nothing to clean
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Compression level ──────────────────────────────────────────────────────
// `--compression-level N` (single digit 0-9) — parsed here, NOT forwarded to
// electron-builder (it doesn't know this flag; an unknown flag would make it
// fail). Also skipped when ELECTRON_BUILDER_COMPRESSION_LEVEL is already set in
// the environment (caller wins). Local default is 3 (fast iteration); CI
// keeps the yml's full compression (no override, smallest release artifacts).
const COMPRESSION_LEVEL_FLAG = '--compression-level';

function parseCompressionLevel(args) {
  const flagIndex = args.indexOf(COMPRESSION_LEVEL_FLAG);
  if (flagIndex === -1) return { forwardedArgs: args, level: null };

  const value = args[flagIndex + 1];
  if (!/^[0-9]$/.test(value ?? '')) {
    console.error(`[electron-builder] Invalid ${COMPRESSION_LEVEL_FLAG}: expected a single digit 0-9, got "${value ?? 'nothing'}".`);
    process.exit(1);
  }
  return {
    forwardedArgs: args.filter((_, i) => i !== flagIndex && i !== flagIndex + 1),
    level: value,
  };
}

function runElectronBuilder() {
  return new Promise((resolve, reject) => {
    // Pass through all CLI arguments to electron-builder.
    // Publishing only happens inside GitHub Actions (release.yml passes GH_TOKEN
    // and uploads installer assets to the GitHub Release). Local runs never
    // publish — releases are driven by GitHub Actions. An explicit --publish
    // argument passed by the caller always wins.
    const { forwardedArgs: userArgs, level: cliCompressionLevel } = parseCompressionLevel(process.argv.slice(2));
    const hasPublishArg = userArgs.some((a) => a.startsWith('--publish'));
    const args = hasPublishArg
      ? userArgs
      : ['--publish', IS_ACTIONS ? 'always' : 'never', ...userArgs];

    // Build the env with system CA support
    const env = { ...process.env };

    // Explicitly set ELECTRON_MIRROR so @electron/get uses the same download URL as
    // `npm install electron`, ensuring the cached zip is reused. Reading from
    // npm_config_electron_mirror (set by npm from .npmrc) avoids hardcoding the URL.
    // Falls back to npmmirror.com if neither is set, matching the project .npmrc.
    env.ELECTRON_MIRROR ??= env.npm_config_electron_mirror || 'https://npmmirror.com/mirrors/electron/';
    env.ELECTRON_BUILDER_BINARIES_MIRROR ??= env.npm_config_electron_builder_binaries_mirror || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

    // Compression level: CLI flag > pre-set env var > (CI: no override) > (local: 3).
    // Only the 7z archive step reads it; NSIS installer-level compression is unaffected.
    if (cliCompressionLevel != null) {
      env.ELECTRON_BUILDER_COMPRESSION_LEVEL = cliCompressionLevel;
    } else if (env.ELECTRON_BUILDER_COMPRESSION_LEVEL == null && !IS_ACTIONS) {
      env.ELECTRON_BUILDER_COMPRESSION_LEVEL = '3';
    }
    if (env.ELECTRON_BUILDER_COMPRESSION_LEVEL != null) {
      console.log(`[electron-builder] 7z compression level: ${env.ELECTRON_BUILDER_COMPRESSION_LEVEL} (ELECTRON_BUILDER_COMPRESSION_LEVEL)`);
    }

    // In GitHub Actions, use a project-local cache directory so it can be
    // cached between runs.
    // Locally, don't override ELECTRON_CACHE — electron-builder will use the system
    // default (e.g. %LOCALAPPDATA%/electron/Cache on Windows), which is already
    // populated by `npm install electron`. Overriding it to an empty project-local
    // directory causes electron-builder to re-download Electron every time.
    if (IS_ACTIONS) {
      env.ELECTRON_CACHE ??= join(ROOT, '.cache', 'electron');
      env.ELECTRON_BUILDER_CACHE ??= join(ROOT, '.cache', 'electron-builder');
    }

    // Add --use-system-ca and rename-retry patch to NODE_OPTIONS
    // --use-system-ca: makes Node.js use the OS CA certificate store,
    //   which includes any custom root CAs installed by corporate proxies.
    // --require rename-retry-patch: patches fs.rename to retry on EPERM,
    //   which happens on Windows when antivirus locks freshly extracted files.
    // Use forward slashes — NODE_OPTIONS parser strips backslashes on Windows
    const existingNodeOptions = env.NODE_OPTIONS ?? '';
    const renamePatchPath = join(ROOT, 'scripts', 'rename-retry-patch.cjs').replace(/\\/g, '/');
    const nodeOptionParts = [existingNodeOptions];
    if (!existingNodeOptions.includes('--use-system-ca')) {
      nodeOptionParts.push('--use-system-ca');
    }
    if (!existingNodeOptions.includes('rename-retry-patch')) {
      nodeOptionParts.push(`--require "${renamePatchPath}"`);
    }
    env.NODE_OPTIONS = nodeOptionParts.filter(Boolean).join(' ');

    console.log('[electron-builder] Using system CA certificates (--use-system-ca)');
    console.log('[electron-builder] NODE_OPTIONS:', env.NODE_OPTIONS);
    console.log('[electron-builder] ELECTRON_CACHE:', env.ELECTRON_CACHE);
    console.log('[electron-builder] ELECTRON_BUILDER_CACHE:', env.ELECTRON_BUILDER_CACHE);
    console.log('[electron-builder] ELECTRON_MIRROR:', env.ELECTRON_MIRROR);
    console.log('[electron-builder] ELECTRON_BUILDER_BINARIES_MIRROR:', env.ELECTRON_BUILDER_BINARIES_MIRROR);
    console.log('[electron-builder] Args:', args.join(' '));

    // Spawn electron-builder with the modified environment.
    // Resolve the JS entry directly to avoid spawning .cmd/.sh wrapper scripts.
    // This lets us pass args safely without shell:true, avoiding the Node.js
    // DEP0190 deprecation warning.
    const electronBuilderEntry = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

    const child = spawn(process.execPath, [electronBuilderEntry, ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    });

    child.on('error', (err) => {
      console.error('[electron-builder] Failed to start:', err.message);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[electron-builder] Process killed by signal: ${signal}`);
        reject(new Error(`Killed by signal: ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

// ─── Main: run with 503 retry ────────────────────────────────────────────────
// electron-builder calls the GitHub API to create a release and upload
// installer assets. If the API returns 503 (Service Unavailable), the entire
// process exits non-zero. On retry, we skip the dist cleanup so
// electron-builder detects existing build artifacts and only retries the
// publish step, making retries fast. Publishing (and thus this retry loop)
// only applies inside GitHub Actions.
let attempt = 0;

for (;;) {
  attempt++;
  const isFirstAttempt = attempt === 1;
  await cleanDist(isFirstAttempt);

  const code = await runElectronBuilder();

  if (code === 0) {
    process.exit(0);
  }

  // Outside Actions (local), don't retry — just exit with the error code.
  if (!IS_ACTIONS) {
    process.exit(code);
  }

  if (attempt >= MAX_RETRIES) {
    console.error(`[electron-builder] Failed after ${MAX_RETRIES} attempts (exit ${code}).`);
    process.exit(code);
  }

  const delay = BASE_DELAY_SEC * Math.pow(2, attempt - 1);
  console.warn(`[electron-builder] Attempt ${attempt}/${MAX_RETRIES} failed (exit ${code}), retrying in ${delay}s...`);
  await sleep(delay * 1000);
}
