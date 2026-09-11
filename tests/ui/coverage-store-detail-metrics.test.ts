// @vitest-environment jsdom
/**
 * coverage-core.parseDetailMetrics — detail.txt 解析 action 的状态流转测试。
 *
 * 验证：
 * - 成功路径：detailMetricsParsing true→false、detailMetricsParsed=true、
 *   成功后调用 loadTree 刷新树（detail 数据已合并进树缓存）
 * - 失败路径：detailMetricsParsing 复位、detailMetricsParsed 不变、toast error
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoverageData } from '@shared/types';

// ─── 依赖 mock ───────────────────────────────────────────────────

const parseDetailMetricsMutate = vi.fn();
const getFullViewQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    coverage: {
      parseDetailMetrics: { mutate: (...args: unknown[]) => parseDetailMetricsMutate(...args) },
      getFullView: { query: (...args: unknown[]) => getFullViewQuery(...args) },
    },
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

vi.mock('@renderer/stores/coverage/coverage-gaps', () => ({
  useCoverageGapsStore: {
    getState: () => ({ setTargetsState: vi.fn() }),
  },
}));

// ─── 导入 store ─────────────────────────────────────────────────

import { useCoverageCoreStore } from '@renderer/stores/coverage/coverage-core';

function makeTree(summaryOnly: boolean, withDetail: boolean): CoverageData {
  return {
    sessionId: 'merge_test',
    source: { covMergeDir: 'cov_merge', edaTool: 'imc', reportGeneratedAt: 0 },
    root: {
      name: 'tb_top',
      path: 'tb_top',
      depth: 0,
      metrics: {} as CoverageData['root']['metrics'],
      children: [],
    },
    targets: {},
    summaryOnly,
    ...(withDetail ? { detail: { instanceCount: 2, parsedAt: 1 } } : {}),
  };
}

describe('coverage-core.parseDetailMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCoverageCoreStore.setState({
      detailMetricsParsing: false,
      detailMetricsParsed: false,
      tree: null,
      sessions: [],
      currentSessionId: 'merge_test',
    });
  });

  it('成功路径：状态翻转 + 刷新树并置 detailMetricsParsed', async () => {
    parseDetailMetricsMutate.mockResolvedValue({
      sessionId: 'merge_test',
      summary: { overall: 90 } as never,
      instanceCount: 2,
    });
    // 刷新树时 getFullView 返回带 detail 标记的树
    getFullViewQuery.mockResolvedValue({
      tree: makeTree(true, true),
      summary: { overall: 90 },
      sessionId: 'merge_test',
      targets: {},
    });

    const ok = await useCoverageCoreStore
      .getState()
      .parseDetailMetrics('proj-1', 'merge_test');

    expect(ok).toBe(true);
    expect(parseDetailMetricsMutate).toHaveBeenCalledWith({
      projectId: 'proj-1',
      sessionId: 'merge_test',
    });
    const s = useCoverageCoreStore.getState();
    expect(s.detailMetricsParsing).toBe(false);
    expect(s.detailMetricsParsed).toBe(true);
    // 成功后刷新了树（getFullView 被调用），树带上 detail 标记
    expect(getFullViewQuery).toHaveBeenCalledTimes(1);
    expect(s.tree?.detail).toEqual({ instanceCount: 2, parsedAt: 1 });
  });

  it('失败路径：状态复位 + 返回 false', async () => {
    parseDetailMetricsMutate.mockRejectedValue(new Error('detail.txt not found'));

    const ok = await useCoverageCoreStore
      .getState()
      .parseDetailMetrics('proj-1', 'merge_test');

    expect(ok).toBe(false);
    const s = useCoverageCoreStore.getState();
    expect(s.detailMetricsParsing).toBe(false);
    expect(s.detailMetricsParsed).toBe(false);
  });
});
