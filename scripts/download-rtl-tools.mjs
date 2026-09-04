#!/usr/bin/env node
/**
 * Download / extract the three RTL tool binaries used by Design View
 * (yosys, slang-server, verible) into resources/binaries/.
 *
 * Usage:
 *   node scripts/download-rtl-tools.mjs                       # 按当前平台 + package.json 锁定版本
 *   node scripts/download-rtl-tools.mjs --force               # 强制重新提取（缓存归档复用）
 *   node scripts/download-rtl-tools.mjs --only yosys          # 只处理某个工具（yosys|slang|verible）
 *   node scripts/download-rtl-tools.mjs --mirror <base>       # 给所有 GitHub URL 加代理前缀（ghproxy 风格）
 *   node scripts/download-rtl-tools.mjs --yosys-url <url>     # 单独覆盖某个来源的下载 URL
 *   node scripts/download-rtl-tools.mjs --slang-url <url>
 *   node scripts/download-rtl-tools.mjs --verible-url <url>
 *
 * 三个来源 × 两个平台（版本锁定见 package.json；按 process.platform 选资产）：
 *   - yosys:        OSS CAD Suite tgz（~568MB），选择性提取（非全量解压）
 *                   Windows: oss-cad-suite-windows-x64-<date>.tgz → yosys.exe + share/yosys + 8 DLL（≈70MB）
 *                   Linux:   oss-cad-suite-linux-x64-<date>.tgz  → bin/yosys + share/yosys（ELF 链接系统库，无 DLL 集）
 *   - slang-server: hudson-trading/slang-server Releases
 *                   Windows: slang-server-windows-x64.zip / Linux: slang-server-linux-x64.tar.gz（单 ELF）
 *   - verible:      chipsalliance/verible Releases
 *                   Windows: verible-<tag>-win64.zip / Linux: verible-<tag>-linux-static-x86_64.tar.gz（静态链接零依赖）
 *
 * 产物布局（参与 electron-builder extraResources 打包；两平台同布局，仅文件名/附加物不同）：
 *   resources/binaries/yosys/{yosys[.exe], share/yosys/**, (win) *.dll}
 *     ← Windows: 8 个 DLL 必须与 yosys.exe 同目录（S0 实测：PATH 不生效）
 *     ← Linux:   yosys 链接系统库（需 libtinfo/libffi/libz，OSS CAD Suite 官方要求），无同目录布局问题
 *   resources/binaries/slang-server/slang-server[.exe]
 *   resources/binaries/verible/verible-verilog-{lint,format}[.exe]
 *
 * macOS 不在分发范围（桌面应用目标为 Windows 工作站 + Linux 服务器/桌面），脚本在非 win/linux 平台跳过。
 *
 * 幂等：目标产物已存在则跳过下载（除非 --force）。
 * 离线放置：把归档（tgz / tar.gz / zip）预先放到 .cache/rtl-tools/ 下（文件名与 GitHub 资产名一致），
 *           脚本会跳过下载直接提取。
 * 下载失败：不阻断构建，仅打印警告（运行时由 src/main/rtl/binary.ts 降级处理）。
 *
 * 版本升级验证点（改 package.json 三个版本字段后必查）：
 *   1. read_slang 帮助中 `--keep-hierarchy` 仍存在（yosys ≥0.67 硬性要求）：yosys -p "help read_slang"
 *   2. Windows: yosys.exe 的 DLL 依赖集不变（当前 8 个，见 YOSYS_DLLS）
 *   3. Linux:   yosys 可执行（`ldd` 无 not found）+ slang-server/verible 资产名不变
 */

import { existsSync, mkdirSync, createWriteStream, renameSync, statSync, readFileSync, rmSync, copyFileSync, cpSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import './tls-self-heal.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
let BINARIES_DIR = join(REPO_ROOT, 'resources', 'binaries');
// 归档缓存目录（.gitignore 已忽略 .cache/），离线放置与避免重复下载 568MB 都走这里
const CACHE_DIR = join(REPO_ROOT, '.cache', 'rtl-tools');
const USER_AGENT = 'SoCVerify-RTLTools-Downloader';

// ===== 版本锁定（package.json）=====

function readVersions() {
  const fallback = { ossCadSuite: '', slang: '', verible: '' };
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    return {
      ossCadSuite: typeof pkg.ossCadSuiteVersion === 'string' ? pkg.ossCadSuiteVersion : '',
      slang: typeof pkg.slangServerVersion === 'string' ? pkg.slangServerVersion : '',
      verible: typeof pkg.veribleVersion === 'string' ? pkg.veribleVersion : '',
    };
  } catch {
    return fallback;
  }
}

// ===== 平台 =====

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
/** 可执行文件扩展名（Linux 为空） */
const EXE = IS_WINDOWS ? '.exe' : '';

// ===== yosys 依赖 DLL 集（Windows S0 实测，必须与 exe 同目录；Linux 无此问题）=====

const YOSYS_DLLS = [
  'libstdc++-6.dll',
  'libgcc_s_seh-1.dll',
  'libwinpthread-1.dll',
  'libffi-8.dll',
  'libreadline8.dll',
  'libtermcap-0.dll',
  'tcl86.dll',
  'zlib1.dll',
];

// ===== 下载 URL 构造（支持镜像 / 单独覆盖）=====

/** 给 GitHub 下载 URL 套代理前缀（ghproxy 风格：https://mirror/https://github.com/...） */
function applyMirror(url, mirror) {
  if (!mirror) return url;
  const base = mirror.endsWith('/') ? mirror.slice(0, -1) : mirror;
  return `${base}/${url}`;
}

// ===== 通用下载 =====

async function downloadFile(url, destPath) {
  console.log(`  downloading: ${url}`);
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const total = resp.headers.get('content-length');
  if (total) {
    console.log(`  size: ${(parseInt(total) / 1024 / 1024).toFixed(1)} MB`);
  }
  const tmpPath = destPath + '.tmp';
  mkdirSync(dirname(destPath), { recursive: true });
  const out = createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(resp.body), out);
  renameSync(tmpPath, destPath);
  console.log(`  saved: ${destPath}`);
}

/** 若缓存归档不存在则下载；返回归档路径。已存在（含离线手动放置）则跳过。 */
async function ensureArchive(fileName, url) {
  const cached = join(CACHE_DIR, fileName);
  if (existsSync(cached) && statSync(cached).size > 0) {
    console.log(`  archive cached: ${cached} (${(statSync(cached).size / 1024 / 1024).toFixed(1)} MB)`);
    return cached;
  }
  if (!url) {
    throw new Error(`archive not cached and no download URL available`);
  }
  await downloadFile(url, cached);
  return cached;
}

// ===== 校验产物可执行 =====

function verifyVersion(exePath, args, label) {
  try {
    const result = spawnSync(exePath, args, { timeout: 10_000, encoding: 'utf-8', windowsHide: true });
    const out = (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
    if (result.status === 0) {
      console.log(`  [${label}] OK: ${out}`);
      return true;
    }
    console.warn(`  [${label}] version check failed (exit ${result.status}): ${out}`);
    return false;
  } catch (err) {
    console.warn(`  [${label}] version check error: ${err.message}`);
    return false;
  }
}

function makeExecutable(p) {
  if (!IS_WINDOWS) {
    try {
      chmodSync(p, 0o755);
    } catch {
      /* ignore */
    }
  }
}

// ===== yosys：从 OSS CAD Suite tgz 选择性提取 =====

/** 目标 yosys 目录是否已完整就位（幂等跳过判定） */
function yosysComplete(yosysDir) {
  const exe = join(yosysDir, `yosys${EXE}`);
  if (!existsSync(exe)) return false;
  if (!existsSync(join(yosysDir, 'share', 'yosys'))) return false;
  // DLL 集仅 Windows 需要（Linux yosys 链接系统库）
  if (!IS_WINDOWS) return true;
  return YOSYS_DLLS.every((d) => existsSync(join(yosysDir, d)));
}

async function extractYosys(archivePath, yosysDir) {
  const { x: tarExtract } = await import('tar');
  const staging = join(CACHE_DIR, `_yosys_staging_${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    // 只提取需要的成员，避免解压整个 568MB 包。tgz 成员前缀为 oss-cad-suite/（两平台一致）
    const wantedDlls = new Set(YOSYS_DLLS.map((d) => `oss-cad-suite/lib/${d}`));
    const filter = (path) =>
      path === `oss-cad-suite/bin/yosys${EXE}` ||
      (IS_WINDOWS && wantedDlls.has(path)) ||
      path.startsWith('oss-cad-suite/share/yosys/');

    console.log(`  extracting yosys subset from tgz...`);
    await tarExtract({ file: archivePath, cwd: staging, filter });

    const suite = join(staging, 'oss-cad-suite');
    mkdirSync(yosysDir, { recursive: true });

    // exe
    const exeDest = join(yosysDir, `yosys${EXE}`);
    copyFileSync(join(suite, 'bin', `yosys${EXE}`), exeDest);
    makeExecutable(exeDest);

    // Windows: 8 个 DLL → 与 exe 同目录（S0 实测 PATH 不生效）；Linux: 无 DLL 集
    if (IS_WINDOWS) {
      for (const dll of YOSYS_DLLS) {
        const src = join(suite, 'lib', dll);
        if (existsSync(src)) {
          copyFileSync(src, join(yosysDir, dll));
        } else {
          console.warn(`  [yosys] expected DLL missing in tgz: ${dll}`);
        }
      }
    }

    // share/yosys 树（含 plugins/，两平台都需要）
    const shareSrc = join(suite, 'share', 'yosys');
    if (existsSync(shareSrc)) {
      cpSync(shareSrc, join(yosysDir, 'share', 'yosys'), { recursive: true });
    } else {
      console.warn(`  [yosys] share/yosys not found in tgz`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ===== zip 提取（Windows：slang-server / verible）=====

async function extractZipEntries(archivePath, wanted, destDir) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(readFileSync(archivePath));
  mkdirSync(destDir, { recursive: true });
  for (const { match, outName } of wanted) {
    // verible zip 内成员带目录前缀 verible-<tag>-win64/xxx.exe，用后缀匹配定位
    const entry = Object.keys(zip.files).find((name) => !zip.files[name].dir && name.endsWith(match));
    if (!entry) {
      console.warn(`  zip entry not found for: ${match}`);
      continue;
    }
    const data = await zip.files[entry].async('nodebuffer');
    const outPath = join(destDir, outName);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
    makeExecutable(outPath);
  }
}

// ===== tar.gz 提取（Linux：slang-server / verible）=====

/** 递归找第一个路径以 suffix 结尾的文件（归档成员带目录前缀，用 basename 定位） */
function walkFind(root, suffix) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      const found = walkFind(p, suffix);
      if (found) return found;
    } else if (p.replace(/\\/g, '/').endsWith(suffix)) {
      return p;
    }
  }
  return null;
}

async function extractTarEntries(archivePath, wanted, destDir) {
  const { x: tarExtract } = await import('tar');
  const staging = join(CACHE_DIR, `_staging_${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    const matches = wanted.map((w) => w.match);
    await tarExtract({ file: archivePath, cwd: staging, filter: (path) => matches.some((m) => path.endsWith(m)) });
    mkdirSync(destDir, { recursive: true });
    for (const { match, outName } of wanted) {
      const src = walkFind(staging, match);
      if (!src) {
        console.warn(`  tar entry not found for: ${match}`);
        continue;
      }
      const outPath = join(destDir, outName);
      copyFileSync(src, outPath);
      makeExecutable(outPath);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ===== 三个工具的处理流程 =====

async function handleYosys(opts) {
  const yosysDir = join(BINARIES_DIR, 'yosys');
  const yosysExe = join(yosysDir, `yosys${EXE}`);
  if (!opts.force && yosysComplete(yosysDir)) {
    console.log(`[yosys] already in place: ${yosysDir} (use --force to re-extract)`);
    verifyVersion(yosysExe, ['-V'], 'yosys');
    return;
  }
  const tag = opts.versions.ossCadSuite;
  if (!tag) {
    console.warn(`[yosys] ossCadSuiteVersion not set in package.json; skipping`);
    return;
  }
  // release 日期 2026-09-02 → 归档文件名日期 20260902
  const dateCompact = tag.replace(/-/g, '');
  const platformSlug = IS_WINDOWS ? 'windows' : 'linux';
  const assetName = `oss-cad-suite-${platformSlug}-x64-${dateCompact}.tgz`;
  const ghUrl = `https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${tag}/${assetName}`;
  const url = opts.yosysUrl || applyMirror(ghUrl, opts.mirror);
  console.log(`[yosys] OSS CAD Suite ${tag} (${platformSlug}-x64)`);
  const archive = await ensureArchive(assetName, url);
  await extractYosys(archive, yosysDir);
  verifyVersion(yosysExe, ['-V'], 'yosys');
}

async function handleSlang(opts) {
  const dir = join(BINARIES_DIR, 'slang-server');
  const exe = join(dir, `slang-server${EXE}`);
  if (!opts.force && existsSync(exe) && statSync(exe).size > 0) {
    console.log(`[slang-server] already in place: ${exe} (use --force to re-extract)`);
    verifyVersion(exe, ['--version'], 'slang-server');
    return;
  }
  const tag = opts.versions.slang;
  if (!tag) {
    console.warn(`[slang-server] slangServerVersion not set in package.json; skipping`);
    return;
  }
  const assetName = IS_WINDOWS ? 'slang-server-windows-x64.zip' : 'slang-server-linux-x64.tar.gz';
  const ghUrl = `https://github.com/hudson-trading/slang-server/releases/download/${tag}/${assetName}`;
  const url = opts.slangUrl || applyMirror(ghUrl, opts.mirror);
  console.log(`[slang-server] ${tag}`);
  const archive = await ensureArchive(assetName, url);
  const wanted = [{ match: `slang-server${EXE}`, outName: `slang-server${EXE}` }];
  if (IS_WINDOWS) {
    await extractZipEntries(archive, wanted, dir);
  } else {
    // Linux tar.gz 成员为扁平 ./slang-server
    await extractTarEntries(archive, [{ match: 'slang-server', outName: 'slang-server' }], dir);
  }
  verifyVersion(exe, ['--version'], 'slang-server');
}

async function handleVerible(opts) {
  const dir = join(BINARIES_DIR, 'verible');
  const lint = join(dir, `verible-verilog-lint${EXE}`);
  const format = join(dir, `verible-verilog-format${EXE}`);
  if (!opts.force && existsSync(lint) && existsSync(format)) {
    console.log(`[verible] already in place: ${dir} (use --force to re-extract)`);
    verifyVersion(lint, ['--version'], 'verible-lint');
    return;
  }
  const tag = opts.versions.verible;
  if (!tag) {
    console.warn(`[verible] veribleVersion not set in package.json; skipping`);
    return;
  }
  const assetName = IS_WINDOWS ? `verible-${tag}-win64.zip` : `verible-${tag}-linux-static-x86_64.tar.gz`;
  const ghUrl = `https://github.com/chipsalliance/verible/releases/download/${tag}/${assetName}`;
  const url = opts.veribleUrl || applyMirror(ghUrl, opts.mirror);
  console.log(`[verible] ${tag}`);
  const archive = await ensureArchive(assetName, url);
  const wanted = [
    { match: 'verible-verilog-lint', outName: `verible-verilog-lint${EXE}` },
    { match: 'verible-verilog-format', outName: `verible-verilog-format${EXE}` },
  ];
  if (IS_WINDOWS) {
    await extractZipEntries(
      archive,
      wanted.map((w) => ({ ...w, match: `${w.match}${EXE}` })),
      dir,
    );
  } else {
    // Linux tar.gz 成员带目录前缀 verible-<tag>/bin/xxx（静态链接，零依赖）
    await extractTarEntries(
      archive,
      wanted.map((w) => ({ ...w, match: `bin/${w.match}` })),
      dir,
    );
  }
  verifyVersion(lint, ['--version'], 'verible-lint');
  verifyVersion(format, ['--version'], 'verible-format');
}

// ===== Main =====

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  return {
    force: args.includes('--force'),
    only: get('--only'),
    binariesDir: get('--binaries-dir'),
    mirror: get('--mirror') || process.env.RTL_TOOLS_MIRROR || '',
    yosysUrl: get('--yosys-url') || process.env.RTL_TOOLS_YOSYS_URL || '',
    slangUrl: get('--slang-url') || process.env.RTL_TOOLS_SLANG_URL || '',
    veribleUrl: get('--verible-url') || process.env.RTL_TOOLS_VERIBLE_URL || '',
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  opts.versions = readVersions();
  if (opts.binariesDir) {
    BINARIES_DIR = resolve(opts.binariesDir);
  }

  mkdirSync(BINARIES_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  if (!IS_WINDOWS && !IS_LINUX) {
    // 分发目标为 Windows 与 Linux（SoC 验证主战场是 Linux）；macOS 不在范围。
    console.log(`[rtl-tools] distribution targets Windows and Linux; skipping on ${process.platform}.`);
    return;
  }

  const tasks = [
    { key: 'yosys', fn: handleYosys },
    { key: 'slang', fn: handleSlang },
    { key: 'verible', fn: handleVerible },
  ];

  let anyFailed = false;
  for (const task of tasks) {
    if (opts.only && opts.only !== task.key) continue;
    console.log(`\n=== ${task.key} ===`);
    try {
      await task.fn(opts);
    } catch (err) {
      anyFailed = true;
      console.error(`[${task.key}] FAILED: ${err.message}`);
      console.warn(`[${task.key}] build continues without it; runtime will degrade (see src/main/rtl/binary.ts).`);
      console.warn(`[${task.key}] offline: place the archive in ${CACHE_DIR} and re-run, or pass a mirror/--${task.key}-url.`);
    }
  }

  console.log(`\n[rtl-tools] done${anyFailed ? ' (with warnings — see above)' : ''}.`);
}

main().catch((err) => {
  console.error(`[rtl-tools] fatal: ${err.message}`);
  console.warn(`[rtl-tools] build continues without RTL tools.`);
});
