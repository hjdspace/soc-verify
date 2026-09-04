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
    getChildren: { query: vi.fn() },
    getDef: { query: vi.fn() },
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
  DesignTree: ({
    node,
    onSelect,
  }: {
    node: DesignInstRow;
    onSelect?: (inst: DesignInstRow) => void;
  }) => (
    <div data-testid="design-tree-stub">
      {node.path}
      <button
        type="button"
        data-testid="design-tree-stub-select"
        onClick={() => {
          const child: DesignInstRow = {
            path: 'spike_top.u_subsys0',
            name: 'u_subsys0',
            module: 'soc_subsys',
            parent: 'spike_top',
            depth: 1,
            src: null,
            params: { N_IP: 2 },
            instCount: 3,
          };
          onSelect?.(child);
        }}
      />
    </div>
  ),
}));

vi.mock('@renderer/components/design/ModuleInterfaceView', () => ({
  ModuleInterfaceView: ({ inst }: { inst: DesignInstRow }) => (
    <div data-testid="module-interface-stub">{inst.path}:{inst.module}</div>
  ),
}));

vi.mock('@renderer/components/design/BlockDiagram', () => ({
  BlockDiagram: ({ path }: { projectId: string; path: string }) => (
    <div data-testid="block-diagram-stub">diagram:{path}</div>
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

// ─── 选中节点 → 详情视图（issue 04 接口 / issue 05 框图） ───

describe('DesignView 选中节点显示接口视图（issue 04）', () => {
  it('树节点 onSelect → 切到接口页渲染 ModuleInterfaceView（实例+模块名）', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');
    // 默认右侧是框图（issue 05）
    expect(screen.getByTestId('block-diagram-stub')).toHaveTextContent('diagram:spike_top');

    fireEvent.click(screen.getByTestId('design-tree-stub-select'));
    fireEvent.click(screen.getByTestId('design-detail-interface'));
    await waitFor(() => expect(screen.getByTestId('module-interface-stub')).toBeTruthy());
    expect(screen.getByTestId('module-interface-stub')).toHaveTextContent('spike_top.u_subsys0:soc_subsys');
  });
});

describe('DesignView 框图集成（issue 05）', () => {
  it('默认右侧为框图（顶层为图根）；选中实例后以实例为图根；面包屑双击下钻在框图内部进行', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');
    expect(screen.getByTestId('block-diagram-stub')).toHaveTextContent('diagram:spike_top');

    // 选择 u_subsys0 → 框图以它为图根
    fireEvent.click(screen.getByTestId('design-tree-stub-select'));
    expect(screen.getByTestId('block-diagram-stub')).toHaveTextContent('diagram:spike_top.u_subsys0');

    // 切到接口再切回框图：保持实例图根
    fireEvent.click(screen.getByTestId('design-detail-interface'));
    expect(screen.queryByTestId('block-diagram-stub')).toBeNull();
    fireEvent.click(screen.getByTestId('design-detail-diagram'));
    expect(screen.getByTestId('block-diagram-stub')).toHaveTextContent('diagram:spike_top.u_subsys0');
  });

  it('接口页未选中实例时显示引导提示', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');
    fireEvent.click(screen.getByTestId('design-detail-interface'));
    expect(screen.queryByTestId('module-interface-stub')).toBeNull();
    expect(screen.getByText('在左侧层级树选择实例查看接口')).toBeTruthy();
  });
});

function optionValues(el: Element): string[] {
  return Array.from(el.querySelectorAll('option')).map((o) => o.value);
}

