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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Pass through all CLI arguments to electron-builder
const args = process.argv.slice(2);

// Build the env with system CA support
const env = { ...process.env };
env.ELECTRON_CACHE ??= join(ROOT, '.cache', 'electron');
env.ELECTRON_BUILDER_CACHE ??= join(ROOT, '.cache', 'electron-builder');

// Add --use-system-ca to NODE_OPTIONS if not already present
// This makes Node.js use the operating system's CA certificate store,
// which includes any custom root CAs installed by corporate proxies.
const existingNodeOptions = env.NODE_OPTIONS ?? '';
if (!existingNodeOptions.includes('--use-system-ca')) {
  env.NODE_OPTIONS = [existingNodeOptions, '--use-system-ca'].filter(Boolean).join(' ');
}

console.log('[electron-builder] Using system CA certificates (--use-system-ca)');
console.log('[electron-builder] NODE_OPTIONS:', env.NODE_OPTIONS);
console.log('[electron-builder] ELECTRON_CACHE:', env.ELECTRON_CACHE);
console.log('[electron-builder] ELECTRON_BUILDER_CACHE:', env.ELECTRON_BUILDER_CACHE);
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
