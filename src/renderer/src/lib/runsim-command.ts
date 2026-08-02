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

  // dump_mem
  const dumpMem = (typeof options.dump_mem === 'string' ? options.dump_mem : '').trim();
  if (dumpMem) {
    if (dumpMem.includes(' ')) {
      cmd.push('-dump_mem', `"${dumpMem}"`);
    } else {
      cmd.push('-dump_mem', dumpMem);
    }
  }

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
