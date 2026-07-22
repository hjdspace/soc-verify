/**
 * Patch native module build files and runtime code.
 *
 * Patches applied:
 *   1. Spectre mitigation removal (Windows .gyp/.vcxproj)
 *   2. asar unpacked fallback (node-pty/lib/utils.js)
 *
 * Problem (Spectre):
 *   `node-pty` sets `SpectreMitigation: 'Spectre'` in its `.gyp` files.
 *   When `@electron/rebuild` regenerates `.vcxproj` files from `.gyp`,
 *   the resulting projects require "Spectre-mitigated libraries" from
 *   Visual Studio, which most developers don't have installed.
 *   This causes `MSB8040` build errors during `electron-builder` packaging.
 *
 * Problem (asar unpacked):
 *   When packaged in an Electron asar archive, node-pty's JS code runs from
 *   inside `app.asar/` but the native `.node` binary is unpacked to
 *   `app.asar.unpacked/`.  node-pty's `loadNativeModule()` uses relative
 *   `require()` paths (with a double-slash bug: `dir + "/" + name`), and
 *   Electron's asar integration fails to redirect these to the unpacked
 *   location, causing "Cannot find module" errors on Linux AppImage.
 *
 * Solution (asar unpacked):
 *   Patch `loadNativeModule()` to catch the require failure and retry from
 *   the `app.asar.unpacked/` filesystem path directly.
 *
 * This script is idempotent — safe to run multiple times.
 * It runs automatically on `npm install` (postinstall) and before
 * `electron-builder` (via the `package` scripts).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const NODE_PTY_DIR = join(ROOT, 'node_modules', 'node-pty');

// Files to patch: (relative path from node-pty dir, description)
const GYP_FILES = [
  { path: 'binding.gyp', desc: 'node-pty binding.gyp' },
  { path: join('deps', 'winpty', 'src', 'winpty.gyp'), desc: 'winpty.gyp' },
];

// ─── GYP patching ───────────────────────────────────────

/**
 * Remove `msvs_configuration_attributes` blocks that contain only
 * `SpectreMitigation` from a .gyp file's content.
 *
 * Matches blocks like:
 *   'msvs_configuration_attributes': {
 *     'SpectreMitigation': 'Spectre'
 *   },
 */
function patchGypContent(content) {
  let modified = content;

  // Pattern: match the entire msvs_configuration_attributes block that
  // contains SpectreMitigation, with optional trailing comma.
  // Handles varying indentation and whitespace.
  const pattern = /[ \t]*'msvs_configuration_attributes'[\s\S]*?'SpectreMitigation'[\s\S]*?\},?[ \t]*\n/g;

  modified = modified.replace(pattern, '');
  return modified;
}

function patchGypFile(filePath, desc) {
  if (!existsSync(filePath)) {
    console.warn(`[patch-native] SKIP: ${desc} not found at ${filePath}`);
    return false;
  }

  const original = readFileSync(filePath, 'utf-8');
  const patched = patchGypContent(original);

  if (original === patched) {
    console.log(`[patch-native] Already patched: ${desc}`);
    return false;
  }

  writeFileSync(filePath, patched, 'utf-8');
  console.log(`[patch-native] Patched: ${desc}`);
  return true;
}

// ─── vcxproj patching (for pre-generated files) ─────────

/**
 * Remove `<SpectreMitigation>Spectre</SpectreMitigation>` lines
 * from .vcxproj files in the build directory.
 */
function patchVcxprojFiles(buildDir) {
  if (!existsSync(buildDir)) return;

  const files = readdirSync(buildDir).filter((f) => f.endsWith('.vcxproj'));
  for (const file of files) {
    const filePath = join(buildDir, file);
    const original = readFileSync(filePath, 'utf-8');
    if (!original.includes('<SpectreMitigation>')) continue;

    const patched = original
      .replace(/[ \t]*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/g, '')
      .replace(/<SpectreMitigation>Spectre<\/SpectreMitigation>/g, '');

    if (original !== patched) {
      writeFileSync(filePath, patched, 'utf-8');
      console.log(`[patch-native] Patched: ${file}`);
    }
  }

  // Also check winpty build subdirectory
  const winptyBuildDir = join(buildDir, 'deps', 'winpty', 'src');
  if (existsSync(winptyBuildDir)) {
    const winptyFiles = readdirSync(winptyBuildDir).filter((f) => f.endsWith('.vcxproj'));
    for (const file of winptyFiles) {
      const filePath = join(winptyBuildDir, file);
      const original = readFileSync(filePath, 'utf-8');
      if (!original.includes('<SpectreMitigation>')) continue;

      const patched = original
        .replace(/[ \t]*<SpectreMitigation>Spectre<\/SpectreMitigation>\r?\n/g, '')
        .replace(/<SpectreMitigation>Spectre<\/SpectreMitigation>/g, '');

      if (original !== patched) {
        writeFileSync(filePath, patched, 'utf-8');
        console.log(`[patch-native] Patched: deps/winpty/src/${file}`);
      }
    }
  }
}

// ─── utils.js patching (asar unpacked fallback) ─────────

/**
 * Patch node-pty's `loadNativeModule()` in `lib/utils.js` to handle
 * Electron asar unpacked paths.
 *
 * When running inside an asar archive, `require()` for `.node` files fails
 * because the JS code is at `app.asar/node_modules/node-pty/lib/utils.js`
 * but the native binary is at `app.asar.unpacked/node_modules/node-pty/...`.
 * Electron's asar integration should redirect, but fails due to the
 * double-slash in the require path (`dir + "/" + name + ".node"`).
 *
 * The patch adds a fallback in the catch block: resolve the absolute path,
 * replace `app.asar` with `app.asar.unpacked`, and require from the real
 * filesystem path.
 */
function patchUtilsJs(utilsPath) {
  if (!existsSync(utilsPath)) {
    console.warn('[patch-native] SKIP: node-pty/lib/utils.js not found');
    return false;
  }

  const original = readFileSync(utilsPath, 'utf-8');

  // Check if already patched
  if (original.includes('socverify-patch')) {
    console.log('[patch-native] Already patched: node-pty/lib/utils.js');
    return false;
  }

  // The original catch block in loadNativeModule():
  //             catch (e) {
  //                 lastError = e;
  //             }
  const oldCatch =
    '            catch (e) {\n' +
    '                lastError = e;\n' +
    '            }';

  // Replacement: try asar unpacked path before falling through to lastError
  const newCatch =
    '            catch (e) {\n' +
    '                // [socverify-patch] asar unpacked fallback\n' +
    '                // When running inside an Electron asar archive, the native\n' +
    '                // .node binary is unpacked to app.asar.unpacked/ but require()\n' +
    '                // from inside the asar fails to find it. Resolve the absolute\n' +
    '                // path and try the unpacked location directly.\n' +
    '                try {\n' +
    '                    var _p = require("path");\n' +
    '                    var _fs = require("fs");\n' +
    '                    var _rp = _p.resolve(__dirname, dir + name + ".node");\n' +
    '                    var _up = _rp.replace("app.asar", "app.asar.unpacked").replace("node_modules.asar", "node_modules.asar.unpacked");\n' +
    '                    if (_up !== _rp && _fs.existsSync(_up)) {\n' +
    '                        return { dir: dir, module: require(_up) };\n' +
    '                    }\n' +
    '                } catch (_e2) { /* fall through to lastError */ }\n' +
    '                lastError = e;\n' +
    '            }';

  const patched = original.replace(oldCatch, newCatch);

  if (original === patched) {
    console.warn('[patch-native] Could not find catch block in utils.js — skipping');
    return false;
  }

  writeFileSync(utilsPath, patched, 'utf-8');
  console.log('[patch-native] Patched: node-pty/lib/utils.js (asar unpacked fallback)');
  return true;
}

// ─── Main ────────────────────────────────────────────────

console.log('[patch-native] Checking native module build files...');

if (!existsSync(NODE_PTY_DIR)) {
  console.log('[patch-native] node-pty not found — nothing to patch.');
  process.exit(0);
}

// 1. Patch .gyp source files (these are what @electron/rebuild reads)
let anyPatched = false;
for (const { path: relPath, desc } of GYP_FILES) {
  const fullPath = join(NODE_PTY_DIR, relPath);
  if (patchGypFile(fullPath, desc)) anyPatched = true;
}

// 2. Patch pre-existing .vcxproj files (in case they were already generated)
const buildDir = join(NODE_PTY_DIR, 'build');
patchVcxprojFiles(buildDir);

// 3. Patch utils.js for asar unpacked fallback (critical for Linux AppImage)
const utilsPath = join(NODE_PTY_DIR, 'lib', 'utils.js');
if (patchUtilsJs(utilsPath)) anyPatched = true;

if (anyPatched) {
  console.log('[patch-native] Done — patches applied.');
} else {
  console.log('[patch-native] Done — no changes needed.');
}
