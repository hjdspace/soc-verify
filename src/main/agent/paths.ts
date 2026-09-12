import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** pi runner 脚本相对路径（普通 Node 脚本，ELECTRON_RUN_AS_NODE=1 运行） */
const PI_RUNNER_REL = 'runner-pi/index.ts';
/** pi 外部 session 扫描脚本相对路径（issue 08，一次性 CLI） */
const PI_SESSION_SCAN_REL = 'runner-pi/session-scan.ts';

function packagedResourcesDir(): string {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
}

/** 开发模式下内置扩展包目录（含 skills/ 和 agents/ 子目录） */
function devBuiltInExtensionDir(): string {
  // electron-vite output lives under out/main; source tests run from src/main/agent.
  const outputPath = resolve(__dirname, '../../resources/built-in-extension');
  if (existsSync(join(outputPath, 'skills'))) return outputPath;
  return resolve(__dirname, '../../../resources/built-in-extension');
}

/** 打包模式下内置扩展包目录 */
function packagedBuiltInExtensionDir(): string {
  return join(packagedResourcesDir(), 'built-in-extension');
}

/** 开发模式下 pi runner 脚本路径 */
function devPiRunnerScriptPath(): string {
  return resolve(__dirname, '../../', PI_RUNNER_REL);
}

/** 为给定基础名生成当前平台的候选可执行文件名（Windows 追加 .exe/.cmd 变体）。 */
export function candidateNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`, base, `${base}.cmd`] : [base];
}

/** 在指定目录中按候选名顺序查找第一个存在的可执行文件。 */
export function findInDir(dir: string, base: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of candidateNames(base)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 在系统 PATH 中查找可执行文件（Windows 用 where，Unix 用 which）。 */
export function findInPath(executable: string): string | null {
  const all = findAllInPath(executable);
  return all.length > 0 ? all[0] : null;
}

/**
 * 在系统 PATH 中查找可执行文件的所有匹配路径（Windows 用 where，Unix 用 which）。
 *
 * 与 `findInPath` 不同，此函数返回所有匹配路径而非仅第一个。
 * 这对于 Windows 上存在多个同名可执行文件（如 Windows Store 的
 * `python3.exe` stub 和真实安装的 `python.exe`）的场景特别有用，
 * 调用方可以过滤掉无效的 stub 路径。
 */
export function findAllInPath(executable: string): string[] {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [executable], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 解析 pi runner 脚本路径（普通 Node 脚本，由 PiAgentClient 以
 * ELECTRON_RUN_AS_NODE=1 复用 Electron 内置 Node 运行，不依赖 Bun）。
 * 优先级：packaged resources → 仓库内 runner-pi/。
 */
export function resolvePiRunnerScript(): string | null {
  // 生产模式：packaged resources/runner-pi/index.ts（extraResources 分发）
  const packaged = join(packagedResourcesDir(), PI_RUNNER_REL);
  if (existsSync(packaged)) return packaged;

  // 开发模式：仓库内 runner-pi/index.ts
  const dev = devPiRunnerScriptPath();
  if (existsSync(dev)) return dev;

  return null;
}

/**
 * 解析 pi 外部 session 扫描脚本路径（issue 08，一次性 CLI，与 runner-pi
 * 同目录分发）。优先级与 resolvePiRunnerScript 一致。
 */
export function resolvePiSessionScanScript(): string | null {
  const packaged = join(packagedResourcesDir(), PI_SESSION_SCAN_REL);
  if (existsSync(packaged)) return packaged;

  const dev = resolve(__dirname, '../../', PI_SESSION_SCAN_REL);
  if (existsSync(dev)) return dev;

  return null;
}

/**
 * 解析内置扩展包目录路径（包含 skills/ 和 agents/ 子目录）。
 *
 * 用于注入 SoC Verify 自带的 skill 和 agent，随应用打包分发。
 * 优先级：打包目录 → 开发目录
 */
export function resolveBuiltInExtensionDir(): string | null {
  // 生产模式：packaged resources/built-in-extension
  const packaged = packagedBuiltInExtensionDir();
  if (existsSync(join(packaged, 'skills'))) return packaged;

  // 开发模式：项目内 resources/built-in-extension
  const dev = devBuiltInExtensionDir();
  if (existsSync(join(dev, 'skills'))) return dev;

  return null;
}
