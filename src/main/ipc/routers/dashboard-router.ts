/**
 * Dashboard router — subsystem list, layout persistence.
 *
 * ADR 0019: Dashboard 数据源切换为 Case Database。
 * 废弃 getMetrics（从 sim-history.json 读取），所有查询走 CaseDatabase。
 * 本 issue（01）仅实现 getSubsysList + 保留 saveLayout/getLayout。
 * 后续 issue 逐个添加 getTrend / getSubsysHeatmap / 等聚合查询。
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { caseStatsRegistry } from '../../case/case-stats-registry';
import { getSubsysList } from '../../case/db/case-repository';

// ─── 共享筛选参数验证 ───────────────────────────────────────

type DashboardFilter = {
  projectId: string;
  subsys?: string;
  timeRange?: 'all' | '7d' | '30d' | { start: string; end: string };
};

function validateFilter(raw: unknown): DashboardFilter {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  const filter: DashboardFilter = { projectId: r.projectId };
  if (typeof r.subsys === 'string' && r.subsys.length > 0) {
    filter.subsys = r.subsys;
  }
  if (r.timeRange !== undefined) {
    if (typeof r.timeRange === 'string' && ['all', '7d', '30d'].includes(r.timeRange)) {
      filter.timeRange = r.timeRange as 'all' | '7d' | '30d';
    } else if (typeof r.timeRange === 'object' && r.timeRange !== null) {
      const tr = r.timeRange as Record<string, unknown>;
      if (typeof tr.start === 'string' && typeof tr.end === 'string') {
        filter.timeRange = { start: tr.start, end: tr.end };
      }
    }
  }
  return filter;
}

export const dashboardRouter = t.router({
  // ─── 子系统列表（下拉筛选） ──────────────────────────────
  getSubsysList: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      const db = caseStatsRegistry.getOrCreateDb(project.rootPath);
      return getSubsysList(db);
    }),

  // ─── 布局持久化 ──────────────────────────────────────────
  saveLayout: t.procedure
    .input((raw): { projectId: string; layout: unknown } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId, layout: r.layout };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const layoutPath = join(project.rootPath, '.socverify', 'dashboard-layout.json');
      await mkdir(join(project.rootPath, '.socverify'), { recursive: true });
      await writeFile(layoutPath, JSON.stringify(input.layout, null, 2), 'utf-8');
      return { ok: true };
    }),

  getLayout: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      const layoutPath = join(project.rootPath, '.socverify', 'dashboard-layout.json');
      try {
        const data = await readFile(layoutPath, 'utf-8');
        return JSON.parse(data);
      } catch {
        return null;
      }
    }),
});

// Export filter type + validator for reuse in future procedures
export type { DashboardFilter };
export { validateFilter };
