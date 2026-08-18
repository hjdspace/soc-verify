/**
 * Command builder for sysbase_gen.py — pure function.
 *
 * Serializes a `SysbaseGenConfig` into a formatted multi-line command string
 * with backslash line continuation and aligned flags.
 *
 * Two modes depending on `config.genLevel`:
 *
 * subsys:
 *   python3 <scriptPath> gen \
 *       -rtl          <rtlFile> \
 *       -n            <subsys> \
 *       -i            <instanceName> \
 *       -x            <dutSpecPath> \
 *       -mini         <miniExcelPath> \
 *       -ral          <ralDirs.join(' ')> \
 *       [-clk         <clkDir>] \
 *       [-clk2        <clk2Dir>] \
 *       -mod_io       <modIoPath> \
 *       [-module_list <moduleListPath>] \
 *       [-target_scope <targetScope>] \
 *       [-pinlist     <pinlistPath>] \
 *       [-dmalist     <dmalistPath>] \
 *       -o            <outputDir>
 *
 * top:
 *   python3 <scriptPath> gen \
 *       -rtl  <rtlFile> \
 *       -n    <subsys> \
 *       -i    <instanceName> \
 *       -c    <csvPath> \
 *       -ral  <ralDirs.join(' ')> \
 *       -o    <outputDir>
 */

import type { SysbaseGenConfig } from '../../../shared/types/sysbase-gen';

/** Python interpreter used in the generated command. */
const PYTHON_BIN = 'python3';

/** Width for flag column alignment (longest flag is `-target_scope` = 13 chars). */
const FLAG_WIDTH = 13;

/**
 * Build a formatted `sysbase_gen.py` command string from wizard config.
 *
 * @param config     Wizard configuration (all fields)
 * @param scriptPath Path to `sysbase_gen.py`
 * @returns Multi-line command string with backslash continuation
 */
export function buildSysbaseCommand(config: SysbaseGenConfig, scriptPath: string): string {
  if (config.genLevel === 'top') {
    return buildTopCommand(config, scriptPath);
  }
  return buildSubsysCommand(config, scriptPath);
}

/**
 * Build the top-level gen command (6 params: -rtl -n -i -c -ral -o).
 */
function buildTopCommand(config: SysbaseGenConfig, scriptPath: string): string {
  const lines: string[] = [];

  lines.push(`${PYTHON_BIN} ${scriptPath} gen`);
  lines.push(formatLine('-rtl', config.rtlFile));
  lines.push(formatLine('-n', config.subsys));
  lines.push(formatLine('-i', config.instanceName));
  lines.push(formatLine('-c', config.csvPath));
  lines.push(formatLine('-ral', config.ralDirs.join(' ')));
  lines.push(formatLine('-o', config.outputDir));

  return lines.map((line, i) => (i < lines.length - 1 ? `${line} \\` : line)).join('\n');
}

/**
 * Build the subsys-level gen command (all 14 params).
 */
function buildSubsysCommand(config: SysbaseGenConfig, scriptPath: string): string {
  const lines: string[] = [];

  // Header line: python3 <script> gen
  lines.push(`${PYTHON_BIN} ${scriptPath} gen`);

  // Required parameters (order matters per spec)
  lines.push(formatLine('-rtl', config.rtlFile));
  lines.push(formatLine('-n', config.subsys));
  lines.push(formatLine('-i', config.instanceName));
  lines.push(formatLine('-x', config.dutSpecPath));
  lines.push(formatLine('-mini', config.miniExcelPath));
  lines.push(formatLine('-ral', config.ralDirs.join(' ')));

  // Optional: -clk (some subsys don't need a CLK directory)
  if (config.clkDir.trim()) {
    lines.push(formatLine('-clk', config.clkDir));
  }

  // Optional: -clk2
  if (config.clk2Dir.trim()) {
    lines.push(formatLine('-clk2', config.clk2Dir));
  }

  // Required: -mod_io
  lines.push(formatLine('-mod_io', config.modIoPath));

  // Optional: -module_list (target module list file for Module IO generation)
  if (config.moduleListPath.trim()) {
    lines.push(formatLine('-module_list', config.moduleListPath));
  }

  // Optional: -target_scope (hierarchy path, e.g. tb_top.chip.dut.u_sys_cpu)
  if (config.targetScope.trim()) {
    lines.push(formatLine('-target_scope', config.targetScope));
  }

  // Optional: -pinlist
  if (config.pinlistPath.trim()) {
    lines.push(formatLine('-pinlist', config.pinlistPath));
  }

  // Optional: -dmalist
  if (config.dmalistPath.trim()) {
    lines.push(formatLine('-dmalist', config.dmalistPath));
  }

  // Required: -o (always last)
  lines.push(formatLine('-o', config.outputDir));

  // Join with backslash continuation
  return lines.map((line, i) => (i < lines.length - 1 ? `${line} \\` : line)).join('\n');
}

/**
 * Format a single command line with aligned flag and value.
 *
 * @param flag  The flag string, e.g. `-rtl`
 * @param value The value string
 * @returns Padded line like `    -rtl     <value>`
 */
function formatLine(flag: string, value: string): string {
  const paddedFlag = flag.padEnd(FLAG_WIDTH);
  return `    ${paddedFlag} ${value}`;
}
