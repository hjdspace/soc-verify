/**
 * Patch native module build files to remove Spectre mitigation requirements.
 *
 * Problem:
 *   `node-pty` sets `SpectreMitigation: 'Spectre'` in its `.gyp` files.
 *   When `@electron/rebuild` regenerates `.vcxproj` files from `.gyp`,
 *   the resulting projects require "Spectre-mitigated libraries" from
 *   Visual Studio, which most developers don't have installed.
 *   This causes `MSB8040` build errors during `electron-builder` packaging.
 *
 * Solution:
 *   Remove the `msvs_configuration_attributes` blocks (which only contain
 *   the `SpectreMitigation` setting) from the `.gyp` source files.
 *   Also patch any pre-existing `.vcxproj` files for good measure.
 *
 * This script is idempotent — safe to run multiple times.
 * It runs automatically before `electron-builder` via the `package` scripts.
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

if (anyPatched) {
  console.log('[patch-native] Done — Spectre mitigation requirement removed.');
} else {
  console.log('[patch-native] Done — no changes needed.');
}
