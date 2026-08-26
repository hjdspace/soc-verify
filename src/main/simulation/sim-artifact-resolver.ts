/**
 * SimArtifactResolver — 仿真产物（用例目录 / 日志 / 反汇编 / 波形）解析模块。
 *
 * 移植 Python runsim_r3p0 的产物路径解析逻辑：
 * - `config_controller.py get_seed()` 三级优先级（rundir → CASE → work 搜索）
 * - `utils/path_resolver.py get_log_file_path()` / `find_asm_files()`
 * - `execution_controller.py open_verdi()` 的 VCS/XRUN 检测
 *
 * 关键概念（与 Python GUI 的差异）：
 * 基准目录不是 cwd（验证环境项目目录），而是仿真执行目录：
 *   1. 命令中的 `cd "<dir>" &&` 前缀（runInTerminal 构建命令时嵌入 $PROJ_WORK）
 *   2. $PROJ_WORK 环境变量
 *   3. cwd（向后兼容）
 *
 * 用例目录候选（有序）：
 *   1. <base>/<rundir>、<base>/work/<rundir>（-rundir，支持 {case_name} 占位符）
 *   2. <base>/<case>、<base>/work/<case>（-case 默认产物路径）
 *   3. work 目录模糊搜索：<base>/work 与 <base> 下名字含 case 的目录，按日志 mtime 降序
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SimArtifactInput {
  /** runsim 命令（终端运行含 `cd "$PROJ_WORK" &&` 前缀；含 -rundir/-case 选项） */
  command?: string;
  /** 回退基准目录（验证环境项目目录，非仿真执行目录） */
  cwd?: string;
  /** 用例名（缺省时从命令 -case 解析） */
  caseName?: string;
}

export interface SimArtifacts {
  /** 主用例目录（第一个含仿真产物的候选目录） */
  caseDir: string | null;
  /** Simulation Log Path（<caseDir>/log/irun_sim.log 等，按优先级回退） */
  simLogPath: string | null;
  /** Compile Log Path（<caseDir>/log/irun_compile.log 等） */
  compileLogPath: string | null;
  /** 反汇编文件（*_sw_build 目录下的 .asm） */
  asmFiles: string[];
  /** Verdi 启动模式：vcs（simv.daidir/vcdplus.vpd 存在）或 xrun；无用例目录时为 null */
  verdiMode: 'vcs' | 'xrun' | null;
  /** 全部匹配的用例目录（有序，供多候选选择） */
  matchedCaseDirs: string[];
}

// ─── 常量 ──────────────────────────────────────────────────

/** 仿真日志文件名（Xcelium / VCS / 通用），按优先级排列 */
const SIM_LOG_NAMES: readonly string[] = [
  'irun_sim.log',
  'vcs_sim.log',
  'sim.log',
  'simulation.log',
  'ncsim_sim.log',
];

/** 编译日志文件名，按优先级排列 */
const COMPILE_LOG_NAMES: readonly string[] = [
  'irun_compile.log',
  'irun_comp.log',
  'compile.log',
  'vcs_comp.log',
  'ncsim_comp.log',
];

/** 目录遍历最大深度（防御符号链接环） */
const MAX_WALK_DEPTH = 8;

// ─── 命令解析 ───────────────────────────────────────────────

/**
 * 解析命令开头的 `cd "<dir>" &&` 前缀，返回目录路径。
 *
 * runInTerminal / rerunWithCommand 构建命令时会把 $PROJ_WORK 以该形式嵌入，
 * 因此它是仿真执行目录最可靠的来源。
 */
export function parseExecDirFromCommand(command?: string): string | null {
  if (!command) return null;
  const m = command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&]+))\s*&&/);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** 解析命令选项值：`-rundir <value>` / `-case <value>` 等 */
export function parseCommandOption(command: string, name: string): string | null {
  const parts = command.split(/\s+/).filter((p) => p.length > 0);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === `-${name}` && !parts[i + 1].startsWith('-')) {
      return parts[i + 1];
    }
  }
  return null;
}

/**
 * 解析仿真执行目录（日志查找的基准目录）。
 *
 * 优先级：命令 cd 前缀 → $PROJ_WORK → cwd → process.cwd()。
 */
export function resolveSimBaseDir(input: SimArtifactInput): string {
  const fromCommand = parseExecDirFromCommand(input.command);
  if (fromCommand) return fromCommand;
  const projWork = process.env.PROJ_WORK?.trim();
  if (projWork) return projWork;
  return input.cwd ?? process.cwd();
}

// ─── 产物解析 ───────────────────────────────────────────────

/** 判断目录是否像一个仿真用例产物目录（移植 Python get_case_directories） */
function isCaseDir(dir: string): boolean {
  return (
    existsSync(join(dir, 'log')) ||
    existsSync(join(dir, 'INCA_libs')) ||
    existsSync(join(dir, 'simv.daidir')) ||
    existsSync(join(dir, 'vcdplus.vpd'))
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 在用例目录中按优先级查找日志文件（log/ 子目录优先，其次顶层） */
function findLogFile(caseDir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const p = join(caseDir, 'log', name);
    if (existsSync(p)) return p;
  }
  for (const name of names) {
    const p = join(caseDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 目录 mtime（搜索排序兜底） */
function dirMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 在 <base>/work 与 <base> 下模糊搜索用例目录（移植 Python
 * _get_seed_from_work_directory）：目录名包含 case 名（大小写不敏感）、
 * 且为仿真产物目录；按其中最新仿真日志的 mtime 降序排列。
 */
function searchCaseDirs(base: string, caseName: string): string[] {
  if (!caseName) return [];
  const results: Array<{ dir: string; mtime: number }> = [];
  const lower = caseName.toLowerCase();

  for (const root of [join(base, 'work'), base]) {
    if (!isDirectory(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().includes(lower)) continue;
      const dir = join(root, entry);
      if (!isDirectory(dir) || !isCaseDir(dir)) continue;
      const simLog = findLogFile(dir, SIM_LOG_NAMES);
      const mtime = simLog ? dirMtime(simLog) : dirMtime(dir);
      results.push({ dir, mtime });
    }
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results.map((r) => r.dir);
}

/**
 * 查找用例目录下的反汇编文件（移植 Python find_asm_files）：
 * 递归查找 *_sw_build 目录，收集其中所有 .asm 文件。
 */
export function findAsmFiles(caseDir: string): string[] {
  const results: string[] = [];

  const collectAsmDir = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) collectAsmDir(p);
      else if (entry.endsWith('.asm')) results.push(p);
    }
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      if (!isDirectory(p)) continue;
      if (entry.endsWith('_sw_build')) collectAsmDir(p);
      else walk(p, depth + 1);
    }
  };

  walk(caseDir, 0);
  return results;
}

/**
 * 解析一次仿真运行的全部产物路径。
 *
 * 候选目录按优先级排序后，逐类产物取第一个命中：
 * rundir 直接路径 → rundir work 路径 → case 直接路径 → case work 路径 → 搜索匹配。
 */
export function resolveSimArtifacts(input: SimArtifactInput): SimArtifacts {
  const base = resolveSimBaseDir(input);
  const command = input.command ?? '';
  const caseName =
    (input.caseName ?? '').trim() || parseCommandOption(command, 'case') || '';

  let rundir = parseCommandOption(command, 'rundir');
  if (rundir && caseName) {
    rundir = rundir.replace(/\{case_name\}/g, caseName);
  }

  // 直接候选：rundir 优先于 case（对应 Python get_seed 优先级 1 → 2）
  const relCandidates: string[] = [];
  if (rundir) relCandidates.push(rundir, join('work', rundir));
  if (caseName) relCandidates.push(caseName, join('work', caseName));

  const seen = new Set<string>();
  const orderedDirs: string[] = [];
  const pushDir = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    orderedDirs.push(dir);
  };

  for (const rel of relCandidates) {
    const dir = join(base, rel);
    if (isDirectory(dir) && isCaseDir(dir)) pushDir(dir);
  }
  for (const dir of searchCaseDirs(base, caseName)) pushDir(dir);

  const caseDir = orderedDirs[0] ?? null;

  let simLogPath: string | null = null;
  let compileLogPath: string | null = null;
  let asmFiles: string[] = [];
  for (const dir of orderedDirs) {
    if (!simLogPath) simLogPath = findLogFile(dir, SIM_LOG_NAMES);
    if (!compileLogPath) compileLogPath = findLogFile(dir, COMPILE_LOG_NAMES);
    if (asmFiles.length === 0) asmFiles = findAsmFiles(dir);
    if (simLogPath && compileLogPath && asmFiles.length > 0) break;
  }

  const verdiMode = caseDir
    ? existsSync(join(caseDir, 'simv.daidir')) || existsSync(join(caseDir, 'vcdplus.vpd'))
      ? 'vcs'
      : 'xrun'
    : null;

  return {
    caseDir,
    simLogPath,
    compileLogPath,
    asmFiles,
    verdiMode,
    matchedCaseDirs: orderedDirs,
  };
}

/**
 * 从仿真日志内容中提取种子号。
 *
 * 模式：`-seed <number>`（runsim 命令回显）→ `seed=<number>`（VCS 风格）。
 */
export function extractSeedFromLogContent(content: string): string | null {
  const m = content.match(/-seed\s+(\d+)/) ?? content.match(/seed\s*=\s*(\d+)/);
  return m ? m[1] : null;
}
