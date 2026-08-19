/**
 * 多目录 system prompt 构造器。
 *
 * 当项目有 extraDirs 时，自动构造一段目录说明追加到 systemPrompt：
 * - 列出所有验证分组目录（含 rootPath）
 * - 列出所有设计分组目录
 * - 标记当前 cwd 目录
 * - 告知 AI 其他目录请使用绝对路径访问
 *
 * 无 extraDirs 时返回 null（不修改原始 systemPrompt）。
 */

import type { ProjectInfo } from '@shared/types';

/**
 * 构造多目录说明文本，追加到用户的 systemPrompt 后面。
 *
 * @param project 项目信息（含 extraDirs）
 * @param userSystemPrompt 用户原始 systemPrompt（可为空）
 * @returns 追加了多目录说明的完整 systemPrompt；无 extraDirs 时返回 null
 */
export function buildMultiDirSystemPrompt(
  project: ProjectInfo,
  userSystemPrompt: string,
): string | null {
  const dirs = project.extraDirs ?? [];
  if (dirs.length === 0) return null;

  const verifyDirs = dirs
    .filter((d) => d.group === 'verify')
    .sort((a, b) => a.order - b.order);
  const designDirs = dirs
    .filter((d) => d.group === 'design')
    .sort((a, b) => a.order - b.order);

  // Determine cwd path: the dir with isCwd=true, or rootPath as implicit cwd
  const cwdDir = dirs.find((d) => d.isCwd);
  const cwdPath = cwdDir?.path ?? project.rootPath;

  const lines: string[] = [];

  lines.push('## 项目目录结构');
  lines.push('');
  lines.push('当前项目包含以下目录，你可以通过绝对路径访问任意目录中的文件：');
  lines.push('');

  // Verify group
  lines.push('### 验证目录');
  lines.push(`- ${formatDirLine(project.rootPath, undefined, project.rootPath === cwdPath)}`);
  for (const dir of verifyDirs) {
    lines.push(`- ${formatDirLine(dir.path, dir.label, dir.isCwd)}`);
  }

  // Design group (only if there are design dirs)
  if (designDirs.length > 0) {
    lines.push('');
    lines.push('### 设计目录');
    for (const dir of designDirs) {
      lines.push(`- ${formatDirLine(dir.path, dir.label, dir.isCwd)}`);
    }
  }

  lines.push('');
  lines.push(`当前工作目录（cwd）: ${cwdPath}`);
  lines.push('');
  lines.push('提示：非 cwd 目录的文件请使用绝对路径进行读取和编辑操作。');

  const multiDirSection = lines.join('\n');

  if (userSystemPrompt) {
    return `${userSystemPrompt}\n\n${multiDirSection}`;
  }
  return multiDirSection;
}

/**
 * 格式化单个目录行。
 * 格式: `路径 [cwd]` 或 `标签 (路径) [cwd]`
 */
function formatDirLine(path: string, label: string | undefined, isCwd: boolean): string {
  const cwdTag = isCwd ? ' [cwd]' : '';
  if (label) {
    return `${label} (${path})${cwdTag}`;
  }
  return `${path}${cwdTag}`;
}
