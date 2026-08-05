/**
 * Violation Router — tRPC API
 *
 * 参考 docs/timing-violation-handoff.md §4.4
 *
 * Procedures:
 *   - parseLog:         解析单个日志文件
 *   - queryViolations:  分页查询违例列表
 *   - getStatistics:    获取统计信息
 *   - getMetadata:      获取元数据
 *   - getDatabaseStats: 获取数据库整体统计
 *   - clearCaseData:    清除用例数据
 *   - pickFile:         弹出文件选择对话框
 *   - exportViolations: 导出违例数据为 Excel/CSV
 */

import { dialog, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { t, TRPCError } from '../router-context';
import { getTvDb } from '../../timing-violation/db/tv-db-cache';
import { loadTvConfig, ensureExportDir } from '../../timing-violation/tv-config';
import {
  insertViolations,
  ensureConfirmationRecords,
  queryViolations,
  getStatistics,
  getMetadata,
  getDatabaseStats,
  clearCaseData,
  clearAllData,
  updateCorner,
} from '../../timing-violation/db/tv-repository';
import { parseLogStream } from '../../timing-violation/parser/vio-parser';
import type { ParsedViolation, ParseOptions } from '../../timing-violation/types';
import { exportViolationsToExcel, exportViolationsToCsv } from '../../timing-violation/export/tv-exporter';
import { applyHistoricalConfirmations } from '../../timing-violation/confirm/confirmation-manager';
import { requireProject, ensurePluginsLoaded } from '../../services/project-service';
import { pluginLoader } from '../../plugins/loader';
import { simulationRegistry } from '../../simulation/simulation-registry';
import { caseStatsRegistry } from '../../case/case-stats-registry';
import type { CaseStatsService } from '../../case/case-stats-service';
import type {
  QueryViolationsInput,
  ConfirmationStatus,
  ParseLogInput,
  ViolationStatistics,
  ViolationMetadata,
} from '../../timing-violation/types';

// ─── 排序字段白名单 ───────────────────────────────────────────

const VALID_SORT_FIELDS = ['time_fs', 'num', 'hier', 'created_at'] as const;
const VALID_STATUSES = ['pending', 'confirmed', 'ignored'] as const;

// ─── 辅助函数 ─────────────────────────────────────────────────

/**
 * 获取或创建指定项目的 CaseStatsService。
 * 用于从用例树（discovery service）获取 case→subsys 映射。
 */
async function getCaseStatsServiceForTv(projectId: string): Promise<CaseStatsService | null> {
  try {
    const project = requireProject(projectId);
    await ensurePluginsLoaded(project.rootPath);
    const registry = pluginLoader.getRegistry(project.rootPath);
    if (registry.subsysDiscoverers.length === 0 || registry.caseParsers.length === 0) return null;
    const simManager = simulationRegistry.get(project.rootPath);
    return caseStatsRegistry.getOrCreate(project.rootPath, registry, simManager);
  } catch {
    return null;
  }
}

/**
 * 当违例数据中存在 subsys 为空的记录时，
 * 通过用例树（discovery service）的 case→subsys 映射补充子系统信息。
 *
 * 场景：用户上传的 vio_summary.log 路径中不含子系统目录名，
 * 但左侧用例树中有完整的 case→subsys 关联。
 */
async function enrichSubsysFromDiscovery(
  db: ReturnType<typeof getTvDb>,
  stats: ViolationStatistics,
  projectId: string,
  caseName?: string,
  corner?: string,
): Promise<ViolationStatistics> {
  // 没有未知 subsys 的违例，直接返回
  const unknownCount = stats.bySubsys['unknown'] ?? 0;
  if (unknownCount === 0) return stats;

  const service = await getCaseStatsServiceForTv(projectId);
  if (!service) return stats;

  // 构建 caseName → subsys 映射
  const caseToSubsys = await service.getCaseToSubsysMap();
  if (caseToSubsys.size === 0) return stats;

  // 查询 subsys 为空的违例，按 case_name 分组计数
  const conditions: string[] = ['v.subsys IS NULL'];
  const params: Record<string, unknown> = {};
  if (caseName) {
    conditions.push('v.case_name = @caseName');
    params.caseName = caseName;
  }
  if (corner) {
    conditions.push('v.corner = @corner');
    params.corner = corner;
  }

  const rows = db.prepare(`
    SELECT v.case_name as caseName, COUNT(*) as count
    FROM timing_violations v
    WHERE ${conditions.join(' AND ')}
    GROUP BY v.case_name
  `).all(params) as { caseName: string; count: number }[];

  // 重新计算 bySubsys
  const newBySubsys = { ...stats.bySubsys };
  newBySubsys['unknown'] = 0;

  let remainingUnknown = 0;
  for (const row of rows) {
    const matchedSubsys = caseToSubsys.get(row.caseName);
    if (matchedSubsys) {
      newBySubsys[matchedSubsys] = (newBySubsys[matchedSubsys] ?? 0) + row.count;
    } else {
      remainingUnknown += row.count;
    }
  }

  if (remainingUnknown > 0) {
    newBySubsys['unknown'] = remainingUnknown;
  } else {
    delete newBySubsys['unknown'];
  }

  return { ...stats, bySubsys: newBySubsys };
}

/**
 * 当违例数据中存在 subsys 为空的记录时，
 * 通过用例树（discovery service）的 case→subsys 映射补充子系统列表。
 *
 * 场景：用户上传的 vio_summary.log 路径中不含子系统目录名（如 *_sys），
 * 导致数据库中 subsys 列为 NULL，但左侧用例树中有完整的 case→subsys 关联。
 */
async function enrichMetadataSubsysFromDiscovery(
  db: ReturnType<typeof getTvDb>,
  metadata: ViolationMetadata,
  projectId: string,
): Promise<ViolationMetadata> {
  // 检查数据库中是否有 subsys 为 NULL 的记录
  const nullSubsysRow = db.prepare(`
    SELECT COUNT(*) as count FROM timing_violations WHERE subsys IS NULL
  `).get() as { count: number };

  if (nullSubsysRow.count === 0) return metadata;

  const service = await getCaseStatsServiceForTv(projectId);
  if (!service) return metadata;

  // 构建 caseName → subsys 映射
  const caseToSubsys = await service.getCaseToSubsysMap();
  if (caseToSubsys.size === 0) return metadata;

  // 查询 subsys 为空的违例中所有的 case_name
  const rows = db.prepare(`
    SELECT DISTINCT case_name FROM timing_violations WHERE subsys IS NULL
  `).all() as { case_name: string }[];

  // 通过 case_name 反查 subsys
  const discoveredSubsys = new Set<string>(metadata.subsys);
  for (const row of rows) {
    const matchedSubsys = caseToSubsys.get(row.case_name);
    if (matchedSubsys) {
      discoveredSubsys.add(matchedSubsys);
    }
  }

  return {
    ...metadata,
    subsys: Array.from(discoveredSubsys).sort(),
  };
}

// ─── Router ───────────────────────────────────────────────────

export const violationRouter = t.router({
  /**
   * 弹出文件选择对话框，选择 vio_summary.log。
   */
  pickFile: t.procedure
    .input((raw): { defaultPath?: string } => {
      const r = raw as Record<string, unknown>;
      return { defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined };
    })
    .mutation(async ({ input }) => {
      const result = await dialog.showOpenDialog({
        title: '选择 vio_summary.log 文件',
        defaultPath: input.defaultPath,
        properties: ['openFile'],
        filters: [{ name: 'Timing Violation Log', extensions: ['log'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const, filePath: null };
      }
      return { canceled: false as const, filePath: result.filePaths[0] };
    }),

  /**
   * 解析单个日志文件。
   * 在主进程中流式解析（readline 非阻塞），批量插入数据库。
   */
  parseLog: t.procedure
    .input((raw): { projectId: string } & ParseLogInput => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.filePath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return {
        projectId: r.projectId,
        filePath: r.filePath,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      const config = loadTvConfig(input.projectId);

      const parseOptions: ParseOptions = {
        caseName: input.caseName,
        corner: input.corner,
        corners: config.corners,
        subsysPatterns: config.subsysPatterns,
      };

      // 使用 parseLogStream 直接解析，支持实时进度推送
      const violations: ParsedViolation[] = [];
      let violationCount = 0;

      // 向所有窗口推送解析进度
      const sendProgress = (data: { filePath: string; processedLines: number; foundViolations: number }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('violation:parseProgress', data);
          }
        }
      };

      const result = await parseLogStream(
        input.filePath,
        parseOptions,
        (v: ParsedViolation) => {
          violations.push(v);
          violationCount++;
        },
        (lineCount: number) => {
          sendProgress({
            filePath: input.filePath,
            processedLines: lineCount,
            foundViolations: violationCount,
          });
        },
      );

      // 解析完成，推送最终进度
      sendProgress({
        filePath: input.filePath,
        processedLines: -1, // -1 表示解析完成
        foundViolations: violationCount,
      });

      const { inserted, skipped } = insertViolations(db, violations);
      ensureConfirmationRecords(db);

      // 自动应用历史确认 Pattern（对新插入的 pending 违例自动匹配已有 Pattern）
      const { appliedCount } = applyHistoricalConfirmations(db);

      return {
        success: true,
        total: violations.length,
        inserted,
        skipped,
        appliedHistorical: appliedCount,
        errors: result.errors,
      };
    }),

  /**
   * 分页查询违例列表。
   */
  queryViolations: t.procedure
    .input((raw): { projectId: string } & QueryViolationsInput => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const page = typeof r.page === 'number' && r.page > 0 ? r.page : 1;
      const pageSize = typeof r.pageSize === 'number' && r.pageSize > 0 ? Math.min(r.pageSize, 10000) : 50;

      const sortField = VALID_SORT_FIELDS.includes(r.sortField as typeof VALID_SORT_FIELDS[number])
        ? (r.sortField as typeof VALID_SORT_FIELDS[number])
        : undefined;
      const sortOrder = r.sortOrder === 'desc' ? 'desc' : 'asc';
      const status = VALID_STATUSES.includes(r.status as typeof VALID_STATUSES[number])
        ? (r.status as ConfirmationStatus)
        : undefined;

      return {
        projectId: r.projectId,
        page,
        pageSize,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
        status,
        subsys: typeof r.subsys === 'string' ? r.subsys : undefined,
        searchText: typeof r.searchText === 'string' ? r.searchText : undefined,
        sortField,
        sortOrder,
      };
    })
    .query(async ({ input }) => {
      const { projectId, ...queryInput } = input;
      const db = getTvDb(projectId);
      return queryViolations(db, queryInput);
    }),

  /**
   * 获取统计信息。
   */
  getStatistics: t.procedure
    .input((raw): { projectId: string; caseName?: string; corner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return {
        projectId: r.projectId,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      const stats = getStatistics(db, { caseName: input.caseName, corner: input.corner });
      // 当存在 subsys 为空的违例时，通过用例树补充子系统信息
      return enrichSubsysFromDiscovery(db, stats, input.projectId, input.caseName, input.corner);
    }),

  /**
   * 获取元数据（corners / cases / subsys 列表）。
   */
  getMetadata: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      const metadata = getMetadata(db);
      // 当存在 subsys 为空的违例时，通过用例树补充子系统列表
      return enrichMetadataSubsysFromDiscovery(db, metadata, input.projectId);
    }),

  /**
   * 获取数据库整体统计。
   */
  getDatabaseStats: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return getDatabaseStats(db);
    }),

  /**
   * 清除指定用例数据。
   */
  clearCaseData: t.procedure
    .input((raw): { projectId: string; caseName: string; corner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.caseName !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
      }
      return {
        projectId: r.projectId,
        caseName: r.caseName,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return clearCaseData(db, input.caseName, input.corner);
    }),

  /**
   * 清空所有违例数据（含确认记录，Pattern 保留）。
   */
  clearAllData: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return clearAllData(db);
    }),

  /**
   * 批量更新用例的 corner 信息。
   */
  updateCorner: t.procedure
    .input((raw): { projectId: string; caseName: string; newCorner: string; oldCorner?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.caseName !== 'string' || !r.caseName) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'caseName is required' });
      }
      if (typeof r.newCorner !== 'string' || !r.newCorner) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'newCorner is required' });
      }
      return {
        projectId: r.projectId,
        caseName: r.caseName,
        newCorner: r.newCorner,
        oldCorner: typeof r.oldCorner === 'string' && r.oldCorner ? r.oldCorner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      return updateCorner(db, input.caseName, input.newCorner, input.oldCorner);
    }),

  /**
   * 导出违例数据为 Excel 或 CSV 文件。
   * 支持按 caseName/corner 筛选导出。
   */
  exportViolations: t.procedure
    .input((raw): {
      projectId: string;
      format: 'excel' | 'csv';
      filePath?: string;
      caseName?: string;
      corner?: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const format = r.format === 'csv' ? 'csv' : 'excel';
      return {
        projectId: r.projectId,
        format,
        filePath: typeof r.filePath === 'string' ? r.filePath : undefined,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        corner: typeof r.corner === 'string' ? r.corner : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const db = getTvDb(input.projectId);
      const filter: { caseName?: string; corner?: string } = {};
      if (input.caseName) filter.caseName = input.caseName;
      if (input.corner) filter.corner = input.corner;

      // 如果没有指定路径，弹出保存对话框
      let filePath = input.filePath;
      if (!filePath) {
        const ext = input.format === 'excel' ? 'xlsx' : 'csv';

        // 默认导出目录: <dataDir>/exports/violations/<corner>/
        // 默认文件名: <caseName>_<corner>_violations_checklist.<ext>
        const project = requireProject(input.projectId);
        const config = loadTvConfig(project.rootPath);
        const cornerName = input.corner ?? 'default';
        const caseName = input.caseName ?? 'all_cases';
        const exportBase = ensureExportDir(project.rootPath, config.dataDir);
        const defaultDir = join(exportBase, 'violations', cornerName);
        mkdirSync(defaultDir, { recursive: true });
        const defaultName = `${caseName}_${cornerName}_violations_checklist.${ext}`;
        const defaultPath = join(defaultDir, defaultName);

        const result = await dialog.showSaveDialog({
          title: '导出违例数据',
          defaultPath,
          filters: [
            { name: input.format === 'excel' ? 'Excel' : 'CSV', extensions: [ext] },
            { name: '所有文件', extensions: ['*'] },
          ],
        });
        if (result.canceled || !result.filePath) {
          return { success: false as const, count: 0, canceled: true as const };
        }
        filePath = result.filePath;
      }

      if (input.format === 'excel') {
        const result = await exportViolationsToExcel(db, filePath, filter);
        return { success: true as const, count: result.count, filePath, canceled: false as const };
      } else {
        const result = exportViolationsToCsv(db, filePath, filter);
        return { success: true as const, count: result.count, filePath, canceled: false as const };
      }
    }),
});
