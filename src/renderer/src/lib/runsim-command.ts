/**
 * runsim 命令生成工具（前端预览用）+ 命令修改工具
 *
 * 此模块包含三部分：
 * 1. 命令生成（generateRunsimCommand）— 复刻插件逻辑，用于 SimOptionPanel 预览
 * 1b. 命令预览 token 拆分（tokenizeRunsimCommand）— 命令预览语法高亮
 * 1c. 命令解析（parseRunsimCommand）— 「解析回归指令」从粘贴文本提取参数
 * 2. 命令修改（modifyCommandOptions 等）— 用于 SimControlToolbar
 *
 * 第二部分参考 Python GUI 的 `utils/command_generator.py` CommandParser 类；
 * 命令解析复刻 `controllers/config_controller.py` 的解析回归指令流程。
 */

// ═══════════════════════════════════════════════════════════════════════
// Part 1: 命令生成（原始实现，供 SimOptionPanel 使用）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 此函数复刻 `unisoc-simulation-runner` 插件的 `generateRunsimCommand()` 逻辑，
 * 用于在 SimOptionPanel 命令预览栏实时展示将要执行的 runsim 命令。
 *
 * 注意：此函数仅用于预览，实际执行的命令由后端插件生成。
 * 若两者不一致，以插件为准。
 *
 * @param options - 仿真选项键值对（与 SimOptionField.key 对应）
 * @returns runsim 命令字符串
 */
export function generateRunsimCommand(options: Record<string, unknown>): string {
  const cmd: string[] = ['runsim'];

  const caseName =
    (typeof options.case === 'string' ? options.case : '').trim() || '';

  // ── 基础参数 ──
  if (options.base) cmd.push('-base', String(options.base));
  if (options.block) cmd.push('-block', String(options.block));
  if (caseName) cmd.push('-case', caseName);

  // rundir（支持 {case_name} 占位符替换）
  let rundir = (typeof options.rundir === 'string' ? options.rundir : '').trim();
  if (rundir) {
    if (rundir.includes('{case_name}') && caseName) {
      rundir = rundir.replace(/\{case_name\}/g, caseName);
    }
    cmd.push('-rundir', rundir);
  }

  // ── 波形配置 ──
  if (options.fsdb) {
    cmd.push('-fsdb');
    const dumpLevel = (typeof options.dump_level === 'string' ? options.dump_level : '').trim();
    const fsdbFile = (typeof options.fsdb_file === 'string' ? options.fsdb_file : '').trim();
    if (dumpLevel) {
      cmd.push(dumpLevel);
    } else if (fsdbFile) {
      cmd.push(fsdbFile);
    }
  }

  if (options.vwdb) {
    cmd.push('-vwdb');
    const dumpLevel = (typeof options.dump_level === 'string' ? options.dump_level : '').trim();
    const fsdbFile = (typeof options.fsdb_file === 'string' ? options.fsdb_file : '').trim();
    if (dumpLevel) {
      cmd.push(dumpLevel);
    } else if (fsdbFile) {
      cmd.push(fsdbFile);
    }
  }

  if (options.cl) cmd.push('-cl');
  if (options.dump_sva) cmd.push('-dump_sva');
  if (options.cov) cmd.push('-cov');
  if (options.upf) cmd.push('-upf');

  // dump_mem (boolean flag — checked → add -dump_mem)
  if (options.dump_mem) cmd.push('-dump_mem');

  // wdd
  const wdd = (typeof options.wdd === 'string' ? options.wdd : '').trim();
  if (wdd) cmd.push('-wdd', wdd);

  // seed
  const seed = (typeof options.seed === 'string' ? options.seed : '').trim();
  if (seed) cmd.push('-seed', seed);

  // bq
  const bq = (typeof options.bq === 'string' ? options.bq : '').trim();
  if (bq) cmd.push('-bq', bq);

  // simarg
  const simarg = (typeof options.simarg === 'string' ? options.simarg : '').trim();
  if (simarg) cmd.push('-simarg', `"${simarg}"`);

  // cfg_def
  const cfgDef = (typeof options.cfg_def === 'string' ? options.cfg_def : '').trim();
  if (cfgDef) cmd.push('-cfg_def', cfgDef);

  // post
  const post = (typeof options.post === 'string' ? options.post : '').trim();
  if (post) cmd.push('-post', post);

  // ── 执行模式 ──
  if (options.sim_only) {
    cmd.push('-R');
  } else if (options.compile_only) {
    cmd.push('-C');
  }

  // ── 其他选项 ──
  const otherOptions = (typeof options.other_options === 'string' ? options.other_options : '').trim();
  if (otherOptions) cmd.push(otherOptions);

  return cmd.join(' ');
}

// ═══════════════════════════════════════════════════════════════════════
// Part 1b: 命令预览 token 拆分
// ═══════════════════════════════════════════════════════════════════════

/**
 * 命令预览 token 类型
 */
export type CmdTokenType = 'base' | 'flag' | 'value';

export interface CmdToken {
  type: CmdTokenType;
  text: string;
}

/**
 * 将 runsim 命令字符串拆分为带类型的 token 数组，用于前端语法高亮渲染。
 */
export function tokenizeRunsimCommand(command: string): CmdToken[] {
  const tokens: CmdToken[] = [];
  const parts = command.match(/"[^"]*"|\S+/g) ?? [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (i === 0) {
      tokens.push({ type: 'base', text: part });
    } else if (part.startsWith('-')) {
      tokens.push({ type: 'flag', text: part });
    } else {
      tokens.push({ type: 'value', text: part });
    }
  }

  return tokens;
}

// ═══════════════════════════════════════════════════════════════════════
// Part 1c: 命令解析（从粘贴文本中提取选项）
// 复刻 Python GUI（runsim_r3p0）ConfigController 的解析回归指令流程：
// _preprocess_command_text / _clean_command_text / _parse_command_params
// ═══════════════════════════════════════════════════════════════════════

/**
 * 预处理命令文本，提取 runsim 命令部分并清理 HTML 标签和特殊字符。
 *
 * 复刻 Python GUI 的 `_preprocess_command_text()` + `_clean_command_text()`：
 * - 多行文本合并为单行（网页复制常带换行/多余空白）
 * - 剥离 HTML 标签
 * - 定位 `runsim ` 关键字，只保留命令部分
 * - 无 runsim 前缀但以 `-` 开头时，视为不完整命令自动补前缀
 */
function preprocessCommandText(rawText: string): string {
  if (!rawText.trim()) return '';

  let text = rawText.replace(/<[^>]+>/g, ' ');
  text = text.split(/\s+/).join(' ').trim();

  const runsimIndex = text.indexOf('runsim ');
  if (runsimIndex !== -1) {
    text = text.slice(runsimIndex).trim();
  } else if (text.startsWith('runsim')) {
    return text.trim();
  } else if (text.startsWith('-')) {
    return `runsim ${text}`;
  } else {
    return '';
  }

  text = text.replace(/\s+/g, ' ');
  text = text.replace(/[^\w\s\-=/.,:;_+*()[\]{}|&$#@!~`"'\\]/g, '');

  return text.trim();
}

/** Boolean flag 集合（无参数值，出现即为 true） */
const BOOLEAN_FLAGS = new Set([
  'cl', 'dump_sva', 'cov', 'upf', 'dump_mem', 'fm', 'R', 'C',
]);

/** 带参数值的 flag → option key 映射 */
const VALUE_FLAG_TO_KEY: Record<string, string> = {
  base: 'base',
  block: 'block',
  case: 'case',
  rundir: 'rundir',
  bq: 'bq',
  seed: 'seed',
  wdd: 'wdd',
  simarg: 'simarg',
  cfg_def: 'cfg_def',
  post: 'post',
  regr: 'regr_file',
  regr_work: 'regr_work',
  tag: 'tag',
  nt: 'nt',
  m: 'dashboard',
};

/** Boolean flag → option key 映射 */
const BOOL_FLAG_TO_KEY: Record<string, string> = {
  cl: 'cl',
  dump_sva: 'dump_sva',
  cov: 'cov',
  upf: 'upf',
  dump_mem: 'dump_mem',
  fm: 'fm',
  R: 'sim_only',
  C: 'compile_only',
  fsdb: 'fsdb',
  vwdb: 'vwdb',
};

/**
 * 解析 runsim 命令文本，提取选项键值对。
 *
 * 用于「解析回归指令」：用户粘贴从网页复制的完整回归指令（可能含
 * 前后噪音文本/HTML 标签/换行），自动提取 runsim 参数填入 Option 面板。
 *
 * 解析结果覆盖已有同名字段；无法识别的 flag 跳过。
 *
 * @param rawText - 用户粘贴的原始文本
 * @returns 提取的选项键值对；未找到有效 runsim 命令时返回空对象
 */
export function parseRunsimCommand(rawText: string): Record<string, unknown> {
  const command = preprocessCommandText(rawText);
  if (!command) return {};

  const parts: string[] = command.match(/"[^"]*"|\S+/g) ?? [];
  if (parts.length === 0) return {};

  const result: Record<string, unknown> = {};

  let i = 1;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.startsWith('-')) {
      i++;
      continue;
    }

    const option = part.slice(1);

    // -fsdb / -vwdb 后可跟 dump level（或 .tcl 文件，不算 dump level）
    if (option === 'fsdb' || option === 'vwdb') {
      result[option] = true;
      if (i + 1 < parts.length && !parts[i + 1].startsWith('-')) {
        const next = parts[i + 1];
        if (!next.toLowerCase().endsWith('.tcl')) {
          result.dump_level = next;
        }
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(option)) {
      const key = BOOL_FLAG_TO_KEY[option];
      if (key) result[key] = true;
      i++;
      continue;
    }

    const valueKey = VALUE_FLAG_TO_KEY[option];
    if (valueKey === undefined) {
      i++;
      continue;
    }

    if (i + 1 < parts.length) {
      let value = parts[i + 1];

      // 带引号的参数（如 -simarg "...")：值可能被空格拆成多个 token，
      // 聚合到结束引号为止
      if (value.startsWith('"') && !value.endsWith('"')) {
        value = value.slice(1);
        let j = i + 2;
        while (j < parts.length && !parts[j].endsWith('"')) {
          value += ' ' + parts[j];
          j++;
        }
        if (j < parts.length) {
          value += ' ' + parts[j].slice(0, -1);
          i = j + 1;
        } else {
          i = j;
        }
      } else if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
        value = value.slice(1, -1);
        i += 2;
      } else {
        i += 2;
      }

      // -cfg_def 后可跟多个非选项参数（如 -cfg_def A B C），全部聚合
      if (option === 'cfg_def') {
        let j = i;
        while (j < parts.length && !parts[j].startsWith('-')) {
          value += ' ' + parts[j];
          j++;
        }
        if (j > i) {
          value = value.trim();
          i = j;
        }
      }

      result[valueKey] = value;
    } else {
      i++;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Part 2: 命令修改工具（供 SimControlToolbar 使用）
// 参考 Python GUI 的 CommandParser.modify_command_options()
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if the command contains the -fsdb option.
 */
export function hasFsdbOption(command: string): boolean {
  const parts = command.split(/\s+/);
  return parts.includes('-fsdb');
}

/**
 * Check if the command contains the -R option (sim-only, skip compile).
 */
export function hasROption(command: string): boolean {
  const parts = command.split(/\s+/);
  return parts.includes('-R');
}

/**
 * Modify the -fsdb and -R options in a runsim command string.
 *
 * @param command - The original command string
 * @param opts - Which options to modify (undefined = don't change)
 * @returns The modified command string
 */
export function modifyCommandOptions(
  command: string,
  opts: { fsdb?: boolean; R?: boolean },
): string {
  if (!command) return command;

  // Handle BATCH RUN mode (semicolon-separated commands)
  if (command.includes(' ; ')) {
    const commands = command.split(' ; ');
    const modified = commands.map((cmd) => {
      const trimmed = cmd.trim();
      if (trimmed) {
        return modifySingleCommandOptions(trimmed, opts);
      }
      return trimmed;
    });
    return modified.join(' ; ');
  }

  return modifySingleCommandOptions(command, opts);
}

/**
 * Modify options in a single command string.
 *
 * Aligned with Python GUI's CommandParser._modify_single_command_options():
 * 1. Remove ALL existing occurrences of the flag (and any following non-flag argument)
 * 2. If enabled, append the flag at the END of the command
 */
function modifySingleCommandOptions(
  command: string,
  opts: { fsdb?: boolean; R?: boolean },
): string {
  let parts = command.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return command;

  if (opts.fsdb !== undefined) {
    parts = toggleBooleanFlag(parts, '-fsdb', opts.fsdb);
  }

  if (opts.R !== undefined) {
    parts = toggleBooleanFlag(parts, '-R', opts.R);
  }

  return parts.join(' ');
}

/**
 * Add or remove a boolean flag option from the command parts array.
 *
 * Mirrors Python's _modify_fsdb_option / _modify_r_option:
 * - When removing: also remove any following non-flag argument (e.g. dump level)
 * - When adding: append at the END of the command (not before -case)
 */
function toggleBooleanFlag(parts: string[], flag: string, enabled: boolean): string[] {
  // Remove ALL existing occurrences of the flag (and following non-flag argument)
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === flag) {
      // Skip the flag itself
      // Also skip the following argument if it doesn't start with '-' (e.g. dump level)
      if (i + 1 < parts.length && !parts[i + 1].startsWith('-')) {
        i++; // skip the argument too
      }
      continue;
    }
    result.push(parts[i]);
  }

  // If enabling, append at the END of the command
  if (enabled) {
    result.push(flag);
  }

  return result;
}

/**
 * Update or add a -seed <value> option in the command string.
 *
 * Aligned with Python's CommandParser._update_seed_in_single_command:
 * 1. Remove ALL existing -seed flags (and their values)
 * 2. Append -seed <value> at the END of the command
 *
 * @param command - The original command string
 * @param seed - The seed value to set
 * @returns The modified command string with the updated seed
 */
export function updateSeedInCommand(command: string, seed: string): string {
  if (!command || !seed) return command;

  const parts = command.split(/\s+/).filter((p) => p.length > 0);

  // Remove ALL existing -seed flags (and their values)
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-seed') {
      // Skip -seed and its value
      if (i + 1 < parts.length && !parts[i + 1].startsWith('-')) {
        i++; // skip the value too
      }
      continue;
    }
    result.push(parts[i]);
  }

  // Append -seed <value> at the END
  result.push('-seed', seed);
  return result.join(' ');
}

/**
 * Strip the `cd "<dir>" && ` prefix from a command string (display only).
 *
 * The backend (`runInTerminal` / `rerunWithCommand`) prepends
 * `cd "$PROJ_WORK" && ` to ensure the simulation runs in the correct
 * directory. For display purposes the user only wants to see the
 * `runsim ...` portion. This function removes the cd prefix so the
 * toolbar preview shows a cleaner command.
 *
 * **Display-only** — the internal `currentCommand` state still holds
 * the full command (with cd prefix) for API calls (`rerunWithCommand`,
 * `getSeedFromLog`, `resolveDebugArtifacts`, etc.) that rely on the
 * cd prefix for artifact path resolution.
 */
export function stripCdPrefix(command: string): string {
  if (!command) return command;
  return command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*/, '');
}

/**
 * Parse the case name from a runsim command string.
 */
export function parseCaseFromCommand(command: string): string | null {
  if (!command) return null;
  const parts = command.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-case' && i + 1 < parts.length) {
      return parts[i + 1];
    }
  }
  return null;
}

/**
 * Parse the rundir from a runsim command string.
 */
export function parseRundirFromCommand(command: string): string | null {
  if (!command) return null;
  const parts = command.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-rundir' && i + 1 < parts.length) {
      return parts[i + 1];
    }
  }
  return null;
}
