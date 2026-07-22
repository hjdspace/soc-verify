/**
 * Coverage analysis router（ADR 0006 + 0007 + 0008）。
 *
 * 过程以 Coverage Merge Session 为生命周期单位（sessionId）。
 * 导入流程两步分离：平台运行 EDA 命令 → 插件解析文本报告。
 */

import { t, TRPCError, requireProject } from '../router-context';
import { CoverageManager } from '../../coverage/coverage-manager';
import { CoverageReportGenerator } from '../../coverage/coverage-report-generator';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedCoverage } from '../../host/plugin-discovery';
import { loadEdaConfig, saveEdaConfig, normalizeConfig } from '../../coverage/eda-config';
import type { EdaToolConfig, CoverageMetric } from '@shared/types';
import { DEFAULT_COVERAGE_TARGETS } from '@shared/types';

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

export const coverageRouter = t.router({
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

  exportReport: t.procedure
    .input((raw): { projectId: string; sessionId: string; format: 'html' | 'json'; outputPath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.sessionId !== 'string' || typeof r.format !== 'string' || typeof r.outputPath !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, sessionId, format and outputPath are required' });
      }
      return { projectId: r.projectId, sessionId: r.sessionId, format: r.format as 'html' | 'json', outputPath: r.outputPath };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const mgr = buildManager(project.rootPath);
      return mgr.exportReport(input.sessionId, input.format, input.outputPath);
    }),
});
