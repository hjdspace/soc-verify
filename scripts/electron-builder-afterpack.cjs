/**
 * electron-builder afterPack hook — prune runtime-unused native artifacts.
 *
 * Runs after files are copied/asared into context.appOutDir, before the
 * installer targets are produced. Everything removed here is provably never
 * loaded by the packaged app:
 *
 *   1. @napi-rs/canvas-*        — optional Node-side canvas backend of
 *                                 pdfjs-dist. The main process only extracts
 *                                 PDF text (lazy `require("@napi-rs/canvas")`
 *                                 wrapped in try/catch with a graceful warn),
 *                                 and page rendering happens in the renderer
 *                                 via the bundled browser worker.
 *   2. @rollup/rollup-*         — Rollup native accelerator binaries used by
 *                                 Vite at BUILD time only.
 *   3. lightningcss-*           — Tailwind v4 native CSS engine, BUILD time only.
 *                                 (@firecrawl/anydoc-* is NOT touched here —
 *                                 those are real runtime natives.)
 *   4. better-sqlite3/prebuilds — ships prebuilt bindings for every OS;
 *                                 keep only entries matching the TARGET
 *                                 platform (node-gyp-build picks by filename).
 *
 * NOTE: do NOT implement these as negative globs in electron-builder.yml
 * `files` — adding `!` patterns there disables electron-builder's default
 * ignores and pulls the entire repo (.cache/engine/docs/...) into the asar.
 * `.electron-builderignore` was also tried and is not honored by the
 * node_modules collector.
 */

const { join } = require('node:path');
const { existsSync, readdirSync, rmSync } = require('node:fs');

// Prebuilds whose name starts with one of these prefixes are kept.
// `linux` also matches `linuxmusl-*`. Same-OS other-arch builds are kept so a
// single yml serves both x64 and arm64 targets.
const OS_KEEP_PREFIXES = {
  win32: ['win32'],
  darwin: ['darwin'],
  linux: ['linux'],
};

function rmrf(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort — leftover file only costs disk space, never correctness
  }
}

module.exports = async function afterPack(context) {
  const nmDir = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  if (!existsSync(nmDir)) return;

  let freed = 0;

  // 1) Build-time-only / unused native packages (scoped dirs)
  for (const scoped of ['@napi-rs', '@rollup']) {
    const dir = join(nmDir, scoped);
    if (existsSync(dir)) {
      freed += 1;
      rmrf(dir);
    }
  }

  const entries = readdirSync(nmDir);
  for (const entry of entries) {
    // lightningcss-win32-x64-msvc / lightningcss-linux-x64-gnu / ...
    if (entry.startsWith('lightningcss-')) {
      freed += 1;
      rmrf(join(nmDir, entry));
    }
  }

  // 2) better-sqlite3 foreign-platform prebuilds
  const keepPrefixes = OS_KEEP_PREFIXES[context.electronPlatformName];
  const prebuildsDir = join(nmDir, 'better-sqlite3', 'prebuilds');
  if (keepPrefixes && existsSync(prebuildsDir)) {
    for (const entry of readdirSync(prebuildsDir)) {
      if (!keepPrefixes.some((prefix) => entry.startsWith(prefix))) {
        freed += 1;
        rmrf(join(prebuildsDir, entry));
      }
    }
  }

  console.log(`[afterPack] pruned ${freed} runtime-unused native artifact group(s)`);
};
