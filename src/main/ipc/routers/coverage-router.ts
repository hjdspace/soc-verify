/**
 * Coverage analysis router（ADR 0006 + 0007 + 0008）。
 *
 * 过程以 Coverage Merge Session 为生命周期单位（sessionId）。
 * 导入流程两步分离：平台运行 EDA 命令 → 插件解析文本报告。
 */

import { t, TRPCError, requireProject } from '../router-context';
import { CoverageManager } from '../../coverage/coverage-manager';
import { ClosureManager } from '../../coverage/closure-manager';
import { CoverageReportGenerator } from '../../coverage/coverage-report-generator';
import { pluginLoader } from '../../plugins/loader';
import { PluginBackedCoverage } from '../../host/plugin-discovery';
import { loadEdaConfig, saveEdaConfig, normalizeConfig } from '../../coverage/eda-config';
import type {
  EdaToolConfig,
  CoverageMetric,
  CoverageGap,
  CoverageSummary,
  CoverageDelta,
  TriageCause,
  TriageConfidence,
  ExclusionStatus,
} from '@shared/types';
import { DEFAULT_COVERAGE_TARGETS, COVERAGE_METRICS } from '@shared/types';

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
      const mgr = buildClosureManager(project.rootPath);
      return mgr.startClosure({
        sessionId: input.sessionId,
        gaps: input.gaps,
        maxRounds: input.maxRounds,
      });
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
