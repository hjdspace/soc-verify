/**
 * SV Ifdef Checker — SystemVerilog `ifdef/`endif matching checker.
 *
 * Ported from the Python `sv_ifdef_checker` plugin (`models.py`).
 * Features: scan SV files, check ifdef/ifndef/endif balance,
 * report unmatched directives and summary statistics.
 */

import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type UnmatchedIfdef = {
  type: 'ifdef' | 'ifndef';
  condition: string;
  line: number;
  content: string;
};

export type UnmatchedEndif = {
  line: number;
  content: string;
};

export type CheckResult = {
  filePath: string;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  inlineMatches: number;
  unmatchedIfdef: UnmatchedIfdef[];
  unmatchedEndif: UnmatchedEndif[];
  isBalanced: boolean;
  errorMessage: string | null;
};

export type CheckSummary = {
  totalFiles: number;
  balancedFiles: number;
  unbalancedFiles: number;
  errorFiles: number;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  totalInline: number;
};

// ── Regex patterns (match the Python originals) ─────────────────────

const ifdefPattern = /`(ifdef|ifndef)\s+(\w+)/i;
const endifPattern = /`endif/i;
const inlinePattern = /`(ifdef|ifndef)\s+(\w+).*?`endif/gi;

// ── Core logic ─────────────────────────────────────────────────────

/** Check a single SV file for ifdef/endif balance. */
export async function checkFile(filePath: string): Promise<CheckResult> {
  const result: CheckResult = {
    filePath,
    totalIfdef: 0,
    totalIfndef: 0,
    totalEndif: 0,
    inlineMatches: 0,
    unmatchedIfdef: [],
    unmatchedEndif: [],
    isBalanced: true,
    errorMessage: null,
  };

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (e) {
    result.errorMessage = `读取文件失败: ${e instanceof Error ? e.message : String(e)}`;
    result.isBalanced = false;
    return result;
  }

  const lines = content.split('\n');
  const ifdefStack: UnmatchedIfdef[] = [];
  let inBlockComment = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const originalLine = lines[lineIdx];
    const lineNum = lineIdx + 1;
    let line = originalLine.trim();

    // Handle block comments
    if (line.includes('/*') && line.includes('*/')) {
      // Same-line block comment, remove it
      const start = line.indexOf('/*');
      const end = line.indexOf('*/', start);
      if (end !== -1) {
        line = (line.substring(0, start) + line.substring(end + 2)).trim();
      }
    } else if (line.includes('/*')) {
      inBlockComment = true;
      line = line.substring(0, line.indexOf('/*')).trim();
    } else if (line.includes('*/') && inBlockComment) {
      inBlockComment = false;
      line = line.substring(line.indexOf('*/') + 2).trim();
    } else if (inBlockComment) {
      continue;
    }

    // Skip empty lines and single-line comments
    if (!line || line.startsWith('//')) continue;

    // Remove trailing line comments
    const commentPos = line.indexOf('//');
    if (commentPos !== -1) {
      line = line.substring(0, commentPos).trim();
      if (!line) continue;
    }

    // Check inline ifdef...endif (same line)
    const inlineMatches: RegExpMatchArray[] = [];
    let m: RegExpExecArray | null;
    const inlineRe = new RegExp(inlinePattern);
    while ((m = inlineRe.exec(line)) !== null) {
      inlineMatches.push(m);
    }
    if (inlineMatches.length > 0) {
      result.inlineMatches += inlineMatches.length;
      for (const match of inlineMatches) {
        const directive = match[1].toLowerCase();
        if (directive === 'ifdef') {
          result.totalIfdef += 1;
        } else {
          result.totalIfndef += 1;
        }
        result.totalEndif += 1;
      }
      continue;
    }

    // Check ifdef/ifndef
    const ifdefMatch = ifdefPattern.exec(line);
    if (ifdefMatch) {
      const directive = ifdefMatch[1].toLowerCase() as 'ifdef' | 'ifndef';
      const condition = ifdefMatch[2];
      ifdefStack.push({
        type: directive,
        condition,
        line: lineNum,
        content: originalLine.trim(),
      });
      if (directive === 'ifdef') {
        result.totalIfdef += 1;
      } else {
        result.totalIfndef += 1;
      }
      continue;
    }

    // Check endif
    if (endifPattern.test(line)) {
      result.totalEndif += 1;
      if (ifdefStack.length > 0) {
        ifdefStack.pop();
      } else {
        result.unmatchedEndif.push({
          line: lineNum,
          content: originalLine.trim(),
        });
      }
    }
  }

  // Remaining stack items are unmatched ifdef/ifndef
  result.unmatchedIfdef = ifdefStack;
  result.isBalanced =
    result.unmatchedIfdef.length === 0 && result.unmatchedEndif.length === 0;

  return result;
}

/** Scan a directory for SystemVerilog files. */
export function scanDirectory(
  directory: string,
  options?: { extensions?: string[]; recursive?: boolean },
): string[] {
  const extensions = options?.extensions ?? ['.sv', '.svi'];
  const recursive = options?.recursive ?? true;
  const svFiles: string[] = [];

  const scanDir = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && recursive) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          svFiles.push(fullPath);
        }
      }
    }
  };

  if (recursive) {
    scanDir(directory);
  } else {
    try {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            svFiles.push(join(directory, entry.name));
          }
        }
      }
    } catch {
      // Directory not accessible
    }
  }

  return svFiles.sort();
}

/** Check multiple files and return results + summary. */
export async function checkFiles(filePaths: string[]): Promise<{
  results: CheckResult[];
  summary: CheckSummary;
}> {
  const results: CheckResult[] = [];
  for (const fp of filePaths) {
    const result = await checkFile(fp);
    results.push(result);
  }

  const summary = buildSummary(results);
  return { results, summary };
}

/** Build summary statistics from check results. */
export function buildSummary(results: CheckResult[]): CheckSummary {
  if (results.length === 0) {
    return {
      totalFiles: 0,
      balancedFiles: 0,
      unbalancedFiles: 0,
      errorFiles: 0,
      totalIfdef: 0,
      totalIfndef: 0,
      totalEndif: 0,
      totalInline: 0,
    };
  }

  const totalFiles = results.length;
  const errorFiles = results.filter((r) => r.errorMessage).length;
  const balancedFiles = results.filter(
    (r) => r.isBalanced && !r.errorMessage,
  ).length;
  const unbalancedFiles = totalFiles - balancedFiles - errorFiles;

  return {
    totalFiles,
    balancedFiles,
    unbalancedFiles,
    errorFiles,
    totalIfdef: results.reduce((sum, r) => sum + r.totalIfdef, 0),
    totalIfndef: results.reduce((sum, r) => sum + r.totalIfndef, 0),
    totalEndif: results.reduce((sum, r) => sum + r.totalEndif, 0),
    totalInline: results.reduce((sum, r) => sum + r.inlineMatches, 0),
  };
}
