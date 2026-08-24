/**
 * TV Operations — 导出 / 导入纯函数。
 *
 * 从原 timing-violation.ts 中提取的导出/导入操作。
 * 这些操作无持久状态，组件直接调用，自行管理 loading。
 */

import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';

// ── 跨 store 引用（延迟 import 避免循环） ──────────────────────
// importPatterns / mergeDatabases 完成后需要刷新 patterns 列表和违例列表
import { useTvDataStore } from './tv-data';
import { useTvPatternsStore } from './tv-patterns';

export async function exportViolations(
  projectId: string,
  format: 'excel' | 'csv',
  caseName?: string,
  corner?: string,
): Promise<void> {
  try {
    const result = await trpc.violation.exportViolations.mutate({
      projectId,
      format,
      caseName,
      corner,
    });
    if (result.canceled) return;
    getToast().success(`导出完成：${result.count} 条违例数据`);
  } catch (err) {
    getToast().error('导出违例数据失败', err instanceof Error ? err.message : String(err));
  }
}

export async function exportPatterns(
  projectId: string,
  format: 'excel' | 'csv' | 'db',
): Promise<void> {
  try {
    const result = await trpc.pattern.exportPatterns.mutate({
      projectId,
      format,
    });
    if (result.canceled) return;
    getToast().success(`导出完成：${result.count} 条 Pattern`);
  } catch (err) {
    getToast().error('导出 Pattern 失败', err instanceof Error ? err.message : String(err));
  }
}

export async function importPatterns(projectId: string): Promise<void> {
  try {
    const result = await trpc.pattern.importPatterns.mutate({
      projectId,
    });
    if (result.canceled) return;
    getToast().success(`导入完成：新增 ${result.importedCount} 条，更新 ${result.updatedCount} 条`);
    await useTvPatternsStore.getState().loadPatterns(projectId);
  } catch (err) {
    getToast().error('导入 Pattern 失败', err instanceof Error ? err.message : String(err));
  }
}

export async function mergeDatabases(projectId: string, sourceFilePaths: string[]): Promise<void> {
  try {
    const result = await trpc.pattern.mergeDatabases.mutate({
      projectId,
      sourceFilePaths,
      backup: true,
    });
    const msg = `合并完成：${result.mergedViolations} 条违例，${result.mergedPatterns} 条 Pattern`;
    if (result.backupPath) {
      getToast().success(msg, `已备份到: ${result.backupPath}`);
    } else {
      getToast().success(msg);
    }
    await useTvDataStore.getState().refreshAll(projectId);
    await useTvPatternsStore.getState().loadPatterns(projectId);
  } catch (err) {
    getToast().error('数据库合并失败', err instanceof Error ? err.message : String(err));
  }
}
