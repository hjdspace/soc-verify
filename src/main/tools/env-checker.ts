/**
 * Environment Checker — scans Verilog/SystemVerilog files for `force` and
 * `wait` statements, supports adding confirmation comments, and exporting
 * HTML reports.
 *
 * Ported from the Python `env_checker_one_touch` plugin.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';

// ── Regex patterns (ported from Python) ────────────────────────────

// Matches `force` keyword (but not in comments). Also matches special
// force macros like `sprd_hld_force` and `uvm_hld_force`.
const FORCE_PATTERN = /(?!\/\/.*)(\bforce\b|sprd_hld_force|uvm_hld_force)/;
const WAIT_PATTERN = /(?!\/\/.*)\bwait\b/;

/** Environment variable pattern for expanding $VAR and ${VAR} in filter files. */
const ENV_VAR_PATTERN = /\$\{([^}]+)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Supported file extensions for scanning (without dot, matching Python's split('.').pop()). */
const SCAN_EXTENSIONS = new Set(['v', 'sv', 'svi', 'svh']);

// ── Types ──────────────────────────────────────────────────────────

export type CheckType = 'force' | 'wait';

export type ScanMatch = {
  line: number;
  statement: string;
};

export type FileResult = {
  path: string;
  count: number;
  lines: ScanMatch[];
};

export type ScanResult = {
  force: FileResult[];
  wait: FileResult[];
};

export type SubsystemInfo = {
  name: string;
  path: string;
};

export type PreviewLine = {
  lineNo: number;
  content: string;
  isMatch: boolean;
};

export type PreviewSection = {
  matchLine: number;
  lines: PreviewLine[];
};

export type PreviewResult = {
  filePath: string;
  sections: PreviewSection[];
};

// ── Encoding-safe file reading ─────────────────────────────────────

/**
 * Read a file as a string, handling encoding errors gracefully.
 * Matches Python's `open(file_path, 'r', errors='ignore')` behavior:
 * invalid UTF-8 byte sequences are removed rather than replaced.
 */
async function readFileText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  // toString('utf-8') replaces invalid sequences with \uFFFD; remove them
  // to match Python's errors='ignore' behavior.
  return buffer.toString('utf-8').replace(/\uFFFD/g, '');
}

/** Expand environment variables ($VAR / ${VAR}) in a path string. */
function expandEnvVars(path: string): string {
  return path.replace(ENV_VAR_PATTERN, (_match, brace, plain) => {
    const varName = brace || plain;
    return process.env[varName] ?? '';
  });
}

// ── Core scanning logic ────────────────────────────────────────────

/**
 * Scan a single Verilog file for force/wait statements.
 *
 * Handles multi-line statements (statements spanning multiple lines before `;`),
 * skips block comments (`/* ... *\/`) and line comments (`//`).
 */
async function scanFile(
  filePath: string,
): Promise<{ force: ScanMatch[]; wait: ScanMatch[] }> {
  let content: string;
  try {
    content = await readFileText(filePath);
  } catch {
    return { force: [], wait: [] };
  }
  if (!content) return { force: [], wait: [] };

  const forceMatches: ScanMatch[] = [];
  const waitMatches: ScanMatch[] = [];

  const lines = content.split('\n');
  let inBlockComment = false;
  let statementBuffer = '';
  let statementStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Handle block comments
    if (line.includes('/*') && !line.includes('*/')) {
      inBlockComment = true;
    }
    if (line.includes('*/')) {
      inBlockComment = false;
      if (!line.includes('/*')) continue;
    }
    if (inBlockComment) continue;

    // Skip line comments and empty lines
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed === '') continue;

    // Build statement buffer
    if (!statementBuffer) {
      statementStartLine = lineNum;
    }
    statementBuffer += ' ' + trimmed;

    // If statement not complete (no semicolon), continue to next line
    if (!line.includes(';')) continue;

    // Statement is complete — check for patterns
    if (FORCE_PATTERN.test(statementBuffer) && !statementBuffer.includes('FORCE_CHECK')) {
      forceMatches.push({
        line: statementStartLine,
        statement: statementBuffer.trim(),
      });
    }

    if (WAIT_PATTERN.test(statementBuffer) && !statementBuffer.includes('WAIT_CHECK')) {
      waitMatches.push({
        line: statementStartLine,
        statement: statementBuffer.trim(),
      });
    }

    // Reset statement buffer
    statementBuffer = '';
  }

  return { force: forceMatches, wait: waitMatches };
}

/**
 * Scan a subsystem directory for force/wait statements.
 *
 * @param projectRoot  Project root path
 * @param subsys  Subsystem name (e.g., `cpu_sys`)
 * @param filters  Filter file paths to exclude (confirmed files)
 * @param onProgress  Callback for progress updates (0-100)
 * @returns  Scan results grouped by check type
 */
export async function scanSubsys(
  projectRoot: string,
  subsys: string,
  filters: { force: Set<string>; wait: Set<string> } = { force: new Set(), wait: new Set() },
  onProgress?: (current: number, total: number) => void,
): Promise<ScanResult> {
  // Collect check paths
  const checkPaths = [
    join(projectRoot, subsys),
    join(projectRoot, 'udtb', subsys),
  ];

  // Special subsystems also check usvp
  const specialSubsys = new Set([
    'apcpu_sys', 'ch_sys', 'sp_sys', 'aon_sys',
    'spch_sys', 'ps_cp_sys', 'phy_cp_sys',
  ]);
  if (specialSubsys.has(subsys)) {
    checkPaths.push(join(projectRoot, 'udtb', 'usvp'));
  }

  // Collect all files to scan
  const allFiles: string[] = [];
  for (const checkPath of checkPaths) {
    if (!existsSync(checkPath)) continue;
    await collectFiles(checkPath, allFiles);
  }

  const total = allFiles.length;
  if (total === 0) return { force: [], wait: [] };

  const forceResults: FileResult[] = [];
  const waitResults: FileResult[] = [];

  // Scan files sequentially (can be parallelized later if needed)
  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    const relPath = relative(projectRoot, filePath);

    const { force, wait } = await scanFile(filePath);

    if (force.length > 0 && !filters.force.has(relPath)) {
      forceResults.push({
        path: filePath,
        count: force.length,
        lines: force,
      });
    }

    if (wait.length > 0 && !filters.wait.has(relPath)) {
      waitResults.push({
        path: filePath,
        count: wait.length,
        lines: wait,
      });
    }

    onProgress?.(i + 1, total);
  }

  return { force: forceResults, wait: waitResults };
}

/**
 * Recursively collect files with supported extensions.
 * Uses `name.split('.').pop()` to match Python's `f.split('.')[-1]` behavior
 * exactly (including edge cases like hidden files).
 */
async function collectFiles(dir: string, results: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, results);
    } else if (entry.isFile()) {
      // Match Python's `f.split('.')[-1] in ('v', 'sv', 'svi', 'svh')` exactly.
      // This is case-sensitive (no toLowerCase) and uses split('.').pop()
      // which handles edge cases like hidden files differently from extname().
      const ext = entry.name.split('.').pop() ?? '';
      if (SCAN_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
}

/**
 * Discover subsystem directories in a project.
 * Looks for directories ending with `_sys` or named `top`.
 */
export async function discoverSubsystems(
  projectRoot: string,
): Promise<SubsystemInfo[]> {
  const entries = await readdir(projectRoot, { withFileTypes: true }).catch(() => []);
  const subsystems: SubsystemInfo[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name.endsWith('_sys') || entry.name === 'top')) {
      subsystems.push({
        name: entry.name,
        path: join(projectRoot, entry.name),
      });
    }
  }

  return subsystems.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load filter files for a subsystem.
 * Filter files have extensions `.force_filter` and `.wait.filter`.
 * Environment variables in filter entries are expanded (matching Python behavior).
 */
export async function loadFilters(
  projectRoot: string,
  subsys: string,
): Promise<{ force: Set<string>; wait: Set<string> }> {
  const force = new Set<string>();
  const wait = new Set<string>();

  const filterDirs = [
    join(projectRoot, subsys, 'env_checker'),
    join(projectRoot, 'udtb', subsys, 'env_checker'),
  ];

  for (const dir of filterDirs) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      const filePath = join(dir, file);
      let content: string;
      try {
        content = await readFileText(filePath);
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Expand environment variables (matching Python's expand_env_vars)
        const expanded = expandEnvVars(trimmed);
        if (file.endsWith('.force_filter')) {
          force.add(expanded);
        } else if (file.endsWith('.wait.filter')) {
          wait.add(expanded);
        }
      }
    }
  }

  return { force, wait };
}

/**
 * Add a confirmation comment (FORCE_CHECK / WAIT_CHECK) to matching
 * statements in a file.
 *
 * @param filePath  File to modify
 * @param checkType  'force' or 'wait'
 * @param comment  Optional confirmation message (e.g., "Confirmed by xxx")
 */
export async function addCheckComment(
  filePath: string,
  checkType: CheckType,
  comment = '',
): Promise<boolean> {
  let content: string;
  try {
    content = await readFileText(filePath);
  } catch {
    return false;
  }

  const lines = content.split('\n');
  let modified = false;
  let inBlockComment = false;
  let statementBuffer = '';
  let statementLines: number[] = [];

  const pattern = checkType === 'force' ? FORCE_PATTERN : WAIT_PATTERN;
  const checkTag = checkType === 'force' ? 'FORCE_CHECK' : 'WAIT_CHECK';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle block comments
    if (line.includes('/*') && !line.includes('*/')) {
      inBlockComment = true;
    }
    if (line.includes('*/')) {
      inBlockComment = false;
      if (!line.includes('/*')) continue;
    }
    if (inBlockComment) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed === '') continue;

    statementBuffer += ' ' + trimmed;
    statementLines.push(i);

    if (!line.includes(';')) continue;

    if (pattern.test(statementBuffer) && !statementBuffer.includes(checkTag)) {
      const lastIdx = statementLines[statementLines.length - 1];
      const suffix = comment ? ` // ${checkTag}(${comment})` : ` // ${checkTag}`;
      lines[lastIdx] = lines[lastIdx].replace(/\n?$/, '') + suffix + '\n';
      modified = true;
    }

    statementBuffer = '';
    statementLines = [];
  }

  if (modified) {
    await writeFile(filePath, lines.join('\n'), 'utf-8');
  }

  return modified;
}

/**
 * Read a file and return preview sections with context lines around each match.
 *
 * @param filePath  File to read
 * @param matches  Match line numbers and statements
 * @param contextBefore  Number of lines before each match (default 3)
 * @param contextAfter  Number of lines after each match (default 2)
 */
export async function readFileWithContext(
  filePath: string,
  matches: ScanMatch[],
  contextBefore = 3,
  contextAfter = 2,
): Promise<PreviewResult> {
  let content: string;
  try {
    content = await readFileText(filePath);
  } catch {
    return { filePath, sections: [] };
  }

  const lines = content.split('\n');
  const matchLineNumbers = new Set(matches.map((m) => m.line));

  const sections: PreviewSection[] = [];

  for (const match of matches) {
    const start = Math.max(0, match.line - 1 - contextBefore);
    const end = Math.min(lines.length, match.line + contextAfter);

    const sectionLines: PreviewLine[] = [];
    for (let i = start; i < end; i++) {
      sectionLines.push({
        lineNo: i + 1,
        content: lines[i] ?? '',
        isMatch: matchLineNumbers.has(i + 1),
      });
    }

    sections.push({
      matchLine: match.line,
      lines: sectionLines,
    });
  }

  return { filePath, sections };
}

// ── $PROJ_ENV resolution ───────────────────────────────────────────

const SOCVERIFY_DIR = '.socverify';
const ENV_CONFIG_FILE = 'env.json';

/**
 * Resolve $PROJ_ENV from process.env, falling back to .socverify/env.json.
 * Matches the pattern used by git-quick-pull and git-manager.
 */
export function resolveProjEnv(projectDir: string): string | null {
  const envVal = process.env.PROJ_ENV;
  if (envVal && envVal.trim()) return envVal.trim();

  try {
    const configPath = join(projectDir, SOCVERIFY_DIR, ENV_CONFIG_FILE);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      envVars?: Record<string, string>;
    };
    const configured = config?.envVars?.PROJ_ENV;
    if (typeof configured === 'string' && configured.trim()) {
      return configured.trim();
    }
  } catch {
    // Config file not found or invalid
  }

  return null;
}

/**
 * Generate an HTML report of scan results.
 */
export function generateReport(
  subsys: string,
  results: ScanResult,
): string {
  const forceRows = results.force
    .map((r) => `      <tr><td>${escapeHtml(r.path)}</td><td>${r.count}</td></tr>`)
    .join('\n');
  const waitRows = results.wait
    .map((r) => `      <tr><td>${escapeHtml(r.path)}</td><td>${r.count}</td></tr>`)
    .join('\n');

  const now = new Date().toLocaleString('zh-CN');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>验证环境检查报告</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1, h2 { color: #333; }
    .section { margin-bottom: 30px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
    tr:nth-child(even) { background-color: #f9f9f9; }
  </style>
</head>
<body>
  <h1>验证环境检查报告</h1>
  <p>子系统: ${escapeHtml(subsys)}</p>
  <p>生成时间: ${now}</p>
  <div class="section">
    <h2>Force语句检查 (${results.force.length}个文件)</h2>
    <table>
      <tr><th>文件</th><th>问题数量</th></tr>
${forceRows}
    </table>
  </div>
  <div class="section">
    <h2>Wait语句检查 (${results.wait.length}个文件)</h2>
    <table>
      <tr><th>文件</th><th>问题数量</th></tr>
${waitRows}
    </table>
  </div>
</body>
</html>`;
}

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
