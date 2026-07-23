/**
 * Coverage analysis router（ADR 0006 + 0007 + 0008 + 0009）。
 *
 * 过程以 Coverage Merge Session 为生命周期单位（sessionId）。
 * 导入流程两步分离：平台运行 EDA 命令 → 插件解析文本报告。
 *
 * Slice 6b：集成 ClosureOrchestrator 驱动 AI Coverage Closure 闭环。
 * startClosure 触发 orchestrator 异步运行，通过 closure:event IPC 通道
 * 向渲染进程推送实时进度。abortClosure 同时中止 orchestrator。
 */

import { BrowserWindow, dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { t, TRPCError, requireProject } from '../router-context';
import { CoverageManager } from '../../coverage/coverage-manager';
import { ClosureManager } from '../../coverage/closure-manager';
import { ClosureOrchestrator, type ClosureEvent } from '../../coverage/closure-orchestrator';
import { TestPromoter } from '../../coverage/test-promoter';
import { CoverageReportGenerator } from '../../coverage/coverage-report-generator';
import {
  generateHtmlReport,
  generateJsonExport,
  generateDeltaHtmlReport,
  generateCompareJsonExport,
  resolveExportScope,
  type ExportScope,
  type ExportFormat,
} from '../../coverage/coverage-exporter';
import { sessionManager } from '../../agent/session-manager';
import { credentialManager } from '../../credentials/credential-manager';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedCoverage } from '../../host/plugin-discovery';
import { PluginBackedDiscovery, PluginBackedSimulation } from '../../host/plugin-discovery';
import { loadEdaConfig, saveEdaConfig, normalizeConfig } from '../../coverage/eda-config';
import type {
  EdaToolConfig,
  CoverageMetric,
  CoverageGap,
  CoverageSummary,
  CoverageDelta,
  CoverageData,
  TriageCause,
  TriageConfidence,
  ExclusionStatus,
} from '@shared/types';
import {
  DEFAULT_COVERAGE_TARGETS,
  COVERAGE_METRICS,
  summarizeCoverage,
  calculateDelta,
} from '@shared/types';

/**
 * 每个项目的 ClosureOrchestrator 实例缓存（projectId → orchestrator）。
 * 同一项目同时只允许一个活跃的 Closure 闭环。
 */
const orchestrators = new Map<string, ClosureOrchestrator>();

/**
 * 向所有 BrowserWindow 转发 Closure 事件（单用户桌面应用只有一个主窗口）。
 * 供 orchestrator 的 emit 回调使用。
 */
function emitClosureEvent(event: ClosureEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('closure:event', event);
    }
  }
}

function buildManager(projectRoot: string): CoverageManager {
  const registry = pluginLoader.getRegistry(projectRoot);
  const adapter = new PluginBackedCoverage(projectRoot, registry);
  const reportGenerator = new CoverageReportGenerator({ projectRoot });
  return new CoverageManager({
    projectRoot,
    coverageAdapter: adapter,
    reportGenerator,
  });
}

/** 构建 ClosureManager 实例（复用 buildManager 的 CoverageManager）。 */
function buildClosureManager(projectRoot: string): ClosureManager {
  return new ClosureManager({
    projectRoot,
    coverageManager: buildManager(projectRoot),
  });
}

/** 构建 TestPromoter 实例（复用 buildClosureManager 的 ClosureManager）。 */
function buildTestPromoter(projectRoot: string): TestPromoter {
  return new TestPromoter({
    projectRoot,
    closureManager: buildClosureManager(projectRoot),
  });
}

export const coverageRouter = t.router({
  // ─── 目录浏览（导入覆盖率时选择 cov_merge 目录） ────────────────

  browseDirectory: t.procedure
    .input((raw): { defaultPath?: string } => {
      const r = raw as Record<string, unknown>;
      return {
        defaultPath: typeof r.defaultPath === 'string' ? r.defaultPath : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择 cov_merge 目录',
        defaultPath: input.defaultPath,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const, path: null };
      }
      return { canceled: false as const, path: result.filePaths[0] };
    }),

  // ─── EDA Tool Configuration（ADR 0006） ──────────────────────

  getEdaConfig: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return loadEdaConfig(project.rootPath);
    }),

  setEdaConfig: t.procedure
    .input((raw): { projectId: string; config: EdaToolConfig } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const cfg = r.config as Record<string, unknown>;
      if (!cfg || typeof cfg.tool !== 'string' || typeof cfg.covMergeDir !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'config.tool and config.covMergeDir are required' });
      }
      return {
        projectId: r.projectId,
        config: {
          tool: cfg.tool as EdaToolConfig['tool'],
          covMergeDir: cfg.covMergeDir as string,
          summaryCommand: typeof cfg.summaryCommand === 'string' ? cfg.summaryCommand : undefined,
          detailCommand: typeof cfg.detailCommand === 'string' ? cfg.detailCommand : undefined,
          metricsCommand: typeof cfg.metricsCommand === 'string' ? cfg.metricsCommand : undefined,
        },
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      return saveEdaConfig(project.rootPath, normalizeConfig(input.config));
    }),

  // ─── 导入流程（ADR 0006 两步流水线） ─────────────────────────

  import: t.procedure
    .input((raw): { projectId: string; covMergeDir: string; edaConfig?: EdaToolConfig; targets?: Partial<Record<CoverageMetric, number>> } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.covMergeDir !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and covMergeDir are required' });
      }
      const edaConfig = r.edaConfig as EdaToolConfig | undefined;
      const targets = r.targets as Partial<Record<CoverageMetric, number>> | undefined;
      return {
        projectId: r.projectId,
        covMergeDir: r.covMergeDir,
        edaConfig: edaConfig && typeof edaConfig.tool === 'string' ? edaConfig : undefined,
        targets,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      // 未传 edaConfig 时从存储加载，仍无则用 imc 默认
      let edaConfig = input.edaConfig ?? (await loadEdaConfig(project.rootPath));
      if (!edaConfig) {
        edaConfig = normalizeConfig({ tool: 'imc', covMergeDir: input.covMergeDir });
      } else if (edaConfig.covMergeDir !== input.covMergeDir) {
        edaConfig = { ...edaConfig, covMergeDir: input.covMergeDir };
      }
      const targets = input.targets ?? { ...DEFAULT_COVERAGE_TARGETS };
      const result = await mgr.importCoverage(input.covMergeDir, edaConfig, targets);
      return {
        sessionId: result.sessionId,
        summary: (await mgr.getOverview(result.sessionId)).summary,
      };
    }),

  // ─── Session 生命周期（ADR 0008） ─────────────────────────────

  listSessions: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.listSessions();
    }),

  getSession: t.procedure
    .input((raw): { projectId: string; sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.getSession(input.sessionId);
    }),

  getOverview: t.procedure
    .input((raw): { projectId: string; sessionId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.getOverview(input.sessionId);
    }),

  getTree: t.procedure
    .input((raw): { projectId: string; sessionId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.getTree(input.sessionId);
    }),

  deleteSession: t.procedure
    .input((raw): { projectId: string; sessionId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      await mgr.deleteSession(input.sessionId);
      return { ok: true };
    }),

  getTrend: t.procedure
    .input((raw): { projectId: string; limit?: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, limit: typeof r.limit === 'number' ? r.limit : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.getTrend(input.limit);
    }),

  // ─── 报告导出（Slice 7 / Issue #9） ──────────────────────────
  //
  // 支持两种范围：
  //   - scope='current'：导出单个 session 的完整报告
  //   - scope='compare'：导出两个 session 之间的对比报告
  // 支持两种格式：
  //   - format='html'：独立 HTML 文件（内联 CSS，浏览器可直接打开）
  //   - format='json'：结构化 JSON（完整 Coverage Tree + 8 metric × Triplet + Target + Gap + Delta）
  // 异步执行：exporter 生成内容字符串 → fs/promises writeFile 写盘 → 返回 outputPath
  exportReport: t.procedure
    .input((raw): {
      projectId: string;
      scope: ExportScope;
      sessionId?: string;
      compareSessionId?: string;
      format: ExportFormat;
      outputPath: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.format !== 'string' || typeof r.outputPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, format and outputPath are required' });
      }
      if (r.format !== 'html' && r.format !== 'json') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid format: ${String(r.format)} (expected html|json)` });
      }
      const scope = r.scope === 'compare' ? 'compare' : 'current';
      const sessionId = typeof r.sessionId === 'string' ? r.sessionId : undefined;
      const compareSessionId = typeof r.compareSessionId === 'string' ? r.compareSessionId : undefined;
      // 范围选择校验（compare 必须有两个不同的 sessionId）
      try {
        resolveExportScope({ scope, sessionId, compareSessionId });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : 'Invalid export scope',
        });
      }
      return {
        projectId: r.projectId,
        scope,
        sessionId,
        compareSessionId,
        format: r.format as ExportFormat,
        outputPath: r.outputPath,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);

      if (input.scope === 'compare') {
        // 对比范围：获取两个 session 的完整 CoverageData，计算 delta 后生成对比报告
        const before = await mgr.getTree(input.sessionId);
        const after = await mgr.getTree(input.compareSessionId);
        const beforeSummary = summarizeCoverage(before.root);
        const afterSummary = summarizeCoverage(after.root);
        const deltas = calculateDelta(beforeSummary, afterSummary);
        const content = input.format === 'html'
          ? generateDeltaHtmlReport(before, after, deltas)
          : generateCompareJsonExport(before, after, deltas);
        await writeFile(input.outputPath, content, 'utf-8');
        return { outputPath: input.outputPath, scope: 'compare' as const, format: input.format };
      }

      // 当前范围：导出单个 session 的报告
      const data: CoverageData = await mgr.getTree(input.sessionId);
      const content = input.format === 'html'
        ? generateHtmlReport(data)
        : generateJsonExport(data);
      await writeFile(input.outputPath, content, 'utf-8');
      return { outputPath: input.outputPath, scope: 'current' as const, format: input.format, sessionId: data.sessionId };
    }),

  /**
   * 弹出原生保存对话框，让用户选择导出文件路径。
   * 根据 format 预设文件扩展名过滤器（.html / .json）。
   * 用户取消时返回 null（渲染端据此不执行导出）。
   */
  pickExportPath: t.procedure
    .input((raw): { format: ExportFormat; defaultName?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.format !== 'string' || (r.format !== 'html' && r.format !== 'json')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'format is required (html|json)' });
      }
      return {
        format: r.format as ExportFormat,
        defaultName: typeof r.defaultName === 'string' ? r.defaultName : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const ext = input.format === 'html' ? 'html' : 'json';
      const result = await dialog.showSaveDialog({
        title: input.format === 'html' ? '导出 HTML 报告' : '导出 JSON 报告',
        defaultPath: input.defaultName ?? `coverage-report.${ext}`,
        filters: [
          { name: input.format === 'html' ? 'HTML 报告' : 'JSON 数据', extensions: [ext] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { outputPath: null };
      return { outputPath: result.filePath };
    }),

  // ─── Slice 2: Target / Gap / Delta / Triage / Exclusion ──────

  getTarget: t.procedure
    .input((raw): { projectId: string; sessionId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.getTargets(input.sessionId);
    }),

  setTarget: t.procedure
    .input((raw): { projectId: string; sessionId: string; targets: Partial<Record<CoverageMetric, number>> } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      const targets = parseTargets(r.targets);
      return { projectId: r.projectId, sessionId: r.sessionId, targets };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.setTargets(input.sessionId, input.targets);
    }),

  listGaps: t.procedure
    .input((raw): { projectId: string; sessionId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.listGaps(input.sessionId);
    }),

  getDelta: t.procedure
    .input((raw): { projectId: string; sessionIdBefore: string; sessionIdAfter: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionIdBefore !== 'string' || typeof r.sessionIdAfter !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, sessionIdBefore and sessionIdAfter are required' });
      }
      return { projectId: r.projectId, sessionIdBefore: r.sessionIdBefore, sessionIdAfter: r.sessionIdAfter };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.getDelta(input.sessionIdBefore, input.sessionIdAfter);
    }),

  addTriage: t.procedure
    .input((raw): { projectId: string; sessionId: string; nodePath: string; metric: CoverageMetric; gap: CoverageGap; cause?: TriageCause; confidence?: TriageConfidence; note?: string; triagedBy?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string' || typeof r.nodePath !== 'string' || typeof r.metric !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, sessionId, nodePath and metric are required' });
      }
      if (!COVERAGE_METRICS.includes(r.metric as CoverageMetric)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid metric: ${String(r.metric)}` });
      }
      const gap = r.gap as Record<string, unknown> | undefined;
      if (!gap || typeof gap.nodePath !== 'string' || typeof gap.metric !== 'string' || typeof gap.target !== 'number' || typeof gap.actual !== 'number' || typeof gap.deficit !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'gap with nodePath, metric, target, actual, deficit is required' });
      }
      return {
        projectId: r.projectId,
        sessionId: r.sessionId,
        nodePath: r.nodePath,
        metric: r.metric as CoverageMetric,
        gap: gap as unknown as CoverageGap,
        cause: typeof r.cause === 'string' ? (r.cause as TriageCause) : undefined,
        confidence: typeof r.confidence === 'string' ? (r.confidence as TriageConfidence) : undefined,
        note: typeof r.note === 'string' ? r.note : undefined,
        triagedBy: typeof r.triagedBy === 'string' ? r.triagedBy : undefined,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.addTriage(input);
    }),

  listTriage: t.procedure
    .input((raw): { projectId: string; sessionId?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.listTriage(input.sessionId);
    }),

  deleteTriage: t.procedure
    .input((raw): { projectId: string; id: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.id !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and id are required' });
      }
      return { projectId: r.projectId, id: r.id };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      await mgr.deleteTriage(input.id);
      return { ok: true };
    }),

  requestExclusion: t.procedure
    .input((raw): { projectId: string; sessionId: string; nodePath: string; metric: CoverageMetric; reason: string; requestedBy: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string' || typeof r.nodePath !== 'string' || typeof r.metric !== 'string' || typeof r.reason !== 'string' || typeof r.requestedBy !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, sessionId, nodePath, metric, reason and requestedBy are required' });
      }
      if (!COVERAGE_METRICS.includes(r.metric as CoverageMetric)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid metric: ${String(r.metric)}` });
      }
      return {
        projectId: r.projectId,
        sessionId: r.sessionId,
        nodePath: r.nodePath,
        metric: r.metric as CoverageMetric,
        reason: r.reason,
        requestedBy: r.requestedBy,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.requestExclusion(input);
    }),

  approveExclusion: t.procedure
    .input((raw): { projectId: string; id: string; approver: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.id !== 'string' || typeof r.approver !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, id and approver are required' });
      }
      return { projectId: r.projectId, id: r.id, approver: r.approver };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.approveExclusion(input.id, input.approver);
    }),

  rejectExclusion: t.procedure
    .input((raw): { projectId: string; id: string; approver: string; reason: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.id !== 'string' || typeof r.approver !== 'string' || typeof r.reason !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, id, approver and reason are required' });
      }
      return { projectId: r.projectId, id: r.id, approver: r.approver, reason: r.reason };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.rejectExclusion(input.id, input.approver, input.reason);
    }),

  listExclusions: t.procedure
    .input((raw): { projectId: string; sessionId?: string; status?: ExclusionStatus } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      const status = typeof r.status === 'string' ? (r.status as ExclusionStatus) : undefined;
      if (status && !['pending', 'approved', 'rejected'].includes(status)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Invalid status: ${status}` });
      }
      return {
        projectId: r.projectId,
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
        status,
      };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.listExclusions(input.sessionId, input.status);
    }),

  // ─── Coverage Closure（ADR 0009 Slice 6a） ───────────────────

  startClosure: t.procedure
    .input((raw): { projectId: string; sessionId: string; gaps?: CoverageGap[]; maxRounds?: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and sessionId are required' });
      }
      const gaps = Array.isArray(r.gaps) ? (r.gaps as CoverageGap[]) : undefined;
      const maxRounds = typeof r.maxRounds === 'number' ? r.maxRounds : undefined;
      return { projectId: r.projectId, sessionId: r.sessionId, gaps, maxRounds };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);

      // 若已有 orchestrator 在运行，拒绝重复启动
      const existing = orchestrators.get(input.projectId);
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: '该项目已有一个活跃的 Closure 闭环，请先中止后再启动新的闭环',
        });
      }

      const coverageManager = buildManager(project.rootPath);
      const closureManager = new ClosureManager({
        projectRoot: project.rootPath,
        coverageManager,
      });

      // 1. 创建 ClosureSession（持久化 gap 列表 + workspace 目录）
      const session = await closureManager.startClosure({
        sessionId: input.sessionId,
        gaps: input.gaps,
        maxRounds: input.maxRounds,
      });

      // 2. 构建 orchestrator 依赖
      const registry = pluginLoader.getRegistry(project.rootPath);
      const discovery = new PluginBackedDiscovery(project.rootPath, registry);
      const simulationAdapter = new PluginBackedSimulation(registry);
      const coverageAdapter = new PluginBackedCoverage(project.rootPath, registry);

      // 3. 加载凭据
      const agentEnv = await credentialManager.buildEnvForAgent();
      const defaultCred = await credentialManager.getDefaultCredential();
      const provider = defaultCred
        ? credentialManager.mapProviderForAgent(defaultCred.providerId)
        : undefined;
      const apiKey = defaultCred?.apiKey;
      const baseUrl = defaultCred?.baseUrl;

      // 4. 创建 orchestrator 并启动（fire-and-forget，通过事件流推送状态）
      const orchestrator = new ClosureOrchestrator({
        sessionManager,
        coverageManager,
        closureManager,
        projectId: input.projectId,
        discovery,
        simulationAdapter,
        coverageAdapter,
        agentEnv,
        provider,
        apiKey,
        baseUrl,
        emit: emitClosureEvent,
      });
      orchestrators.set(input.projectId, orchestrator);

      // 启动闭环（异步，不阻塞 response）
      void orchestrator.startClosure(session).catch((err) => {
        console.error(`[closure] orchestrator failed: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        // 闭环结束后清理 orchestrator 缓存
        orchestrators.delete(input.projectId);
      });

      return session;
    }),

  getClosure: t.procedure
    .input((raw): { projectId: string; closureId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and closureId are required' });
      }
      return { projectId: r.projectId, closureId: r.closureId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildClosureManager(project.rootPath);
      return mgr.getClosure(input.closureId);
    }),

  listClosures: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildClosureManager(project.rootPath);
      return mgr.listClosures();
    }),

  abortClosure: t.procedure
    .input((raw): { projectId: string; closureId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and closureId are required' });
      }
      return { projectId: r.projectId, closureId: r.closureId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildClosureManager(project.rootPath);

      // 先中止 orchestrator（触发 AbortController，等待 Gap 循环退出）
      const orchestrator = orchestrators.get(input.projectId);
      if (orchestrator) {
        await orchestrator.abort(input.closureId);
        orchestrators.delete(input.projectId);
      }

      // 再调用 closureManager 标记状态
      await mgr.abortClosure(input.closureId);
      return { ok: true };
    }),

  completeIteration: t.procedure
    .input((raw): {
      projectId: string;
      closureId: string;
      gapId: string;
      generatedTests: string[];
      deltaBefore: CoverageSummary;
      deltaAfter: CoverageSummary;
      deltas: CoverageDelta[];
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string' || typeof r.gapId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, closureId and gapId are required' });
      }
      const generatedTests = Array.isArray(r.generatedTests) ? (r.generatedTests as string[]) : [];
      const deltaBefore = r.deltaBefore as CoverageSummary;
      const deltaAfter = r.deltaAfter as CoverageSummary;
      const deltas = Array.isArray(r.deltas) ? (r.deltas as CoverageDelta[]) : [];
      if (!deltaBefore || typeof deltaBefore.overall !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'deltaBefore with overall is required' });
      }
      if (!deltaAfter || typeof deltaAfter.overall !== 'number') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'deltaAfter with overall is required' });
      }
      return {
        projectId: r.projectId,
        closureId: r.closureId,
        gapId: r.gapId,
        generatedTests,
        deltaBefore,
        deltaAfter,
        deltas,
      };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildClosureManager(project.rootPath);
      return mgr.completeIteration(input.closureId, input.gapId, {
        generatedTests: input.generatedTests,
        deltaBefore: input.deltaBefore,
        deltaAfter: input.deltaAfter,
        deltas: input.deltas,
      });
    }),

  // ─── Test Promotion（ADR 0009 决策 10 / Slice 8） ───────────
  //
  // Closure 结束后，Closure Workspace 中的测试改动进入审阅队列。
  // 用户通过 Diff Review 审阅每个测试改动，决定接受（提升到正式目录）或拒绝（丢弃）。
  // promoteTests 执行复制，getClosureSummary 展示结果摘要，cleanupClosure 清理临时目录。

  /** 扫描 Closure Workspace，返回 Test Promotion 审阅队列 */
  getPromotionQueue: t.procedure
    .input((raw): { projectId: string; closureId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and closureId are required' });
      }
      return { projectId: r.projectId, closureId: r.closureId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const promoter = buildTestPromoter(project.rootPath);
      return promoter.getPromotionQueue(input.closureId);
    }),

  /** 执行 Test Promotion：接受的复制到正式目录，拒绝的丢弃 */
  promoteTests: t.procedure
    .input((raw): {
      projectId: string;
      closureId: string;
      accepted: string[];
      rejected: string[];
      targetDir?: string;
    } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and closureId are required' });
      }
      const accepted = Array.isArray(r.accepted) ? (r.accepted as string[]).filter((s) => typeof s === 'string') : [];
      const rejected = Array.isArray(r.rejected) ? (r.rejected as string[]).filter((s) => typeof s === 'string') : [];
      const targetDir = typeof r.targetDir === 'string' ? r.targetDir : undefined;
      return { projectId: r.projectId, closureId: r.closureId, accepted, rejected, targetDir };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const promoter = buildTestPromoter(project.rootPath);
      return promoter.promoteTests(
        input.closureId,
        input.accepted,
        input.rejected,
        input.targetDir,
      );
    }),

  /** 获取 Closure 闭环结果摘要（Gap 状态 / Delta 总量 / 提升计数） */
  getClosureSummary: t.procedure
    .input((raw): { projectId: string; closureId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and closureId are required' });
      }
      return { projectId: r.projectId, closureId: r.closureId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const promoter = buildTestPromoter(project.rootPath);
      return promoter.getClosureSummary(input.closureId);
    }),

  /** 清理 Closure Workspace 临时目录 */
  cleanupClosure: t.procedure
    .input((raw): { projectId: string; closureId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.closureId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and closureId are required' });
      }
      return { projectId: r.projectId, closureId: r.closureId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const promoter = buildTestPromoter(project.rootPath);
      return promoter.cleanupClosure(input.closureId);
    }),
});

/**
 * 将 unknown 解析为 Partial<Record<CoverageMetric, number>>。
 * 只保留键为合法 CoverageMetric、值为有限数字的项；其余丢弃。
 */
function parseTargets(raw: unknown): Partial<Record<CoverageMetric, number>> {
  if (!raw || typeof raw !== 'object') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'targets must be an object' });
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<Record<CoverageMetric, number>> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!COVERAGE_METRICS.includes(key as CoverageMetric)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key as CoverageMetric] = value;
  }
  return out;
}
