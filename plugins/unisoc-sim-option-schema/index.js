'use strict';

/**
 * Unisoc Sim Option Schema Plugin
 *
 * 提供 runsim 命令的仿真选项 Schema 定义。
 * 前端 OptionDock 组件根据此 Schema 动态生成配置表单。
 *
 * 选项分类参考 Python runsim_r3p0 项目的 config_panel.py 和 command_generator.py：
 *   1. 基础参数（base / block / case / rundir / bq / seed / other_options）
 *   2. 波形配置（fsdb / vwdb / dump_level / cl / dump_sva / cov / upf / dump_mem / wdd）
 *   3. 仿真参数（simarg / cfg_def / post）
 *   4. 执行模式（sim_only / compile_only）
 *   5. 回归测试（regr_file / fm / regr_work / tag / nt / dashboard）
 */

const MANIFEST = {
  id: 'unisoc-sim-option-schema',
  name: 'Unisoc Sim Option Schema',
  version: '1.0.0',
  kind: 'sim-option-schema',
  description:
    'Unisoc 仿真选项 Schema 插件：提供 runsim 命令的所有仿真选项定义，供前端动态生成配置表单。',
};

// ─── 分组常量 ──────────────────────────────────────────────────
const GROUP_BASIC = '基础参数';
const GROUP_WAVE = '波形配置';
const GROUP_SIM = '仿真参数';
const GROUP_MODE = '执行模式';
const GROUP_REGR = '回归测试';

// ─── 后仿 SDF 选项枚举 ───────────────────────────────────────
const POST_OPTIONS = [
  '',
  'sdf=fake',
  'sdf=pg_fake',
  'sdf=npg_f1_ssg',
  'sdf=npg_f2_ssg',
  'sdf=npg_f3_ssg',
  'sdf=npg_f4_ssg',
  'sdf=npg_f5_ssg',
  'sdf=npg_f6_ssg',
  'sdf=npg_f7_ssg',
  'sdf=npg_f1_ffg',
  'sdf=npg_f2_ffg',
  'sdf=npg_f3_ffg',
  'sdf=npg_f4_ffg',
  'sdf=npg_f5_ffg',
  'sdf=npg_f6_ffg',
  'sdf=npg_f7_ffg',
  'sdf=npg_f1_tt',
  'sdf=npg_f2_tt',
];

// ─── 仿真选项字段定义 ─────────────────────────────────────────
//
// 每个字段对应 runsim 命令的一个参数选项。
// type 决定了前端渲染方式：
//   string  → 文本输入框
//   number  → 数字输入框
//   boolean → 开关按钮
//   enum    → 下拉选择框（需提供 enumValues）
// group 用于前端将字段按类别分组显示
const SIM_OPTION_FIELDS = [
  // ── 基础参数 ──────────────────────────────────────────────
  {
    key: 'base',
    label: 'BASE',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: 'runsim -base 参数，指定基础编译环境（如 top / apcpu_sys）',
  },
  {
    key: 'block',
    label: 'BLOCK',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: 'runsim -block 参数，指定仿真 block（必填，如 udtb/usvp）',
  },
  {
    key: 'case',
    label: 'CASE',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: 'runsim -case 参数，指定仿真用例名称',
  },
  {
    key: 'rundir',
    label: '工作目录 (-rundir)',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: 'runsim -rundir 参数，指定仿真工作目录。支持 {case_name} 占位符自动替换',
  },
  {
    key: 'bq',
    label: '提交服务器 (-bq)',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: 'runsim -bq 参数，指定 LSF/BQ 提交服务器名称',
  },
  {
    key: 'seed',
    label: '种子号 (-seed)',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: 'runsim -seed 参数，指定仿真随机种子号（纯数字）',
  },
  {
    key: 'other_options',
    label: '其他选项',
    type: 'string',
    default: '',
    group: GROUP_BASIC,
    description: '其他 runsim 命令行选项，直接追加到命令末尾',
  },

  // ── 波形配置 ──────────────────────────────────────────────
  {
    key: 'fsdb',
    label: 'Dump FSDB 波形 (-fsdb)',
    type: 'boolean',
    default: false,
    group: GROUP_WAVE,
    description: 'runsim -fsdb 参数，开启 FSDB 波形 dump。可搭配 dump_level 或 TCL 文件',
  },
  {
    key: 'vwdb',
    label: 'Dump VWDB 波形 (-vwdb)',
    type: 'boolean',
    default: false,
    group: GROUP_WAVE,
    description: 'runsim -vwdb 参数，开启 VWDB 波形 dump。可搭配 dump_level 或 TCL 文件',
  },
  {
    key: 'dump_level',
    label: 'Dump 层级',
    type: 'string',
    default: '',
    group: GROUP_WAVE,
    description:
      '波形 dump 的层次路径（如 tb_top.chip_top.dut），与 TCL 文件互斥',
  },
  {
    key: 'cl',
    label: 'Clean INCA_libs (-cl)',
    type: 'boolean',
    default: false,
    group: GROUP_WAVE,
    description: 'runsim -cl 参数，运行前清理 INCA_libs 编译缓存目录',
  },
  {
    key: 'dump_sva',
    label: 'Dump SVA 断言 (-dump_sva)',
    type: 'boolean',
    default: false,
    group: GROUP_WAVE,
    description: 'runsim -dump_sva 参数，dump SVA 断言波形数据',
  },
  {
    key: 'cov',
    label: '收集覆盖率 (-cov)',
    type: 'boolean',
    default: false,
    group: GROUP_WAVE,
    description: 'runsim -cov 参数，开启覆盖率收集',
  },
  {
    key: 'upf',
    label: 'UPF 仿真 (-upf)',
    type: 'boolean',
    default: false,
    group: GROUP_WAVE,
    description: 'runsim -upf 参数，启用 UPF 功耗仿真模式',
  },
  {
    key: 'dump_mem',
    label: 'Dump Memory (-dump_mem)',
    type: 'string',
    default: '',
    group: GROUP_WAVE,
    description:
      'runsim -dump_mem 参数，指定内存 dump 选项（多个选项用空格分隔，如 "DMEM IMEM"）',
  },
  {
    key: 'wdd',
    label: '波形 Dump 起始时间 (-wdd)',
    type: 'string',
    default: '',
    group: GROUP_WAVE,
    description: 'runsim -wdd 参数，指定波形 dump 的起始时间（如 1ns / 100ns）',
  },

  // ── 仿真参数 ──────────────────────────────────────────────
  {
    key: 'simarg',
    label: '仿真参数 (-simarg)',
    type: 'string',
    default: '',
    group: GROUP_SIM,
    description: 'runsim -simarg 参数，传递给仿真器的额外参数（值用双引号包裹）',
  },
  {
    key: 'cfg_def',
    label: '配置定义 (-cfg_def)',
    type: 'string',
    default: '',
    group: GROUP_SIM,
    description: 'runsim -cfg_def 参数，指定配置宏定义（如 NOINFO）',
  },
  {
    key: 'post',
    label: '后仿 (-post)',
    type: 'enum',
    default: '',
    enumValues: POST_OPTIONS,
    group: GROUP_SIM,
    description: 'runsim -post 参数，后仿 SDF 配置（如 sdf=fake / sdf=npg_f1_ssg）',
  },

  // ── 执行模式 ──────────────────────────────────────────────
  {
    key: 'sim_only',
    label: '仅仿真 (-R)',
    type: 'boolean',
    default: false,
    group: GROUP_MODE,
    description: 'runsim -R 参数，跳过编译直接执行仿真（与 -C 互斥）',
  },
  {
    key: 'compile_only',
    label: '仅编译 (-C)',
    type: 'boolean',
    default: false,
    group: GROUP_MODE,
    description: 'runsim -C 参数，仅执行编译不运行仿真（与 -R 互斥）',
  },

  // ── 回归测试 ──────────────────────────────────────────────
  {
    key: 'regr_file',
    label: '回归列表文件 (-regr)',
    type: 'string',
    default: '',
    group: GROUP_REGR,
    description: 'runsim -regr 参数，指定回归测试列表文件路径（.list / .txt）',
  },
  {
    key: 'fm',
    label: '回归 FAIL 用例 (-fm)',
    type: 'boolean',
    default: false,
    group: GROUP_REGR,
    description: 'runsim -fm 参数，仅回归之前失败的用例',
  },
  {
    key: 'regr_work',
    label: '回归路径 (-regr_work)',
    type: 'string',
    default: '',
    group: GROUP_REGR,
    description: 'runsim -regr_work 参数，指定回归测试工作目录',
  },
  {
    key: 'tag',
    label: '回归 TAG (-tag)',
    type: 'string',
    default: '',
    group: GROUP_REGR,
    description: 'runsim -tag 参数，指定回归测试 TAG 名称（仅运行标记该 TAG 的用例）',
  },
  {
    key: 'nt',
    label: '不回归 TAG (-nt)',
    type: 'string',
    default: '',
    group: GROUP_REGR,
    description: 'runsim -nt 参数，指定不回归的 TAG 名称（跳过标记该 TAG 的用例）',
  },
  {
    key: 'dashboard',
    label: '提交 Dashboard (-m)',
    type: 'string',
    default: '',
    group: GROUP_REGR,
    description: 'runsim -m 参数，指定 DE TAG 用于提交到 Dashboard',
  },
];

const plugin = {
  manifest: MANIFEST,

  /**
   * 获取仿真选项 Schema
   *
   * @param {string} _subsys - 子系统名称（当前实现返回统一 schema，不区分子系统）
   * @returns {Promise<{ fields: typeof SIM_OPTION_FIELDS }>}
   */
  async getSchema(_subsys) {
    return { fields: SIM_OPTION_FIELDS };
  },
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.SIM_OPTION_FIELDS = SIM_OPTION_FIELDS;
module.exports.POST_OPTIONS = POST_OPTIONS;
