/**
 * Code Line Counter — counts lines in Verilog/SystemVerilog files.
 *
 * Ported from the Python `code_line_counter_plugin`.
 * Supports extension filtering, empty line / comment exclusion, and CSV export.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync, statSync } from 'node:fs';

/** Default Verilog file extensions. */
export const VERILOG_EXTENSIONS = ['.v', '.sv', '.svh', '.svi'];

/** Directories to exclude from scanning. */
const EXCLUDE_PATTERNS = ['.git', '__pycache__', '.svn', '.hg', 'node_modules', '.vscode'];

export type FileInfo = {
  path: string;
  lines: number;
  extension: string;
  size: number;
};

export type CountSummary = {
  totalFiles: number;
  totalLines: number;
  byExtension: Record<string, { files: number; lines: number }>;
  startTime: number;
  endTime: number;
};

export type CountResult = {
  files: FileInfo[];
  summary: CountSummary;
};

export type CountOptions = {
  extensions: string[];
  includeEmptyLines: boolean;
  includeComments: boolean;
};

/**
 * Count lines in a single file.
 */
async function countLines(
  filePath: string,
  includeEmptyLines: boolean,
  includeComments: boolean,
): Promise<number> {
  const content = await readFile(filePath, 'utf-8').catch(() => '');
  if (!content) return 0;

  const lines = content.split('\n');

  if (includeEmptyLines && includeComments) {
    return lines.length;
  }

  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();

    if (!includeEmptyLines && trimmed === '') continue;

    if (!includeComments) {
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('<!--')
      ) {
        continue;
      }
    }

    count++;
  }

  return count;
}

/** Check if a file should be included based on extension and path. */
function shouldIncludeFile(filePath: string, extensions: string[]): boolean {
  const ext = extname(filePath).toLowerCase();
  if (extensions.length > 0 && !extensions.includes(ext)) return false;

  for (const pattern of EXCLUDE_PATTERNS) {
    if (filePath.includes(pattern)) return false;
  }

  return true;
}

/** Recursively collect files matching the extension filter. */
async function collectFiles(
  path: string,
  extensions: string[],
  results: string[],
): Promise<void> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return;

  if (stats.isFile()) {
    if (shouldIncludeFile(path, extensions)) {
      results.push(path);
    }
    return;
  }

  if (stats.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await collectFiles(join(path, entry.name), extensions, results);
    }
  }
}

/**
 * Count lines in all matching files under the given paths.
 *
 * @param paths  File or directory paths to scan
 * @param options  Count options (extensions, empty lines, comments)
 * @param onProgress  Callback for progress updates
 */
export async function countCodeLines(
  paths: string[],
  options: CountOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<CountResult> {
  const startTime = Date.now();

  // Collect all files
  const allFiles: string[] = [];
  for (const path of paths) {
    if (existsSync(path)) {
      await collectFiles(path, options.extensions, allFiles);
    }
  }

  const total = allFiles.length;
  if (total === 0) {
    return {
      files: [],
      summary: {
        totalFiles: 0,
        totalLines: 0,
        byExtension: {},
        startTime,
        endTime: Date.now(),
      },
    };
  }

  const files: FileInfo[] = [];
  const byExtension: Record<string, { files: number; lines: number }> = {};
  let totalLines = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const filePath = allFiles[i];
    const lines = await countLines(
      filePath,
      options.includeEmptyLines,
      options.includeComments,
    );

    let ext = extname(filePath).toLowerCase();
    if (!ext) ext = '无扩展名';

    const size = statSync(filePath).size;

    files.push({ path: filePath, lines, extension: ext, size });
    totalLines += lines;

    if (!byExtension[ext]) {
      byExtension[ext] = { files: 0, lines: 0 };
    }
    byExtension[ext].files++;
    byExtension[ext].lines += lines;

    onProgress?.(i + 1, total);
  }

  return {
    files,
    summary: {
      totalFiles: allFiles.length,
      totalLines,
      byExtension,
      startTime,
      endTime: Date.now(),
    },
  };
}

/**
 * Export count results as CSV.
 */
export function exportCsv(result: CountResult): string {
  const lines: string[] = [];

  lines.push('文件路径,行数,文件类型,文件大小(字节)');
  for (const file of result.files) {
    lines.push(`${file.path},${file.lines},${file.extension},${file.size}`);
  }

  lines.push('');
  lines.push('汇总信息');
  lines.push(`总文件数,${result.summary.totalFiles}`);
  lines.push(`总行数,${result.summary.totalLines}`);
  lines.push('');
  lines.push('文件类型,文件数,行数');
  for (const [ext, stats] of Object.entries(result.summary.byExtension)) {
    lines.push(`${ext},${stats.files},${stats.lines}`);
  }

  return lines.join('\n');
}
