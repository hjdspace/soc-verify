/**
 * Find & Replace — search and replace text in files.
 *
 * Ported from the Python `find_and_replace` plugin.
 * Supports plain text and regex search, file extension filtering,
 * and undo via history stack.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export type SearchMatch = {
  filePath: string;
  line: number;
  context: string[];
  matchedLine: number; // line number within context that matched
};

export type ReplaceRecord = {
  filePath: string;
  originalContent: string;
  newContent: string;
};

// ── Undo history (per session) ─────────────────────────────────────
// Stored in memory; cleared when the tool window closes.
const replaceHistory: ReplaceRecord[][] = [];

/**
 * Search for text in files under a directory.
 *
 * @param directory  Root directory to search
 * @param searchText  Text or regex pattern to search for
 * @param useRegex  Whether to treat searchText as a regex
 * @param extensions  File extensions to include (e.g., ['.v', '.sv'])
 */
export async function searchText(
  directory: string,
  searchText: string,
  useRegex: boolean,
  extensions: string[],
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const regex = useRegex ? new RegExp(searchText) : null;

  await walkDir(directory, extensions, async (filePath) => {
    const content = await readFile(filePath, 'utf-8').catch(() => null);
    if (content === null) return;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const isMatch = regex ? regex.test(line) : line.includes(searchText);

      if (isMatch) {
        const contextStart = Math.max(0, i - 3);
        const contextEnd = Math.min(lines.length, i + 4);
        const context = lines.slice(contextStart, contextEnd);

        matches.push({
          filePath,
          line: lineNum,
          context,
          matchedLine: i - contextStart,
        });
      }
    }
  });

  return matches;
}

/**
 * Replace text in files under a directory.
 * Stores original content for undo.
 *
 * @returns  Number of files modified.
 */
export async function replaceText(
  directory: string,
  searchText: string,
  replaceText: string,
  useRegex: boolean,
  extensions: string[],
): Promise<number> {
  const replacements: ReplaceRecord[] = [];
  const regex = useRegex ? new RegExp(searchText, 'g') : null;

  await walkDir(directory, extensions, async (filePath) => {
    const content = await readFile(filePath, 'utf-8').catch(() => null);
    if (content === null) return;

    const newContent = regex
      ? content.replace(regex, replaceText)
      : content.split(searchText).join(replaceText);

    if (newContent !== content) {
      replacements.push({ filePath, originalContent: content, newContent });
    }
  });

  // Execute replacements
  for (const { filePath, newContent } of replacements) {
    await writeFile(filePath, newContent, 'utf-8');
  }

  if (replacements.length > 0) {
    replaceHistory.push(replacements);
  }

  return replacements.length;
}

/**
 * Undo the last replace operation.
 *
 * @returns  Number of files restored.
 */
export async function undoLastReplace(): Promise<number> {
  const last = replaceHistory.pop();
  if (!last) return 0;

  let count = 0;
  for (const { filePath, originalContent } of last) {
    await writeFile(filePath, originalContent, 'utf-8');
    count++;
  }

  return count;
}

/** Check if there are any replace operations to undo. */
export function canUndo(): boolean {
  return replaceHistory.length > 0;
}

// ── Helper: walk directory and call callback for each matching file ──

async function walkDir(
  dir: string,
  extensions: string[],
  callback: (filePath: string) => Promise<void>,
): Promise<void> {
  if (!existsSync(dir)) return;

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, extensions, callback);
    } else if (entry.isFile()) {
      if (extensions.length === 0 || extensions.some((ext) => entry.name.endsWith(ext))) {
        await callback(fullPath);
      }
    }
  }
}
