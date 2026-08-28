/**
 * Case Cfg Router — 自定义用例 cfg 文件管理 tRPC router。
 *
 * 提供：
 * - scanEnv: 扫描 $PROJ_ENV 下的子系统目录
 * - loadFromEnv: 选中子系统 → 发现 .cfg 文件 → 解析 → 持久化 → 返回用例树
 * - loadFiles: 用户文件选择 → 解析 → 持久化 → 返回用例树
 * - removeFile: 从持久化列表中移除文件
 * - refresh: 重新解析所有已加载文件（自动清理不存在的文件）
 * - getLoadedFiles: 返回已持久化的文件及解析后的用例树
 *
 * 持久化路径：{projectRoot}/.socverify/case-cfg-files.json
 * 参考 to-router.ts 的持久化模式。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import {
  scanSubsystems,
  discoverCaseCfgFiles,
  discoverUdtbDirs,
  discoverUdtbCfgFiles,
  parseCaseCfgFile,
  type CaseFileData,
  type SubsysInfo,
  type UdtbDirInfo,
} from '../../case/case-cfg-manager';

// ── Persistence helpers ────────────────────────────────────────────

function getPersistPath(projectRoot: string): string {
  return join(projectRoot, '.socverify', 'case-cfg-files.json');
}

type PersistedData = {
  files: string[];
};

async function loadPersistedFiles(projectRoot: string): Promise<string[]> {
  const persistPath = getPersistPath(projectRoot);
  if (!existsSync(persistPath)) return [];
  try {
    const content = await readFile(persistPath, 'utf-8');
    const data = JSON.parse(content) as PersistedData;
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return [];
  }
}

async function savePersistedFiles(projectRoot: string, files: string[]): Promise<void> {
  const persistPath = getPersistPath(projectRoot);
  await mkdir(join(projectRoot, '.socverify'), { recursive: true });
  const data: PersistedData = { files };
  await writeFile(persistPath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Router ────────────────────────────────────────────────────────

export const caseCfgRouter = t.router({
  /**
   * 扫描 $PROJ_ENV 下的子系统目录。
   *
   * 返回以 `_sys` 结尾或名为 `top` 的目录列表。
   * 前端用于弹出子系统选择对话框（多选）。
   */
  scanEnv: t.procedure
    .input((raw): { projectId: string; projEnv: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.projEnv !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projEnv is required' });
      }
      return { projectId: r.projectId, projEnv: r.projEnv };
    })
    .query(async ({ input }): Promise<SubsysInfo[]> => {
      return scanSubsystems(input.projEnv);
    }),

  /**
   * 扫描 udtb/{subsys} 目录下所有包含 bin/ 的子目录。
   *
   * 返回相对路径和完整路径列表，前端用于弹出二级弹窗
   * 让用户选择 ip2soc/block 级别的 UDTB 子目录。
   *
   * 如果 udtb/{subsys} 目录不存在，返回空数组（前端跳过二级弹窗）。
   */
  scanUdtbDirs: t.procedure
    .input((raw): { projectId: string; projEnv: string; subsys: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.projEnv !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projEnv is required' });
      }
      if (typeof r.subsys !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsys is required' });
      }
      return { projectId: r.projectId, projEnv: r.projEnv, subsys: r.subsys };
    })
    .query(async ({ input }): Promise<UdtbDirInfo[]> => {
      return discoverUdtbDirs(input.projEnv, input.subsys);
    }),

  /**
   * 从选中的子系统和 UDTB 子目录发现 .cfg 文件，解析并持久化。
   *
   * 合并已持久化的文件列表（去重），更新持久化文件，
   * 返回所有已加载文件的解析结果（用例树）。
   *
   * udtbDirs 为用户在二级弹窗中选中的 UDTB 子目录完整路径列表。
   * 如果某子系统没有 UDTB 目录，对应的 udtbDirs 为空数组。
   */
  loadFromEnv: t.procedure
    .input((raw): {
      projectId: string;
      projEnv: string;
      subsystems: string[];
      udtbDirs: string[];
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.projEnv !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projEnv is required' });
      }
      if (!Array.isArray(r.subsystems)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'subsystems is required' });
      }
      if (!Array.isArray(r.udtbDirs)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'udtbDirs is required' });
      }
      return {
        projectId: r.projectId,
        projEnv: r.projEnv,
        subsystems: r.subsystems as string[],
        udtbDirs: r.udtbDirs as string[],
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Discover standard cfg files from selected subsystems
      const standardFiles = await discoverCaseCfgFiles(input.projEnv, input.subsystems);

      // Discover cfg files from selected UDTB subdirectories
      const udtbFiles = await discoverUdtbCfgFiles(input.udtbDirs);

      const newFiles = [...standardFiles, ...udtbFiles];

      // Merge with existing persisted files (dedup)
      const existing = await loadPersistedFiles(project.rootPath);
      const merged = [...new Set([...existing, ...newFiles])];
      await savePersistedFiles(project.rootPath, merged);

      // Parse all files
      const files = await parseAllFiles(merged);

      return { files };
    }),

  /**
   * 解析用户选择的文件路径列表，持久化并返回用例树。
   *
   * 合并已持久化的文件列表（去重）。
   */
  loadFiles: t.procedure
    .input((raw): { projectId: string; filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (!Array.isArray(r.filePaths)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePaths is required' });
      }
      return {
        projectId: r.projectId,
        filePaths: r.filePaths as string[],
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      // Merge with existing persisted files (dedup)
      const existing = await loadPersistedFiles(project.rootPath);
      const merged = [...new Set([...existing, ...input.filePaths])];
      await savePersistedFiles(project.rootPath, merged);

      // Parse all files
      const files = await parseAllFiles(merged);

      return { files };
    }),

  /**
   * 从持久化列表中移除一个文件。
   */
  removeFile: t.procedure
    .input((raw): { projectId: string; filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.filePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { projectId: r.projectId, filePath: r.filePath };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      const existing = await loadPersistedFiles(project.rootPath);
      const filtered = existing.filter((f) => f !== input.filePath);
      await savePersistedFiles(project.rootPath, filtered);

      const files = await parseAllFiles(filtered);
      return { files };
    }),

  /**
   * 重新解析所有已持久化的文件。
   *
   * 自动清理不存在的文件（验证 + 清理无效数据），
   * 参考 Python `case_model.validate_and_clean_files`。
   */
  refresh: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      const existing = await loadPersistedFiles(project.rootPath);
      // Filter out non-existent files
      const valid = existing.filter((f) => existsSync(f));
      if (valid.length !== existing.length) {
        await savePersistedFiles(project.rootPath, valid);
      }

      const files = await parseAllFiles(valid);
      return { files };
    }),

  /**
   * 返回已持久化的文件列表及解析后的用例树。
   *
   * 项目打开时前端调用此 procedure 恢复上次加载的文件。
   */
  getLoadedFiles: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);

      const files = await loadPersistedFiles(project.rootPath);
      const parsed = await parseAllFiles(files);

      return { files: parsed };
    }),
});

// ─── Shared helper ────────────────────────────────────────────────

/**
 * Parse all files, skipping ones that fail to parse.
 * Returns empty array if input is empty.
 */
async function parseAllFiles(filePaths: string[]): Promise<CaseFileData[]> {
  const results: CaseFileData[] = [];
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    try {
      const data = await parseCaseCfgFile(filePath);
      results.push(data);
    } catch (err) {
      console.warn(`[case-cfg-router] Failed to parse ${filePath}:`, err);
    }
  }
  return results;
}
