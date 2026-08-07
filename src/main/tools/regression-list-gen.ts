/**
 * Regression List Generator — native TypeScript implementation.
 *
 * Ported from Python `gen_regr_list.py` — parses case cfg files,
 * generates regression list (regr.lst) natively without external Python dependency.
 *
 * Also provides `parseBaseBlockFromPath()` to auto-infer -base/-block
 * from the case cfg file path, matching the logic in `unisoc-case-parser`
 * plugin and Python `case_parser.py`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

// ── Types ──────────────────────────────────────────────────────────

export type RegressionListConfig = {
  block: string;
  base: string;
  tag: string;
  cfg: string;
  output: string;
  otherOptions: string;
};

export type HistoryEntry = RegressionListConfig & {
  timestamp: string;
};

export type HistoryFile = {
  history: HistoryEntry[];
  current: RegressionListConfig;
};

export type CaseInfoEntry = {
  name: string;
  cfgDef: string; // "default" or "[cfg_def_name]"
};

export type GenResult = {
  success: boolean;
  logs: string[];
  output?: string;
  errorMessage?: string;
};

// ── Base/Block inference ──────────────────────────────────────────

/**
 * Known system names for USVP config file base parameter inference.
 * Mirrors the `KNOWN_SYSTEMS` list in `unisoc-case-parser` plugin.
 */
const KNOWN_SYSTEMS = ['apcpu', 'ch', 'sp', 'aon', 'spch', 'ps_cp', 'phy_cp'];

/**
 * Infer -base and -block from a case cfg file path.
 *
 * Rules (ported from Python `case_parser.py` and `unisoc-case-parser` plugin):
 *
 * 1. `{subsys}/bin/case_cfg/xxx.cfg` (no udtb)
 *    → base="", block="{subsys}"
 *    Special: filename contains `-sys` (e.g. `apcpu-sys_bus_case.cfg`)
 *    → subsys extracted from filename before `-sys`
 *
 * 2. `udtb/{subsys}/{subenv}/bin/xxx.cfg` (non-usvp)
 *    → base="{subsys}", block="udtb/{subsys}/{subenv}"
 *
 * 3. `udtb/usvp/bin/case_cfg/<sys>_subsys_case.cfg`
 *    → base="<sys>_sys", block="udtb/usvp"
 *    Also handles `-sys` in filename.
 *
 * 4. `udtb/usvp/bin/case_cfg/<sys>_top_case.cfg`
 *    → base="top", block="udtb/usvp"
 *
 * 5. `udtb/usvp/bin/case_cfg/xxx.cfg` (default)
 *    → base="top", block="udtb/usvp"
 *    If filename starts with a known system name → base="<sys>_sys"
 */
export function parseBaseBlockFromPath(filePath: string): { base: string; block: string } {
  // Normalize path separators to /
  const normalized = filePath.replace(/\\/g, '/');
  const filename = basename(normalized);

  // ── Rule 1: {subsys}/bin/case_cfg/xxx.cfg (no udtb) ──
  if (!normalized.includes('udtb')) {
    const match = normalized.match(/([^/]+)\/bin\/case_cfg\//);
    if (match) {
      let subsys = match[1];

      // Handle filename with -sys (e.g. apcpu-sys_bus_case.cfg)
      if (filename.includes('-sys')) {
        const nameParts = filename.split('_')[0].split('-');
        if (nameParts.length >= 2 && nameParts[1] === 'sys') {
          subsys = nameParts[0];
        }
      }

      return { base: '', block: subsys };
    }
  }

  // ── Rule 2: udtb/{subsys}/{subenv}/bin/xxx.cfg (non-usvp) ──
  if (normalized.includes('udtb') && !normalized.includes('usvp')) {
    const match = normalized.match(/udtb\/([^/]+)\/([^/]+)\/bin\//);
    if (match) {
      return { base: match[1], block: `udtb/${match[1]}/${match[2]}` };
    }
  }

  // ── Rules 3/4/5: udtb/usvp/bin/case_cfg/xxx.cfg ──
  if (normalized.includes('udtb/usvp')) {
    // Handle -sys in filename (e.g. apcpu-sys_bus_case.cfg)
    if (filename.includes('-sys')) {
      const nameParts = filename.split('_')[0].split('-');
      if (nameParts.length >= 2 && nameParts[1] === 'sys') {
        return { base: `${nameParts[0]}_sys`, block: 'udtb/usvp' };
      }
    }

    // Rule 3: <sys>_subsys_case.cfg → base="<sys>_sys"
    const subsysMatch = filename.match(/^([^_]+)_subsys(?:_case)?\.cfg$/i);
    if (subsysMatch) {
      return { base: `${subsysMatch[1]}_sys`, block: 'udtb/usvp' };
    }

    // Rule 4: <sys>_top_case.cfg → base="top"
    const topMatch = filename.match(/^([^_]+)_top(?:_case)?\.cfg$/i);
    if (topMatch) {
      return { base: 'top', block: 'udtb/usvp' };
    }

    // Rule 5: default — check known system names
    if (normalized.includes('udtb/usvp/bin/case_cfg/')) {
      // Try to match known system name at start of filename
      const partsMatch = filename.match(/^([^_]+)(?:_\w+)*(?:_case)?\.cfg$/i);
      if (partsMatch) {
        const sysName = partsMatch[1].toLowerCase();
        if (filename.toLowerCase().includes('top')) {
          return { base: 'top', block: 'udtb/usvp' };
        }
        if (KNOWN_SYSTEMS.includes(sysName)) {
          return { base: `${sysName}_sys`, block: 'udtb/usvp' };
        }
      }
      // Fallback default
      return { base: 'top', block: 'udtb/usvp' };
    }
  }

  return { base: '', block: '' };
}

// ── Case cfg parsing ──────────────────────────────────────────────

/**
 * Find all base case names — cases that are extended by other cases
 * via `[case child:base]` syntax.
 *
 * These base cases are templates and should be excluded from the
 * regression list.
 */
function findBaseCases(content: string): Set<string> {
  const baseCases = new Set<string>();
  const pattern = /^\[case\s+(\w+)\s*:\s*(\w+)\]/;
  for (const line of content.split('\n')) {
    const m = pattern.exec(line.trim());
    if (m) {
      baseCases.add(m[2]);
    }
  }
  return baseCases;
}

/**
 * Parse a case cfg file and extract the list of cases to include
 * in the regression list.
 *
 * Ported from Python `RegressionList.parse_case_cfg()`:
 *   - Find base cases (templates) and skip them
 *   - Skip cases whose name contains 'compile_lib'
 *   - For each case, check the preceding line for `cfg_def` annotation
 *
 * @returns Array of { name, cfgDef } where cfgDef is "default" or "[cfg_def_name]"
 */
export function parseCaseCfg(content: string): CaseInfoEntry[] {
  const baseCases = findBaseCases(content);
  const lines = content.split('\n');
  const casePattern = /^\[case\s+(\w+).*\]/;
  const cfgDefPattern = /cfg_def\s+(\w+)/;
  const caseInfoList: CaseInfoEntry[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    const m = casePattern.exec(line);
    if (!m) continue;

    const caseName = m[1];

    // Skip compile_lib cases
    if (caseName.includes('compile_lib')) continue;

    // Skip base cases (they are templates, not runnable cases)
    if (baseCases.has(caseName)) continue;

    // Check preceding line for cfg_def annotation
    if (idx === 0) {
      caseInfoList.push({ name: caseName, cfgDef: 'default' });
    } else {
      const prevLine = lines[idx - 1];
      const n = cfgDefPattern.exec(prevLine);
      if (n) {
        caseInfoList.push({ name: caseName, cfgDef: `[${n[1]}]` });
      } else {
        caseInfoList.push({ name: caseName, cfgDef: 'default' });
      }
    }
  }

  return caseInfoList;
}

// ── Regression list generation ────────────────────────────────────

/**
 * Generate regression list lines in CSV format.
 *
 * Output format (each line):
 *   ON, {block}, {case}, rand, 1, [{tag}], H, default, {cfg_def}, {base}
 *
 * - Case names and cfg_def values are padded to align columns
 * - When `base` is empty, the base column is omitted
 * - When `tag` is empty, `[]` is used
 *
 * Ported from Python `RegressionList.gen_regr_lst()`.
 */
function genRegrList(
  caseInfoList: CaseInfoEntry[],
  block: string,
  base: string | undefined,
  tag: string | undefined,
): string[] {
  const maxCaseLen = Math.max(...caseInfoList.map((c) => c.name.length), 0);
  const maxCfgLen = Math.max(...caseInfoList.map((c) => c.cfgDef.length), 0);

  const tagStr = tag ? `[${tag}]` : '[]';

  return caseInfoList.map(({ name, cfgDef }) => {
    const caseStr = name.padEnd(maxCaseLen);
    const cfgStr = cfgDef.padEnd(maxCfgLen);

    if (base) {
      return `ON, ${block}, ${caseStr}, rand, 1, ${tagStr}, H, default, ${cfgStr}, ${base} \n`;
    }
    return `ON, ${block}, ${caseStr}, rand, 1, ${tagStr}, H, default, ${cfgStr} \n`;
  });
}

/**
 * Generate a regression list file from the given configuration.
 *
 * This is the main entry point — reads the case cfg file, parses cases,
 * generates the regression list, and writes it to the output path.
 *
 * Replaces the previous `python gen_regr_list.py` subprocess approach
 * with a native TypeScript implementation.
 */
export async function generateRegressionList(config: RegressionListConfig): Promise<GenResult> {
  const logs: string[] = [];

  if (!config.cfg) {
    return { success: false, logs, errorMessage: '未指定配置文件路径 (-cfg)' };
  }

  if (!existsSync(config.cfg)) {
    return { success: false, logs, errorMessage: `配置文件不存在: ${config.cfg}` };
  }

  if (!config.block) {
    return { success: false, logs, errorMessage: '未指定环境 block (-block)' };
  }

  try {
    // Step 1: Read and parse the case cfg file
    logs.push(`读取配置文件: ${config.cfg}`);
    const content = await readFile(config.cfg, 'utf-8');
    const caseInfoList = parseCaseCfg(content);

    if (caseInfoList.length === 0) {
      return {
        success: false,
        logs,
        errorMessage: '配置文件中未找到有效的用例（所有用例可能是 base case 或 compile_lib）',
      };
    }

    logs.push(`解析到 ${caseInfoList.length} 个用例`);

    // Step 2: Generate regression list lines
    const lines = genRegrList(caseInfoList, config.block, config.base || undefined, config.tag || undefined);
    logs.push(`生成 ${lines.length} 行回归列表`);

    // Step 3: Determine output file path
    const outputRaw = config.output || '.';
    const outputFile = outputRaw.endsWith('.lst') || outputRaw.endsWith('.list')
      ? outputRaw
      : join(outputRaw, 'regr.lst');

    // Step 4: Write to file
    const header = '// on/off, block, case, seed, iterative, tag, priority, config, CFG_DEF, env base, plusargs\n';
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, header + lines.join(''), 'utf-8');
    logs.push(`回归列表已写入: ${outputFile}`);

    return { success: true, logs, output: outputFile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs.push(`错误: ${message}`);
    return { success: false, logs, errorMessage: message };
  }
}

// ── Command preview ───────────────────────────────────────────────

/**
 * Build a human-readable command preview string.
 *
 * Note: this is for display only — the actual execution uses
 * `generateRegressionList()` natively, not a shell command.
 */
export function buildCommand(config: RegressionListConfig): string {
  const parts: string[] = ['regression-list-gen'];

  if (config.cfg) parts.push(`-cfg "${config.cfg}"`);
  if (config.block) parts.push(`-block ${config.block}`);
  if (config.base) parts.push(`-base ${config.base}`);
  if (config.tag) parts.push(`-tag ${config.tag}`);
  if (config.output) parts.push(`-o "${config.output}"`);
  if (config.otherOptions) parts.push(config.otherOptions);

  return parts.join(' ');
}

// ── History management ─────────────────────────────────────────────

const HISTORY_DIR = join(homedir(), '.socverify');
const HISTORY_FILE = join(HISTORY_DIR, 'regression-list-gen-config.json');

const EMPTY_CONFIG: RegressionListConfig = {
  block: '',
  base: '',
  tag: '',
  cfg: '',
  output: '',
  otherOptions: '',
};

/** Load history from the config file. */
export async function loadHistory(): Promise<HistoryFile> {
  if (!existsSync(HISTORY_FILE)) {
    return { history: [], current: EMPTY_CONFIG };
  }

  try {
    const content = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(content) as HistoryFile;
  } catch {
    return { history: [], current: EMPTY_CONFIG };
  }
}

/** Save history to the config file. */
export async function saveHistory(config: RegressionListConfig): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });

  const existing = await loadHistory();
  const history = existing.history;

  // Check for duplicate
  const dupIndex = history.findIndex(
    (h) =>
      h.block === config.block &&
      h.base === config.base &&
      h.tag === config.tag &&
      h.cfg === config.cfg &&
      h.output === config.output,
  );

  if (dupIndex >= 0) {
    history.splice(dupIndex, 1);
  }

  // Add to front
  const entry: HistoryEntry = {
    ...config,
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
  };
  history.unshift(entry);

  // Limit to 10 entries
  if (history.length > 10) {
    history.splice(10);
  }

  const data: HistoryFile = { history, current: config };
  await writeFile(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/** Save current config (without adding to history). */
export async function saveConfig(config: RegressionListConfig): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });

  const existing = await loadHistory();
  const data: HistoryFile = { history: existing.history, current: config };
  await writeFile(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
