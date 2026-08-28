/**
 * SCM 文件 diff：解析 git unified diff 输出为结构化 hunks/lines，
 * 以及未跟踪文件的全量新增 diff 构建。
 *
 * 只读展示用（人工审查），不承担 diff-review 域的 tool call 归属/撤销语义。
 */

import type { ScmDiffHunk, ScmDiffLine, ScmFileDiff } from '@shared/types';

export type ParseUnifiedDiffOptions = {
  path: string;
  staged: boolean;
};

/**
 * 解析单个文件的 `git diff --unified=3` 输出。
 * 空字符串（无变更）返回空 hunks；二进制文件标记 isBinary；
 * 遇到第二个文件的 diff 头即停止（防御多文件输入）。
 */
export function parseUnifiedDiff(diffText: string, options: ParseUnifiedDiffOptions): ScmFileDiff {
  const lines = diffText.split('\n');
  const hunks: ScmDiffHunk[] = [];
  let isNewFile = false;
  let isDeleted = false;
  let isBinary = false;

  let current: ScmDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      // 第二个文件的 diff 开始——单文件查询不该出现，防御性截断
      if (hunks.length > 0 || current) break;
      continue;
    }
    if (line.startsWith('--- ')) {
      isNewFile = line.slice(4).trim() === '/dev/null';
      continue;
    }
    if (line.startsWith('+++ ')) {
      isDeleted = line.slice(4).trim() === '/dev/null';
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      isBinary = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const parsed = parseHunkHeader(line);
      if (!parsed) continue;
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // 头部元信息行（index/mode 等）
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1), newLine });
      newLine += 1;
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', content: line.slice(1), oldLine });
      oldLine += 1;
    } else if (line.startsWith(' ') || line === '') {
      // 上下文行以空格前缀；diff 末尾的空行也是上下文
      current.lines.push({ type: 'ctx', content: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
    // 其他前缀（理论上不出现）跳过
  }

  const allLines = hunks.flatMap((h) => h.lines);
  return {
    path: options.path,
    staged: options.staged,
    isNewFile,
    isDeleted,
    isBinary,
    hunks,
    totalAdd: allLines.filter((l) => l.type === 'add').length,
    totalDel: allLines.filter((l) => l.type === 'del').length,
  };
}

function parseHunkHeader(header: string): { oldStart: number; newStart: number } | null {
  const match = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

/** 未跟踪文件：整个文件内容都是新增行（git diff 对 untracked 无输出）。 */
export function buildUntrackedFileDiff(path: string, content: string): ScmFileDiff {
  const normalized = content.replace(/\r\n?/g, '\n');
  // 去掉末尾换行产生的空尾行；文件中间的空行仍是有效内容
  const contentLines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  const lines: ScmDiffLine[] = normalized === ''
    ? []
    : contentLines.map((text, index) => ({ type: 'add' as const, content: text, newLine: index + 1 }));

  return {
    path,
    staged: false,
    isNewFile: true,
    isDeleted: false,
    isBinary: false,
    hunks: lines.length > 0 ? [{ header: '@@ -0,0 +1,' + lines.length + ' @@', lines }] : [],
    totalAdd: lines.length,
    totalDel: 0,
  };
}
