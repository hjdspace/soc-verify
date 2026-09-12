/**
 * Postinstall / pre-package script: verifies the pi runner payload is present.
 *
 * The AI engine runtime is no longer a compiled binary (no Bun, no native
 * addon). It is the plain Node runner in `runner-pi/` plus a small set of
 * production dependencies shipped via extraResources (see
 * scripts/prepare-runner-deps.mjs and electron-builder.yml).
 *
 * What this script checks:
 *   1. runner-pi entrypoint exists        (runner-pi/index.ts)
 *   2. runner production dependencies are installed
 *      (@earendil-works/pi-coding-agent, jiti)
 *
 * Modes:
 *   - `npm run setup:agent`          → warn only (dev convenience)
 *   - `setup-agent.mjs --require-runner` (package chain) → hard-fail on
 *     any missing piece, packaging must not proceed with a broken payload.
 */

import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const REQUIRE_RUNNER = process.argv.includes('--require-runner');

// runner-pi runtime external dependencies (kept in sync with
// runner-pi/*.ts imports and package.json "dependencies").
const RUNNER_DEPS = [
  '@earendil-works/pi-coding-agent',
  'jiti',
];

function fail(msg) {
  if (REQUIRE_RUNNER) {
    console.error(`[setup-agent] ${msg}`);
    console.error('[setup-agent] Refusing to package an incomplete engine payload.');
    process.exit(1);
  }
  console.warn(`[setup-agent] ${msg}`);
}

function main() {
  console.log('[setup-agent] Verifying pi runner payload...');

  // 1. Runner entrypoint
  const entry = join(ROOT, 'runner-pi', 'index.ts');
  if (!existsSync(entry)) {
    fail('runner-pi/index.ts not found — the pi runner entrypoint is missing.');
    return;
  }

  // 2. Runner production dependencies
  const missing = RUNNER_DEPS.filter((dep) => !existsSync(join(ROOT, 'node_modules', dep, 'package.json')));
  if (missing.length > 0) {
    fail(`runner dependencies missing from node_modules: ${missing.join(', ')}`);
    return;
  }

  console.log('[setup-agent] pi runner payload OK (runner-pi/index.ts + runtime deps).');
}

main();
