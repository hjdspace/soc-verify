/**
 * issue 10 — install the pi runner's production dependency payload.
 *
 * Installs resources/runner-deps with `npm ci --omit=dev --ignore-scripts`
 * so the published payload is exactly what the lockfile pins:
 *   - `npm ci`       → reproducible, lockfile-authoritative, wipes stale nodes
 *   - `--omit=dev`   → production payload only
 *   - `--ignore-scripts` → no lifecycle scripts from the engine payload
 *
 * After install, the payload is pruned to cut bytes that cannot affect the
 * runner at runtime (spec: platform-scoped payload discipline):
 *   - platform binaries  — keep only the target build platform. npm ci honours
 *                         the top-level lockfile's os/cpu filtering, but
 *                         @earendil-works/pi-coding-agent ships an
 *                         npm-shrinkwrap.json, so npm treats it as
 *                         self-contained and installs ALL its nested deps —
 *                         including every @esbuild/<platform> optional dep
 *                         (26 platforms, ~283 MB) and every
 *                         @mariozechner/clipboard-<platform> (~12 MB) —
 *                         bypassing os/cpu filtering. Only the target
 *                         platform's copy is reachable at runtime.
 *   - `*.map` (recursive) — source maps, debug-only
 *   - `recheck-jar/`    — recheck's JVM backend; on Node/Windows the auto
 *                         backend resolves `recheck-windows-x64/recheck.exe`
 *                         and falls back safely (resolve errors are caught,
 *                         missing jar → null → native/JS backend)
 *   - `docs/` `examples/` — non-runtime documentation shipped inside packages
 *   - Markdown files    — README/CHANGELOG (LICENSE/NOTICE kept for
 *                         license-compliance distribution requirements)
 *
 * The installed node_modules are shipped by electron-builder as
 * extraResources: `resources/runner-deps/node_modules` → `runner-pi/node_modules`,
 * where the runner's ESM resolution (and jiti) finds them.
 *
 * Usage:
 *   node scripts/prepare-runner-deps.mjs                       # install + prune (target = this machine)
 *   node scripts/prepare-runner-deps.mjs --prune-only         # prune an existing install
 *   node scripts/prepare-runner-deps.mjs --check              # verify install is present & complete
 *   node scripts/prepare-runner-deps.mjs --platform win32-x64 # target platform-arch override
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// RUNNER_DEPS_DIR: 测试注入 fixture 目录用（默认真实 runner-deps）
const DEPS_DIR = process.env.RUNNER_DEPS_DIR
  ? resolve(process.env.RUNNER_DEPS_DIR)
  : join(ROOT, 'resources', 'runner-deps');
const CHECK_ONLY = process.argv.includes('--check');
const PRUNE_ONLY = process.argv.includes('--prune-only');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/**
 * Target platform for platform-binary pruning, as a platform-arch pair
 * ("win32-x64" / "darwin-arm64" / "linux-x64"). Accepts a plain platform too
 * ("win32" keeps every arch of that OS). Defaults to the machine running the
 * pack — the same os+cpu pair npm itself filters the top-level tree by, so
 * local `npm run package` keeps working without arguments.
 */
function resolveTargetPlatform() {
  const raw = argValue('--platform');
  if (!raw) return `${process.platform}-${process.arch}`;
  return raw;
}

const TARGET_PLATFORM = resolveTargetPlatform();

function npmCommand() {
  // Windows needs npm.cmd; a bare `npm` there spawns the shell shim that
  // can mis-handle stdio inheritance in some environments.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function readManifestDeps() {
  const manifest = JSON.parse(readFileSync(join(DEPS_DIR, 'package.json'), 'utf-8'));
  return manifest.dependencies ?? {};
}

function verifyInstalled() {
  const deps = readManifestDeps();
  const missing = Object.keys(deps).filter(
    (dep) => !existsSync(join(DEPS_DIR, 'node_modules', dep, 'package.json')),
  );
  if (missing.length > 0) {
    throw new Error(`runner-deps incomplete — missing: ${missing.join(', ')}`);
  }
}

const PRUNED_DIRS = new Set(['recheck-jar', 'docs', 'examples']);
const LICENSE_FILE = /^(licen[sc]e|notice|unlicense|authors|contributors)/i;

/**
 * Scoped packages whose sub-directories are per-platform binary variants.
 *
 * These arrive unfiltered because pi-coding-agent ships an npm-shrinkwrap.json:
 * `npm ci` treats it as self-contained and installs every optional platform
 * dep inside its nested node_modules, bypassing the os/cpu filtering that
 * normally keeps only this machine's variant at the top level. Only the
 * target platform's variant is ever resolved at runtime.
 */
const PLATFORM_BINARY_SCOPES = [
  { scope: '@esbuild', prefix: '' },
  { scope: '@mariozechner', prefix: 'clipboard-' },
];

/**
 * OS prefixes of known platform-binary package names (esbuild, clipboard, …).
 * Only directories whose platform part starts with one of these are treated
 * as platform variants — anything unrecognised is kept (conservative: an
 * unknown platform costs disk, a wrongly-deleted package breaks the runner).
 */
const KNOWN_OS_PREFIXES = [
  'aix', 'android', 'darwin', 'freebsd', 'linux', 'netbsd', 'openbsd',
  'openharmony', 'sunos', 'win32',
];

/**
 * Does a platform-binary directory name (e.g. "win32-x64", "linux-arm64-gnu",
 * "darwin-universal") belong to the target build platform? A fat
 * ("universal"/"all") binary runs on either arch of its OS — keep it only
 * when that OS is the target.
 */
function isTargetPlatformDir(platformName) {
  if (/-universal$|-all$/.test(platformName)) {
    return platformName.startsWith(`${TARGET_PLATFORM.split('-')[0]}-`);
  }
  return platformName === TARGET_PLATFORM || platformName.startsWith(`${TARGET_PLATFORM}-`);
}

function isKnownPlatformName(platformName) {
  return KNOWN_OS_PREFIXES.some((os) => platformName === os || platformName.startsWith(`${os}-`));
}

function prunePlatformScope(scopeDir, rule, removeDir) {
  let entries;
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // e.g. the `clipboard` JS wrapper inside @mariozechner — not a platform dir
    if (rule.prefix && !name.startsWith(rule.prefix)) continue;
    const platformName = rule.prefix ? name.slice(rule.prefix.length) : name;
    if (!isKnownPlatformName(platformName)) continue;
    if (isTargetPlatformDir(platformName)) continue;
    removeDir(join(scopeDir, name));
  }
}
// 发布载荷里的 demo 媒体文件（pi-web-access 的宣传 banner + 演示视频，
// 约 6.4MB，运行时无用）——按包目录圈定，避免误伤其他包的同名资源。
const PRUNED_FILES_BY_PACKAGE = {
  'pi-web-access': new Set(['banner.png', 'pi-web-fetch-demo.mp4']),
};

function treeSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fp = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(fp);
      else {
        try {
          total += statSync(fp).size;
        } catch {
          /* raced file — ignore */
        }
      }
    }
  }
  return total;
}

/**
 * Recursively prune runtime-inert content from the installed node_modules.
 * Pruning is idempotent: a second pass removes nothing.
 */
function prunePayload() {
  const nmRoot = join(DEPS_DIR, 'node_modules');
  if (!existsSync(nmRoot)) return { files: 0, bytes: 0 };

  let files = 0;
  let bytes = 0;

  const removeDir = (dir) => {
    bytes += treeSize(dir);
    files += 1; // directory unit; per-file counting of nested trees is noise
    rmSync(dir, { recursive: true, force: true });
  };
  const removeFile = (fp) => {
    try {
      bytes += statSync(fp).size;
    } catch {
      /* ignore */
    }
    files += 1;
    rmSync(fp, { force: true });
  };

  const PLATFORM_RULE_BY_SCOPE = new Map(
    PLATFORM_BINARY_SCOPES.map((rule) => [rule.scope, rule]),
  );

  const walk = (dir, pkgName) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fp = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) {
          removeDir(fp);
          continue;
        }
        // 平台二进制 scope：按目标平台保留变体（win32 → win32-x64 等）
        const platformRule = PLATFORM_RULE_BY_SCOPE.get(entry.name);
        if (platformRule) {
          prunePlatformScope(fp, platformRule, removeDir);
        }
        // scoped 包目录：node_modules/<scope>/<pkg> 跳过 scope 层取包名
        const isScopeLayer = !pkgName && entry.name.startsWith('@');
        walk(fp, isScopeLayer ? undefined : (pkgName ?? entry.name));
        continue;
      }
      if (
        pkgName &&
        PRUNED_FILES_BY_PACKAGE[pkgName]?.has(entry.name)
      ) {
        removeFile(fp);
        continue;
      }
      if (entry.name.endsWith('.map')) {
        removeFile(fp);
        continue;
      }
      if (entry.name.endsWith('.md') && !LICENSE_FILE.test(entry.name)) {
        removeFile(fp);
      }
    }
  };

  walk(nmRoot);
  return { files, bytes };
}

function main() {
  if (!existsSync(join(DEPS_DIR, 'package-lock.json'))) {
    console.error('[prepare-runner-deps] package-lock.json missing — commit the lockfile.');
    process.exit(1);
  }

  if (CHECK_ONLY) {
    try {
      verifyInstalled();
      console.log('[prepare-runner-deps] runner-deps payload OK.');
      return;
    } catch (err) {
      console.error(`[prepare-runner-deps] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  if (!PRUNE_ONLY) {
    console.log(`[prepare-runner-deps] npm ci in ${DEPS_DIR}`);
    // Windows: spawning .cmd shims requires shell since Node's CVE-2024-27980
    // fix (EINVAL otherwise); args are static so string form avoids DEP0190.
    const useShell = process.platform === 'win32';
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    const result = useShell
      ? spawnSync(`${npmCommand()} ${npmArgs.join(' ')}`, {
          cwd: DEPS_DIR,
          stdio: 'inherit',
          shell: true,
        })
      : spawnSync(npmCommand(), npmArgs, { cwd: DEPS_DIR, stdio: 'inherit' });

    if (result.error) {
      console.error(`[prepare-runner-deps] failed to spawn npm: ${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`[prepare-runner-deps] npm ci exited with ${result.status}`);
      process.exit(result.status ?? 1);
    }
  }

  const pruned = prunePayload();
  console.log(
    `[prepare-runner-deps] pruned payload: ${pruned.files} paths, ${(pruned.bytes / 1024 / 1024).toFixed(1)} MB removed (target platform: ${TARGET_PLATFORM})`,
  );

  try {
    verifyInstalled();
  } catch (err) {
    console.error(`[prepare-runner-deps] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log('[prepare-runner-deps] runner payload dependencies installed.');
}

main();
