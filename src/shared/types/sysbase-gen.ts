/**
 * Sysbase Environment Generator — shared types.
 *
 * Defines the configuration object that the 9-step wizard collects,
 * used by both the renderer (Zustand store) and the main process
 * (command builder, config persistence).
 */

/** Wizard configuration with all 14 fields. */
export type SysbaseGenConfig = {
  /** Subsystem name, e.g. `apcpu_sys` (Step 1, `-n`). */
  subsys: string;
  /** Instance name, e.g. `u_sys_apcpu` (Step 1, `-i`). */
  instanceName: string;
  /** RTL top-level file path (Step 2, `-rtl`). */
  rtlFile: string;
  /** Module name extracted from RTL file (Step 2, used by Step 7). */
  moduleName: string;
  /** DUT spec Excel path (Step 3, `-x`). */
  dutSpecPath: string;
  /** Mini case Excel path (Step 4, `-mini`). */
  miniExcelPath: string;
  /** RAL directory paths — multiple joined with space (Step 5, `-ral`). */
  ralDirs: string[];
  /** CLK directory path (Step 6, `-clk`). */
  clkDir: string;
  /** Optional CLK2 directory, format `<dePath>,<clkPrefix>` (Step 6, `-clk2`). */
  clk2Dir: string;
  /** Module IO output file path (Step 7, `-mod_io`). */
  modIoPath: string;
  /** Filelist path used for generating Module IO (Step 7). */
  filelistPath: string;
  /** Optional pin list file path (Step 8, `-pinlist`). */
  pinlistPath: string;
  /** Optional DMA list file path (Step 8, `-dmalist`). */
  dmalistPath: string;
  /** Output directory (Step 8, `-o`). */
  outputDir: string;
};

/** Default script path for sysbase_gen.py. */
export const DEFAULT_SYSBASE_SCRIPT = '/pri/project/tools/sprd/dv/sysbase/r3p4/bin/sysbase_gen.py';

/** Create an empty config with all fields set to sensible defaults. */
export function createEmptySysbaseConfig(): SysbaseGenConfig {
  return {
    subsys: '',
    instanceName: '',
    rtlFile: '',
    moduleName: '',
    dutSpecPath: '',
    miniExcelPath: '',
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

/** Step metadata for the 9-step wizard. */
export type SysbaseGenStep = {
  index: number;
  key: string;
  label: string;
};

/** All 9 steps of the wizard. */
export const SYSBASE_GEN_STEPS: readonly SysbaseGenStep[] = [
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
