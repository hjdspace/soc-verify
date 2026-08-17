/**
 * Sysbase Environment Generator — shared types.
 *
 * Defines the configuration object that the wizard collects,
 * used by both the renderer (Zustand store) and the main process
 * (command builder, config persistence).
 */

/** Generation level: 'subsys' for subsystem-level, 'top' for chip-level. */
export type GenLevel = 'subsys' | 'top';

/** Wizard configuration with all fields (subsys + top level). */
export type SysbaseGenConfig = {
  /** Generation level: 'subsys' or 'top' (determines which steps/options are shown). */
  genLevel: GenLevel;
  /** Subsystem name, e.g. `apcpu_sys` (Step 1, `-n`). For top level, this is the chip name (e.g. `top`). */
  subsys: string;
  /** Instance name, e.g. `u_sys_apcpu` (Step 1, `-i`). For top level, default is `dut`. */
  instanceName: string;
  /** RTL top-level file path (Step 2, `-rtl`). */
  rtlFile: string;
  /** Module name extracted from RTL file (Step 2, used by Step 7). */
  moduleName: string;
  /** DUT spec Excel path (Step 3, `-x`). Subsys only. */
  dutSpecPath: string;
  /** Mini case Excel path (Step 4, `-mini`). Subsys only. */
  miniExcelPath: string;
  /** Top CSV file path (Step 3 for top level, `-c`). Top only. Contains subsys domain + core name info. */
  csvPath: string;
  /** RAL directory paths — multiple joined with space (Step 5, `-ral`). */
  ralDirs: string[];
  /** CLK directory path (Step 6, `-clk`). Subsys only. */
  clkDir: string;
  /** Optional CLK2 directory, format `<dePath>,<clkPrefix>` (Step 6, `-clk2`). Subsys only. */
  clk2Dir: string;
  /** Module IO output file path (Step 7, `-mod_io`). Subsys only. */
  modIoPath: string;
  /** Filelist path used for generating Module IO (Step 7). Subsys only. */
  filelistPath: string;
  /** Optional pin list file path (Step 8, `-pinlist`). Subsys only. */
  pinlistPath: string;
  /** Optional DMA list file path (Step 8, `-dmalist`). Subsys only. */
  dmalistPath: string;
  /** Output directory (Step 8, `-o`). */
  outputDir: string;
};

/** Default script path for sysbase_gen.py. */
export const DEFAULT_SYSBASE_SCRIPT = '/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py';

/** Create an empty config with all fields set to sensible defaults. */
export function createEmptySysbaseConfig(): SysbaseGenConfig {
  return {
    genLevel: 'subsys',
    subsys: '',
    instanceName: '',
    rtlFile: '',
    moduleName: '',
    dutSpecPath: '',
    miniExcelPath: '',
    csvPath: '',
    ralDirs: [],
    clkDir: '',
    clk2Dir: '',
    modIoPath: '',
    filelistPath: '',
    pinlistPath: '',
    dmalistPath: '',
    outputDir: './',
  };
}

/** Known subsystem names hardcoded from project documentation. */
export const KNOWN_SUBSYSTEMS = [
  'aon_sys',
  'ap_sys',
  'apcpu_sys',
  'camera_sys',
  'dpu_sys',
  'vpu_sys',
  'gpu_sys',
  'lpach_sys',
  'dbg_sys',
  'ai_sys',
  'pub_sys',
  'pcie_sys',
] as const;

/** Step metadata for the wizard. */
export type SysbaseGenStep = {
  index: number;
  key: string;
  label: string;
};

/** All 9 steps of the subsys wizard. */
export const SUBSYS_GEN_STEPS: readonly SysbaseGenStep[] = [
  { index: 0, key: 'subsys', label: '选择 Subsys' },
  { index: 1, key: 'rtl', label: 'RTL 顶层文件' },
  { index: 2, key: 'dut-spec', label: 'DUT Spec' },
  { index: 3, key: 'mini', label: 'Mini Excel' },
  { index: 4, key: 'ral', label: 'RAL 目录' },
  { index: 5, key: 'clk', label: 'CLK 目录' },
  { index: 6, key: 'mod-io', label: 'Module IO' },
  { index: 7, key: 'optional', label: '可选项' },
  { index: 8, key: 'review', label: '预览执行' },
] as const;

/** All 6 steps of the top-level wizard (fewer options than subsys). */
export const TOP_GEN_STEPS: readonly SysbaseGenStep[] = [
  { index: 0, key: 'top-info', label: 'Top 信息' },
  { index: 1, key: 'rtl', label: 'RTL 顶层文件' },
  { index: 2, key: 'csv', label: 'CSV 文件' },
  { index: 3, key: 'ral', label: 'RAL 目录' },
  { index: 4, key: 'optional', label: '可选项' },
  { index: 5, key: 'review', label: '预览执行' },
] as const;

/** Backward-compatible alias: subsys steps (9 steps). */
export const SYSBASE_GEN_STEPS = SUBSYS_GEN_STEPS;

/** Get the steps for a given generation level. */
export function getGenSteps(level: GenLevel): readonly SysbaseGenStep[] {
  return level === 'top' ? TOP_GEN_STEPS : SUBSYS_GEN_STEPS;
}
