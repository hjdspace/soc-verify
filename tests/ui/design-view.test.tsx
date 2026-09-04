// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DesignInstRow, DesignStatus } from '@main/rtl/types';

/**
 * DesignView 组件测试（issue 03）：
 *
 * - 源文件 mtime 变化 → 数据过期提示徽标（不自动重跑，刷新按钮仍手动触发）
 * - 顶层选择器：检测后列出 elaborated top units 供选择，保存时持久化所选 top
 * - 记忆恢复：已保存 top 的项目再次进入直接恢复（选择器回填、刷新可用、树直接渲染）
 */

const { trpcMocks, projectState } = vi.hoisted(() => ({
  trpcMocks: {
    getConfig: { query: vi.fn() },
    getStatus: { query: vi.fn() },
    getRoot: { query: vi.fn() },
    getDetectedTops: { query: vi.fn() },
    setConfig: { mutate: vi.fn() },
    detectTops: { mutate: vi.fn() },
    refresh: { mutate: vi.fn() },
  },
  projectState: { currentProjectId: 'proj-1' as string | null },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: { rtl: trpcMocks },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof projectState) => unknown) => selector(projectState),
}));

vi.mock('@renderer/components/design/DesignTree', () => ({
  DesignTree: ({ node }: { node: DesignInstRow }) => (
    <div data-testid="design-tree-stub">{node.path}</div>
  ),
}));

import { DesignView } from '@renderer/components/views/DesignView';

const baseStatus: DesignStatus = {
  configured: true,
  hasData: true,
  top: 'spike_top',
  lastElaboratedAt: '2026-09-04T08:00:00Z',
  elapsedMs: 1200,
  stale: false,
  elaborating: false,
  lastError: null,
  yosysAvailable: true,
  yosysPath: '/fake/yosys',
  missingDlls: [],
};

const rootRow: DesignInstRow = {
  path: 'spike_top',
  name: 'spike_top',
  module: 'spike_top',
  parent: null,
  depth: 0,
  src: 'rtl\\spike_top.sv:3.8',
  params: {},
  instCount: 9,
};

beforeEach(() => {
  vi.clearAllMocks();
  trpcMocks.getConfig.query.mockResolvedValue({ filelists: ['design/spike.f'], top: 'spike_top' });
  trpcMocks.getStatus.query.mockResolvedValue(baseStatus);
  trpcMocks.getRoot.query.mockResolvedValue(rootRow);
  trpcMocks.getDetectedTops.query.mockResolvedValue({ tops: [] });
  trpcMocks.setConfig.mutate.mockResolvedValue({ ok: true });
  trpcMocks.detectTops.mutate.mockResolvedValue({ tops: ['soc_top', 'spike_top'] });
  trpcMocks.refresh.mutate.mockResolvedValue({ ok: true, top: 'spike_top', defCount: 3, instCount: 9 });
});

// ─── mtime 过期提示（不自动重跑） ─────────────────────────────

describe('DesignView 数据过期提示（issue 03）', () => {
  it('stale=true 时显示过期徽标', async () => {
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, stale: true });
    render(<DesignView />);
    const badge = await screen.findByTestId('design-stale-badge');
    expect(badge).toHaveTextContent('源文件已变化');
  });

  it('数据新鲜时不显示过期徽标，刷新按钮保持手动可用', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');
    expect(screen.queryByTestId('design-stale-badge')).toBeNull();
    expect(screen.getByTestId('design-refresh')).not.toBeDisabled();
  });
});

// ─── 顶层选择器（elaborated top units） ───────────────────────

describe('DesignView 顶层选择器（issue 03）', () => {
  it('检测顶层后以选择器列出 top units，保存时持久化所选 top', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ filelists: ['design/spike.f'], top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);

    render(<DesignView />);
    // 未配置 → 配置面板自动展开
    await screen.findByTestId('design-config-panel');

    fireEvent.click(screen.getByTestId('design-detect-tops'));
    const select = await screen.findByTestId('design-top-select');
    const optionValues = within(select).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(optionValues).toContain('soc_top');
    expect(optionValues).toContain('spike_top');

    fireEvent.change(select, { target: { value: 'spike_top' } });
    fireEvent.click(screen.getByTestId('design-config-save'));
    await waitFor(() => {
      expect(trpcMocks.setConfig.mutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: 'proj-1', top: 'spike_top' }),
      );
    });
  });

  it('已保存 top 的项目再次进入直接恢复：输入回填、刷新可用、树直接渲染', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');

    // 未打开配置面板即恢复：刷新按钮可用（filelists + top 均就绪）
    expect(screen.getByTestId('design-refresh')).not.toBeDisabled();
    expect(screen.getByTestId('design-tree-stub')).toHaveTextContent('spike_top');

    // 打开面板：top 回填
    fireEvent.click(screen.getByTestId('design-config-toggle'));
    await screen.findByTestId('design-config-panel');
    expect(screen.getByTestId('design-top-input')).toHaveValue('spike_top');
  });

  it('有记忆列表时再次进入：选择器直接列出 top units 并选中已保存 top', async () => {
    trpcMocks.getDetectedTops.query.mockResolvedValue({ tops: ['soc_top', 'spike_top'] });
    render(<DesignView />);
    await screen.findByTestId('design-view-header');
    fireEvent.click(screen.getByTestId('design-config-toggle'));

    const select = await screen.findByTestId('design-top-select');
    expect(optionValues(select)).toEqual(['soc_top', 'spike_top']);
    expect(select).toHaveValue('spike_top');
  });
});

function optionValues(el: Element): string[] {
  return Array.from(el.querySelectorAll('option')).map((o) => o.value);
}

