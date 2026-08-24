// @vitest-environment jsdom
/**
 * Coverage Store 拆分后的跨 store 关键路径测试。
 *
 * 验证 4 个子 store 之间的跨 store 通信：
 * - coverage-core.loadTree → 更新 coverage-gaps.targets（通过 setTargetsState）
 * - coverage-core.deleteSession → 清空 coverage-gaps 数据（通过 clearSessionData）
 * - coverage-export.openExportDialog → 从 coverage-core 读取 currentSessionId
 * - coverage-export.runExport → 从 coverage-core 读取 currentSessionId
 * - coverage-gaps.loadGaps → 缺省时从 coverage-core 读取 currentSessionId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoverageMergeSession, CoverageGap, CoverageTriage, CoverageExclusion, CoverageSummary } from '@shared/types';

// ─── 依赖 mock ───────────────────────────────────────────────────

const getFullViewQuery = vi.fn();
const deleteSessionMutate = vi.fn();
const listSessionsQuery = vi.fn();
const listGapsQuery = vi.fn();
const exportReportMutate = vi.fn();
const pickExportPathMutate = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    coverage: {
      getFullView: { query: (...args: unknown[]) => getFullViewQuery(...args) },
      deleteSession: { mutate: (...args: unknown[]) => deleteSessionMutate(...args) },
      listSessions: { query: (...args: unknown[]) => listSessionsQuery(...args) },
      listGaps: { query: (...args: unknown[]) => listGapsQuery(...args) },
      exportReport: { mutate: (...args: unknown[]) => exportReportMutate(...args) },
      pickExportPath: { mutate: (...args: unknown[]) => pickExportPathMutate(...args) },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: {
    getState: () => ({ currentProjectId: 'proj-1' }),
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

// ─── 导入 store ─────────────────────────────────────────────────

import { useCoverageCoreStore } from '@renderer/stores/coverage/coverage-core';
import { useCoverageGapsStore } from '@renderer/stores/coverage/coverage-gaps';
import { useCoverageExportStore } from '@renderer/stores/coverage/coverage-export';

// ─── 测试 ────────────────────────────────────────────────────────

describe('跨 store 关键路径', () => {
  beforeEach(() => {
    // 重置所有 store
    useCoverageCoreStore.setState({
      sessions: [],
      currentSessionId: null,
      tree: null,
      overview: null,
      loading: false,
    });
    useCoverageGapsStore.setState({
      targets: {},
      gaps: [],
      triages: [],
      exclusions: [],
    });
    useCoverageExportStore.setState({
      exportDialogOpen: false,
      exportOutputPath: '',
      exporting: false,
    });

    // 重置 mock
    getFullViewQuery.mockReset();
    deleteSessionMutate.mockReset();
    listSessionsQuery.mockReset();
    listGapsQuery.mockReset();
    exportReportMutate.mockReset();
    pickExportPathMutate.mockReset();
  });

  describe('core.loadTree → gaps.setTargetsState', () => {
    it('loadTree 完成后 targets 同步到 gaps store', async () => {
      const mockTargets = { line: 90, branch: 85 };
      getFullViewQuery.mockResolvedValue({
        tree: { summaryOnly: false, root: { name: 'top', children: [] } },
        summary: { overall: 90, line: 90, branch: 85, toggle: 80, condition: 75, fsm_state: 70, fsm_transition: 65, functional: 60, assertion: 55 } as CoverageSummary,
        sessionId: 's1',
        targets: mockTargets,
      });

      await useCoverageCoreStore.getState().loadTree('proj-1', 's1');

      // 验证 gaps store 的 targets 被更新
      expect(useCoverageGapsStore.getState().targets).toEqual(mockTargets);
    });

    it('loadTree 无 session 时静默返回，不更新 targets', async () => {
      useCoverageCoreStore.setState({ sessions: [], currentSessionId: null });

      await useCoverageCoreStore.getState().loadTree('proj-1');

      expect(getFullViewQuery).not.toHaveBeenCalled();
      expect(useCoverageGapsStore.getState().targets).toEqual({});
    });
  });

  describe('core.deleteSession → gaps.clearSessionData', () => {
    it('删除当前 session 时清空 gaps store 数据', async () => {
      // 准备：core 有 2 个 session，当前选中 s1
      const sessions: CoverageMergeSession[] = [
        { sessionId: 's1', covMergeDir: '/a', edaTool: 'imc', createdAt: 1, reportDir: '/a/report' },
        { sessionId: 's2', covMergeDir: '/b', edaTool: 'imc', createdAt: 2, reportDir: '/b/report' },
      ];
      useCoverageCoreStore.setState({
        sessions,
        currentSessionId: 's1',
      });
      // gaps store 有数据
      const gaps: CoverageGap[] = [
        { nodePath: '/a', nodeName: 'cpu_core', metric: 'line', target: 90, actual: 80, deficit: 10 },
      ];
      const triages: CoverageTriage[] = [
        { id: 't1', sessionId: 's1', nodePath: '/a', metric: 'line', gap: gaps[0] },
      ];
      const exclusions: CoverageExclusion[] = [
        { id: 'e1', sessionId: 's1', nodePath: '/a', metric: 'line', reason: 'dead code', status: 'pending', requestedBy: 'user', requestedAt: 0 },
      ];
      useCoverageGapsStore.setState({
        gaps,
        triages,
        exclusions,
        targets: { line: 90 },
      });

      deleteSessionMutate.mockResolvedValue(undefined);

      await useCoverageCoreStore.getState().deleteSession('proj-1', 's1');

      // 验证 gaps store 被清空
      expect(useCoverageGapsStore.getState().gaps).toEqual([]);
      expect(useCoverageGapsStore.getState().triages).toEqual([]);
      expect(useCoverageGapsStore.getState().exclusions).toEqual([]);
      expect(useCoverageGapsStore.getState().targets).toEqual({});

      // core 的 currentSessionId 切换到剩余的
      expect(useCoverageCoreStore.getState().currentSessionId).toBe('s2');
    });

    it('删除非当前 session 时不清空 gaps 数据', async () => {
      useCoverageCoreStore.setState({
        sessions: [
          { sessionId: 's1', covMergeDir: '/a', edaTool: 'imc', createdAt: 1, reportDir: '/a/report' },
          { sessionId: 's2', covMergeDir: '/b', edaTool: 'imc', createdAt: 2, reportDir: '/b/report' },
        ],
        currentSessionId: 's1',
      });
      useCoverageGapsStore.setState({
        gaps: [{ nodePath: '/a', nodeName: 'cpu_core', metric: 'line', target: 90, actual: 80, deficit: 10 }],
        targets: { line: 90 },
      });

      deleteSessionMutate.mockResolvedValue(undefined);

      await useCoverageCoreStore.getState().deleteSession('proj-1', 's2');

      // gaps store 数据不变
      expect(useCoverageGapsStore.getState().gaps).toEqual([{ nodePath: '/a', nodeName: 'cpu_core', metric: 'line', target: 90, actual: 80, deficit: 10 }]);
      expect(useCoverageGapsStore.getState().targets).toEqual({ line: 90 });
    });
  });

  describe('export.openExportDialog → core.currentSessionId', () => {
    it('openExportDialog 从 core store 读取 currentSessionId', () => {
      useCoverageCoreStore.setState({ currentSessionId: 's1' });

      useCoverageExportStore.getState().openExportDialog();

      expect(useCoverageExportStore.getState().exportDialogOpen).toBe(true);
    });
  });

  describe('export.runExport → core.currentSessionId', () => {
    it('runExport 从 core store 读取 currentSessionId', async () => {
      useCoverageCoreStore.setState({ currentSessionId: 's1' });
      useCoverageExportStore.setState({
        exportDialogOpen: true,
        exportFormat: 'html',
        exportScope: 'current',
        exportOutputPath: '/tmp/report.html',
        exporting: false,
      });

      exportReportMutate.mockResolvedValue({ outputPath: '/tmp/report.html' });

      const result = await useCoverageExportStore.getState().runExport('proj-1');

      expect(result).toBe(true);
      expect(exportReportMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          sessionId: 's1',
          scope: 'current',
          format: 'html',
          outputPath: '/tmp/report.html',
        }),
      );
    });

    it('runExport compare 模式校验 currentSessionId 存在', async () => {
      useCoverageCoreStore.setState({ currentSessionId: null });
      useCoverageExportStore.setState({
        exportDialogOpen: true,
        exportFormat: 'json',
        exportScope: 'compare',
        exportCompareSessionId: 's2',
        exportOutputPath: '/tmp/report.json',
        exporting: false,
      });

      const result = await useCoverageExportStore.getState().runExport('proj-1');

      expect(result).toBe(false);
      expect(exportReportMutate).not.toHaveBeenCalled();
    });
  });

  describe('gaps.loadGaps → core.currentSessionId fallback', () => {
    it('loadGaps 缺省 sessionId 时从 core store 读取', async () => {
      useCoverageCoreStore.setState({ currentSessionId: 's1' });
      listGapsQuery.mockResolvedValue({ gaps: [], sessionId: 's1' });

      await useCoverageGapsStore.getState().loadGaps('proj-1');

      expect(listGapsQuery).toHaveBeenCalledWith({ projectId: 'proj-1', sessionId: 's1' });
    });

    it('loadGaps 显式传入 sessionId 时不读 core store', async () => {
      useCoverageCoreStore.setState({ currentSessionId: 's1' });
      listGapsQuery.mockResolvedValue({ gaps: [], sessionId: 's2' });

      await useCoverageGapsStore.getState().loadGaps('proj-1', 's2');

      expect(listGapsQuery).toHaveBeenCalledWith({ projectId: 'proj-1', sessionId: 's2' });
    });

    it('loadGaps 无 sessionId 且 core 无 currentSessionId 时静默返回', async () => {
      useCoverageCoreStore.setState({ currentSessionId: null });

      await useCoverageGapsStore.getState().loadGaps('proj-1');

      expect(listGapsQuery).not.toHaveBeenCalled();
    });
  });
});
