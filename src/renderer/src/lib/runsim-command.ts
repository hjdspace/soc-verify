/**
 * runsim 命令生成工具（前端预览用）
 *
 * 此函数复刻 `unisoc-simulation-runner` 插件的 `generateRunsimCommand()` 逻辑，
 * 用于在 OptionDock 底部命令预览栏实时展示将要执行的 runsim 命令。
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

  if (!options.regr_file) {
    // ── 基础参数模式 ──
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
  } else {
    // ── 回归测试模式 ──
    cmd.push('-regr', String(options.regr_file));
    if (options.fm) cmd.push('-fm');
    const regrWork = (typeof options.regr_work === 'string' ? options.regr_work : '').trim();
    if (regrWork) cmd.push('-regr_work', regrWork);
    const tag = (typeof options.tag === 'string' ? options.tag : '').trim();
    if (tag) cmd.push('-tag', tag);
    const nt = (typeof options.nt === 'string' ? options.nt : '').trim();
    if (nt) cmd.push('-nt', nt);
    const dashboard = (typeof options.dashboard === 'string' ? options.dashboard : '').trim();
    if (dashboard) cmd.push('-m', dashboard);
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

// ─── runsim 命令解析（从粘贴文本中提取选项）────────────────────
//
// 参考 Python runsim_r3p0/controllers/config_controller.py 的
// _preprocess_command_text() + do_parse_command() + _parse_command_params()。
// 用户从网页或邮件中复制完整的回归指令文本（可能包含 HTML 标签、
// 前后说明文字等），系统自动提取 runsim 命令部分并解析为选项键值对。

/**
 * 预处理命令文本，提取 runsim 命令部分并清理 HTML 标签和特殊字符。
 *
 * @param rawText 用户粘贴的原始文本
 * @returns 清理后的 runsim 命令字符串，未找到则返回空字符串
 */
function preprocessCommandText(rawText: string): string {
  if (!rawText.trim()) return '';

  // 先移除 HTML 标签，避免 runsim 关键字被 HTML 包裹导致查找失败
  let text = rawText.replace(/<[^>]+>/g, ' ');
  // 将多行文本合并为单行，处理换行符和多余空格
  text = text.split(/\s+/).join(' ').trim();

  // 查找 runsim 命令的开始位置
  const runsimIndex = text.indexOf('runsim ');
  if (runsimIndex !== -1) {
    text = text.slice(runsimIndex).trim();
  } else if (text.startsWith('runsim')) {
    // 只有一个 runsim 没有参数
    return text.trim();
  } else if (text.startsWith('-')) {
    // 不完整的命令，添加 runsim 前缀
    return `runsim ${text}`;
  } else {
    return '';
  }

  // 合并多余空白
  text = text.replace(/\s+/g, ' ');
  // 移除命令行不需要的特殊字符（保留常用字符）
  text = text.replace(/[^\w\s\-=/.,:;_+*()[\]{}|&$#@!~`"'\\]/g, '');

  return text.trim();
}

/** Boolean flag 集合（无参数值，出现即设为 true） */
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
 * 支持：
 *   - 从包含其他文字的文本中自动提取 runsim 命令
 *   - 清理 HTML 标签和特殊字符
 *   - 解析带引号的参数值（-simarg "..."）
 *   - 识别 boolean flag 和带值参数
 *   - 解析 -fsdb/-vwdb 后可选的 dump_level 值
 *
 * @param rawText 用户粘贴的原始命令文本
 * @returns 解析出的选项键值对，可直接用于 setSimOptions
 */
export function parseRunsimCommand(rawText: string): Record<string, unknown> {
  const command = preprocessCommandText(rawText);
  if (!command) return {};

  // Tokenize：处理引号包裹的值
  const parts: string[] = command.match(/"[^"]*"|\S+/g) ?? [];
  if (parts.length === 0) return {};

  // parts[0] 应为 "runsim"
  const result: Record<string, unknown> = {};

  let i = 1; // 跳过 runsim
  while (i < parts.length) {
    const part = parts[i];
    if (!part.startsWith('-')) {
      i++;
      continue;
    }

    // 移除前导横杠
    const option = part.slice(1);

    // fsdb/vwdb：boolean flag，但后面可能跟 dump_level 值
    if (option === 'fsdb' || option === 'vwdb') {
      result[option] = true;
      // 检查后面是否有非 flag 参数（dump_level 或 tcl 文件）
      if (i + 1 < parts.length && !parts[i + 1].startsWith('-')) {
        const next = parts[i + 1];
        // 如果以 .tcl 结尾，跳过（TCL 文件参数）；否则作为 dump_level
        if (!next.toLowerCase().endsWith('.tcl')) {
          result.dump_level = next;
        }
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // 其他 boolean flag（无参数值）
    if (BOOLEAN_FLAGS.has(option)) {
      const key = BOOL_FLAG_TO_KEY[option];
      if (key) result[key] = true;
      i++;
      continue;
    }

    // 带参数值的选项
    const valueKey = VALUE_FLAG_TO_KEY[option];
    if (valueKey === undefined) {
      // 未知选项，跳过
      i++;
      continue;
    }

    if (i + 1 < parts.length) {
      let value = parts[i + 1];

      // 处理引号包裹的值（如 -simarg "..."）
      if (value.startsWith('"') && !value.endsWith('"')) {
        // 引号开始但未结束，收集直到结束引号
        value = value.slice(1);
        let j = i + 2;
        while (j < parts.length && !parts[j].endsWith('"')) {
          value += ' ' + parts[j];
          j++;
        }
        if (j < parts.length) {
          value += ' ' + parts[j].slice(0, -1); // 移除结束引号
          i = j + 1;
        } else {
          i = j;
        }
      } else if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
        // 完整引号包裹的值
        value = value.slice(1, -1);
        i += 2;
      } else {
        // 普通值
        i += 2;
      }

      // cfg_def 可能收集多个连续非 flag 值
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
      // 最后一个 flag 没有值，跳过
      i++;
    }
  }

  return result;
}

/**
 * 命令预览 token 类型
 */
export type CmdTokenType = 'base' | 'flag' | 'value';

export interface CmdToken {
  type: CmdTokenType;
  text: string;
}

/**
 * 将 runsim 命令字符串拆分为带类型的 token 数组，
 * 用于前端语法高亮渲染。
 *
 * - `base`: runsim 命令名
 * - `flag`: 以 `-` 开头的参数标志
 * - `value`: 参数值
 *
 * @param command - runsim 命令字符串
 * @returns token 数组
 */
export function tokenizeRunsimCommand(command: string): CmdToken[] {
  // 简单按空格拆分，处理引号包裹的值
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
