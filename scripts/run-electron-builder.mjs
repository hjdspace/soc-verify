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
 */

import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, access, constants } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Pass through all CLI arguments to electron-builder.
// In CI, default to --publish always so electron-builder uploads installer
// assets to the GitHub Release using GH_TOKEN. Local runs remain publish-free.
const userArgs = process.argv.slice(2);
const args = (process.env.CI && !userArgs.some((a) => a.startsWith('--publish')))
  ? ['--publish', 'always', ...userArgs]
  : userArgs;

// ─── Pre-build cleanup ───────────────────────────────────────────────────────
// Remove the dist directory before building. On Windows, leftover files from a
// previous build can be locked by Explorer / antivirus / the previous electron
// instance, causing EPERM on rename during electron-builder's extraction step.
const distDir = join(ROOT, 'dist');
try {
  await access(distDir, constants.F_OK);
  console.log('[electron-builder] Cleaning dist directory...');
  await rm(distDir, { recursive: true, force: true });
  console.log('[electron-builder] dist directory cleaned.');
} catch {
  // dist doesn't exist — nothing to clean
}

// Build the env with system CA support
const env = { ...process.env };

// Explicitly set ELECTRON_MIRROR so @electron/get uses the same download URL as
// `npm install electron`, ensuring the cached zip is reused. Reading from
// npm_config_electron_mirror (set by npm from .npmrc) avoids hardcoding the URL.
// Falls back to npmmirror.com if neither is set, matching the project .npmrc.
env.ELECTRON_MIRROR ??= env.npm_config_electron_mirror || 'https://npmmirror.com/mirrors/electron/';
env.ELECTRON_BUILDER_BINARIES_MIRROR ??= env.npm_config_electron_builder_binaries_mirror || 'https://npmmirror.com/mirrors/electron-builder-binaries/';

// In CI, use a project-local cache directory so it can be cached between runs.
// Locally, don't override ELECTRON_CACHE — electron-builder will use the system
// default (e.g. %LOCALAPPDATA%/electron/Cache on Windows), which is already
// populated by `npm install electron`. Overriding it to an empty project-local
// directory causes electron-builder to re-download Electron every time.
if (process.env.CI) {
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

// For Windows, also set ELECTRON_BUILDER_ENABLE_ADDR_SIZE_MISMATCH=1 to avoid
// native module loading issues (not related but helps with overall packaging)

console.log('[electron-builder] Using system CA certificates (--use-system-ca)');
console.log('[electron-builder] NODE_OPTIONS:', env.NODE_OPTIONS);
console.log('[electron-builder] ELECTRON_CACHE:', env.ELECTRON_CACHE);
console.log('[electron-builder] ELECTRON_BUILDER_CACHE:', env.ELECTRON_BUILDER_CACHE);
console.log('[electron-builder] ELECTRON_MIRROR:', env.ELECTRON_MIRROR);
console.log('[electron-builder] ELECTRON_BUILDER_BINARIES_MIRROR:', env.ELECTRON_BUILDER_BINARIES_MIRROR);
console.log('[electron-builder] Args:', args.join(' '));

// Spawn electron-builder with the modified environment
const child = spawn('npx', ['electron-builder', ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  env,
  shell: true,
});

child.on('error', (err) => {
  console.error('[electron-builder] Failed to start:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[electron-builder] Process killed by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
