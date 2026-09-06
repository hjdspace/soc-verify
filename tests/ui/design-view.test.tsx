// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode, ReactElement } from 'react';
import type { DesignDefRow, DesignInstRow, DesignStatus, DesignSubgraphRow } from '@main/rtl/types';

/**
 * DesignView 组件测试（issue 03）：
 *
 * - 源文件 mtime 变化 → 数据过期提示徽标（不自动重跑，刷新按钮仍手动触发）
 * - 顶层选择器：检测后列出 elaborated top units 供选择，保存时持久化所选 top
 * - 记忆恢复：已保存 top 的项目再次进入直接恢复（选择器回填、刷新可用、树直接渲染）
 *
 * ModuleInterfaceView 和 BlockDiagram 使用真实组件（非 stub），验证 DesignView
 * 与它们的集成：接口视图渲染端口分组、框图渲染面包屑与节点。
 */

const { trpcMocks, projectState } = vi.hoisted(() => ({
  trpcMocks: {
    getConfig: { query: vi.fn() },
    getStatus: { query: vi.fn() },
    getRoot: { query: vi.fn() },
    getChildren: { query: vi.fn() },
    getDef: { query: vi.fn() },
    getSubgraph: { query: vi.fn() },
    getDetectedTops: { query: vi.fn() },
    setConfig: { mutate: vi.fn() },
    detectTops: { mutate: vi.fn() },
    refresh: { mutate: vi.fn() },
    tools: { selectFiles: { mutate: vi.fn() }, selectDirectory: { mutate: vi.fn() } },
  },
  projectState: { currentProjectId: 'proj-1' as string | null },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: { rtl: trpcMocks, tools: trpcMocks.tools },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: typeof projectState) => unknown) => selector(projectState),
}));

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: () => ({ openFile: null, openFileDestination: vi.fn() }),
  openFileDestination: vi.fn(),
}));

// DesignTree stub：隔离树组件复杂度（虚拟滚动等），仅模拟 onSelect 交互
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

// @xyflow/react 桩：转发 onNodeDoubleClick，渲染自定义节点/边组件
vi.mock('@xyflow/react', () => {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' } as const;
  const Handle = (props: { id?: string; type?: string }) => (
    <span data-handle-id={props.id ?? ''} data-handle-type={props.type ?? ''} />
  );
  const BaseEdge = () => null;
  const Background = () => null;
  const Controls = () => null;
  const MiniMap = () => null;
  const Panel = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const EdgeLabelRenderer = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const getBezierPath = () => '';
  const ReactFlow = ({
    nodes,
    edges,
    nodeTypes,
    edgeTypes,
    onNodeDoubleClick,
    onInit: _onInit,
    onNodesChange: _onNodesChange,
    children,
  }: {
    nodes: { id: string; type?: string; data: Record<string, unknown> }[];
    edges: { id: string; type?: string; data?: Record<string, unknown> }[];
    nodeTypes?: Record<string, (props: { id: string; data: Record<string, unknown> }) => ReactElement>;
    edgeTypes?: Record<string, (props: { id: string; data: Record<string, unknown> }) => ReactElement>;
    onNodeDoubleClick?: (event: unknown, node: { id: string }) => void;
    onInit?: (instance: unknown) => void;
    onNodesChange?: (changes: unknown[]) => void;
    children?: ReactNode;
  }) => (
    <div data-testid="block-diagram-canvas">
      {nodes?.map((n) => {
        const Cmp = n.type ? nodeTypes?.[n.type] : undefined;
        return (
          <div key={n.id} data-testid={`diagram-node-${n.id}`} onDoubleClick={() => onNodeDoubleClick?.(null, n)}>
            {Cmp ? <Cmp id={n.id} data={n.data} /> : null}
          </div>
        );
      })}
      {edges?.map((e) => {
        const Cmp = e.type ? edgeTypes?.[e.type] : undefined;
        return (
          <div key={e.id} data-edge-id={e.id} data-highlighted={String(e.data?.highlighted ?? false)}>
            {Cmp ? <Cmp id={e.id} data={e.data ?? {}} /> : null}
          </div>
        );
      })}
      {children}
    </div>
  );
  return { ReactFlow, Handle, Position, BaseEdge, EdgeLabelRenderer, getBezierPath, Background, Controls, MiniMap, Panel };
});

vi.mock('@renderer/components/design/block-diagram-layout', () => ({
  layoutDiagram: vi.fn(async (nodes: { id: string }[]) =>
    new Map(nodes.map((n, i) => [n.id, { x: i * 320, y: 40 }]))),
}));

import { DesignView } from '@renderer/components/views/DesignView';
import { useUiStore } from '@renderer/stores/ui';

// ─── fixtures ───────────────────────────────────────────────

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

// ModuleInterfaceView fixture：soc_subsys 模块定义（端口 + bundle 打标）
const SOCSUBSYS_DEF: DesignDefRow = {
  name: 'soc_subsys',
  src: 'rtl/soc_subsys.sv',
  paramDefaults: { N_IP: 4 },
  ports: [
    { name: 'clk_i', direction: 'input', width: 1 },
    { name: 'rst_n_i', direction: 'input', width: 1 },
    { name: 'h_haddr', direction: 'input', width: 12 },
    { name: 'h_hsel', direction: 'input', width: 1 },
    { name: 'h_hwrite', direction: 'input', width: 1 },
    { name: 'h_hwdata', direction: 'input', width: 32 },
    { name: 'h_hrdata', direction: 'output', width: 32 },
    { name: 'h_hreadyout', direction: 'output', width: 1 },
    { name: 'irq_o', direction: 'output', width: 8 },
  ],
  bundles: {
    bundles: [
      {
        protocol: 'AHB',
        prefix: 'h_',
        singleton: false,
        role: 'slave',
        signals: ['h_haddr', 'h_hsel', 'h_hwrite', 'h_hwdata', 'h_hrdata', 'h_hreadyout'].map((n) => ({ name: n, sig: n.replace('h_', '') })),
      },
      { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
      { protocol: 'reset', prefix: '', singleton: true, role: null, signals: [{ name: 'rst_n_i', sig: 'rst_n_i' }] },
    ],
    leftovers: ['irq_o'],
  },
};

// BlockDiagram fixture：spike_top 子图（图根 + 1 个子实例 + top2i 桥边）
const SG_TOP: DesignSubgraphRow = {
  root: {
    path: 'spike_top',
    name: 'spike_top',
    module: 'spike_top',
    parent: null,
    depth: 0,
    src: null,
    params: {},
    instCount: 9,
    ports: [
      { name: 'clk_i', direction: 'input', width: 1 },
      { name: 'rst_n_i', direction: 'input', width: 1 },
      { name: 'apb0_paddr', direction: 'input', width: 12 },
      { name: 'apb0_psel', direction: 'input', width: 1 },
    ],
  },
  nodes: [
    {
      path: 'spike_top.u_subsys0',
      name: 'u_subsys0',
      module: 'soc_subsys',
      parent: 'spike_top',
      depth: 1,
      src: null,
      params: {},
      instCount: 3,
      ports: [
        { name: 'clk_i', direction: 'input', width: 1 },
        { name: 'rst_n_i', direction: 'input', width: 1 },
        { name: 'h_haddr', direction: 'input', width: 12 },
        { name: 'h_hsel', direction: 'input', width: 1 },
      ],
      bundles: {
        bundles: [
          { protocol: 'AHB', prefix: 'h_', singleton: false, role: 'slave', signals: ['h_haddr', 'h_hsel'].map((n) => ({ name: n, sig: n.replace('h_', '') })) },
          { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
          { protocol: 'reset', prefix: '', singleton: true, role: null, signals: [{ name: 'rst_n_i', sig: 'rst_n_i' }] },
        ],
        leftovers: [],
      },
    },
  ],
  edges: [
    { module: 'spike_top', net: 'apb0_paddr', kind: 'top2i', width: 12, cells: [{ inst: 'spike_top.u_subsys0', port: 'h_haddr' }], topPorts: ['apb0_paddr'] },
    { module: 'spike_top', net: 'clk_i', kind: 'i2i', width: 1, cells: [{ inst: 'spike_top.u_subsys0', port: 'clk_i' }], topPorts: ['clk_i'] },
  ],
  bundles: {
    bundles: [
      { protocol: 'APB', prefix: 'apb0_', singleton: false, role: 'slave', signals: ['apb0_paddr', 'apb0_psel'].map((n) => ({ name: n, sig: n.replace('apb0_', '') })) },
      { protocol: 'clock', prefix: '', singleton: true, role: null, signals: [{ name: 'clk_i', sig: 'clk_i' }] },
    ],
    leftovers: [],
  },
};

// 子图（选中 u_subsys0 为图根时）
const SG_SUB: DesignSubgraphRow = {
  root: {
    path: 'spike_top.u_subsys0',
    name: 'u_subsys0',
    module: 'soc_subsys',
    parent: 'spike_top',
    depth: 1,
    src: null,
    params: {},
    instCount: 3,
    ports: [
      { name: 'clk_i', direction: 'input', width: 1 },
      { name: 'rst_n_i', direction: 'input', width: 1 },
      { name: 'h_haddr', direction: 'input', width: 12 },
    ],
  },
  nodes: [],
  edges: [],
  bundles: { bundles: [], leftovers: [] },
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
  trpcMocks.tools.selectFiles.mutate.mockResolvedValue({ paths: [] });
  trpcMocks.tools.selectDirectory.mutate.mockResolvedValue({ path: null });
  // ModuleInterfaceView 用 getDef
  trpcMocks.getDef.query.mockResolvedValue(SOCSUBSYS_DEF);
  // BlockDiagram 用 getSubgraph
  trpcMocks.getSubgraph.query.mockImplementation(({ path }: { path: string }) => {
    if (path === 'spike_top') return Promise.resolve(SG_TOP);
    if (path === 'spike_top.u_subsys0') return Promise.resolve(SG_SUB);
    return Promise.resolve({ root: null, nodes: [], edges: [], bundles: { bundles: [], leftovers: [] } });
  });
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

  it('检测顶层成功后同步主面板 status：残留的旧 lastError 面板立即清除', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ filelists: ['design/spike.f'], top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);
    // 打开时 DB 残留上次失败的 lastError（如旧版反斜杠 bug 存的「yosys 退出码 1」）
    trpcMocks.getStatus.query.mockResolvedValueOnce({
      ...baseStatus,
      configured: false,
      hasData: false,
      top: null,
      lastError: { message: 'yosys 退出码 1', diagnostics: [], logTail: 'ERROR: Bad command' },
    });
    // 检测成功后主进程已清除 lastError（reload 应拉到干净 status）
    trpcMocks.getStatus.query.mockResolvedValue({
      ...baseStatus,
      configured: true,
      hasData: false,
      top: 'spike_top',
      lastError: null,
    });

    render(<DesignView />);
    expect(await screen.findByTestId('design-error-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('design-detect-tops'));

    // 检测完成触发 status 重载，残留错误面板消失
    await waitFor(() => {
      expect(screen.queryByTestId('design-error-panel')).toBeNull();
    });
    expect(trpcMocks.getStatus.query).toHaveBeenCalledTimes(2);
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

  it('检测顶层失败时显示错误消息 + yosys 输出详情（可折叠）', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ filelists: ['design/spike.f'], top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);

    render(<DesignView />);
    await screen.findByTestId('design-config-panel');

    // detectTops 失败：tRPC error 带 cause.logTail
    trpcMocks.detectTops.mutate.mockRejectedValueOnce(
      Object.assign(new Error('yosys 退出码 1'), {
        cause: { logTail: 'ERROR: read_slang failed in design.ys', diagnostics: [] },
      }),
    );

    fireEvent.click(screen.getByTestId('design-detect-tops'));

    const errorEl = await screen.findByTestId('design-detect-error');
    expect(errorEl).toHaveTextContent('yosys 退出码 1');

    // 可折叠的 yosys 输出详情
    const summary = errorEl.querySelector('summary');
    expect(summary).toHaveTextContent('yosys 输出详情');
  });
});

// ─── 浏览按钮 + 刷新失败呈现（回归：issue 反馈） ──────────────

describe('DesignView filelist 浏览按钮', () => {
  it('点击浏览调用文件对话框，首个路径填入当前行、多选追加新行', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ filelists: [''], top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);
    trpcMocks.tools.selectFiles.mutate.mockResolvedValue({
      paths: ['D:\\rtl-spike\\spike.f', 'D:\\rtl-spike\\other.f'],
    });

    render(<DesignView />);
    await screen.findByTestId('design-config-panel');

    fireEvent.click(screen.getByTestId('design-filelist-browse-0'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('D:\\rtl-spike\\spike.f')).toBeTruthy();
      expect(screen.getByDisplayValue('D:\\rtl-spike\\other.f')).toBeTruthy();
    });
  });

  it('对话框取消（空 paths）不改动输入框', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ filelists: ['design/spike.f'], top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);

    render(<DesignView />);
    await screen.findByTestId('design-config-panel');

    fireEvent.click(screen.getByTestId('design-filelist-browse-0'));

    await waitFor(() => {
      expect(trpcMocks.tools.selectFiles.mutate).toHaveBeenCalled();
    });
    // 取消后输入框保持原值，不新增空行
    expect(screen.getByDisplayValue('design/spike.f')).toBeTruthy();
    expect(
      screen.getAllByPlaceholderText('design/filelist.f 或绝对路径'),
    ).toHaveLength(1);
  });
});

describe('DesignView 目录扫描来源', () => {
  it('从 Filelist 切换后显示目录配置和输入预览', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ source: 'filelist', filelists: ['design/spike.f'], top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);

    render(<DesignView />);
    await screen.findByTestId('design-filelist-source-panel');
    expect(screen.queryByTestId('design-directory-source-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('design-source-directory'));

    expect(screen.queryByTestId('design-filelist-source-panel')).toBeNull();
    expect(screen.getByTestId('design-directory-source-panel')).toBeVisible();
    expect(screen.getByTestId('design-source-directory')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('design-source-filelist')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('design-source-preview')).toHaveTextContent('DIRECTORY SCAN');
  });

  it('浏览目录后回填扫描根目录，并在对话框打开期间显示状态', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ source: 'directory', filelists: [], directory: { root: '', excludes: [], incdirs: [], defines: [] }, top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);
    let resolveDirectory: ((value: { path: string | null }) => void) | undefined;
    trpcMocks.tools.selectDirectory.mutate.mockImplementation(
      () => new Promise((resolve) => { resolveDirectory = resolve; }),
    );

    render(<DesignView />);
    await screen.findByTestId('design-config-panel');
    fireEvent.click(screen.getByTestId('design-source-directory'));
    fireEvent.click(screen.getByTestId('design-scan-browse'));

    expect(screen.getByTestId('design-scan-browse')).toHaveTextContent('打开中');
    resolveDirectory?.({ path: 'D:\\doc\\opentitan\\hw' });
    await waitFor(() => expect(screen.getByTestId('design-scan-root')).toHaveValue('D:\\doc\\opentitan\\hw'));
    expect(screen.getByTestId('design-scan-browse')).toHaveTextContent('浏览');
  });

  it('保存目录扫描配置时提交 root、排除项和 define', async () => {
    trpcMocks.getConfig.query.mockResolvedValue({ source: 'directory', filelists: [], directory: { root: '', excludes: [], incdirs: [], defines: [] }, top: null });
    trpcMocks.getStatus.query.mockResolvedValue({ ...baseStatus, configured: false, hasData: false, top: null });
    trpcMocks.getRoot.query.mockResolvedValue(null);

    render(<DesignView />);
    await screen.findByTestId('design-config-panel');
    fireEvent.click(screen.getByTestId('design-source-directory'));
    fireEvent.change(screen.getByTestId('design-scan-root'), { target: { value: 'D:\\doc\\opentitan\\hw' } });
    fireEvent.change(screen.getByTestId('design-scan-excludes'), { target: { value: '**/dv/**\n**/vendor/**' } });
    fireEvent.change(screen.getByTestId('design-scan-defines'), { target: { value: 'SYNTHESIS=1' } });
    fireEvent.change(screen.getByTestId('design-top-input'), { target: { value: 'top_earlgrey' } });
    fireEvent.click(screen.getByTestId('design-config-save'));

    await waitFor(() => {
      expect(trpcMocks.setConfig.mutate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          source: 'directory',
          directory: expect.objectContaining({
            root: 'D:\\doc\\opentitan\\hw',
            excludes: ['**/dv/**', '**/vendor/**'],
            defines: ['SYNTHESIS=1'],
          }),
          top: 'top_earlgrey',
        }),
      );
    });
  });
});

describe('DesignView 刷新失败呈现（不静默回退空页面）', () => {
  it('保存后刷新失败：reload 拿到持久化的 lastError，显示错误面板而非「尚未 elaboration」空提示', async () => {
    // 模拟服务端状态流转：setConfig 保存成功 → configured；refresh 失败 → lastError 持久化
    let configured = false;
    let lastError: DesignStatus['lastError'] = null;
    trpcMocks.getConfig.query.mockImplementation(() =>
      Promise.resolve(
        configured ? { filelists: ['design/spike.f'], top: 'spike_top' } : { filelists: ['design/spike.f'], top: null },
      ),
    );
    trpcMocks.getStatus.query.mockImplementation(() =>
      Promise.resolve({ ...baseStatus, configured, hasData: false, top: null, lastError }),
    );
    trpcMocks.setConfig.mutate.mockImplementation(async () => {
      configured = true;
      return { ok: true };
    });
    trpcMocks.getRoot.query.mockResolvedValue(null);
    trpcMocks.refresh.mutate.mockImplementation(async () => {
      lastError = { message: 'filelist 文件不存在: D:\\x\\spike.f', diagnostics: [], logTail: '' };
      return { ok: false, error: lastError };
    });

    render(<DesignView />);
    await screen.findByTestId('design-config-panel');

    // 输入 top 后保存（保存即触发刷新）
    fireEvent.change(screen.getByTestId('design-top-input'), { target: { value: 'spike_top' } });
    fireEvent.click(screen.getByTestId('design-config-save'));

    const panel = await screen.findByTestId('design-error-panel');
    expect(panel).toHaveTextContent('filelist 文件不存在');
    expect(screen.queryByText('尚未 elaboration：配置 Design Source 后点击「刷新」')).toBeNull();
  });
});

// ─── 选中节点 → 详情视图（issue 04 接口 / issue 05 框图） ───

describe('DesignView 选中节点显示接口视图（issue 04）', () => {
  it('树节点 onSelect → 切到接口页渲染真实 ModuleInterfaceView（端口分组 + 实例名/模块名）', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');

    // 默认右侧是框图（issue 05）：等待 getSubgraph 异步返回后面包屑显示 spike_top
    expect(await screen.findByTestId('diagram-breadcrumb')).toHaveTextContent('spike_top');

    fireEvent.click(screen.getByTestId('design-tree-stub-select'));
    fireEvent.click(screen.getByTestId('design-detail-interface'));
    // 真实 ModuleInterfaceView 渲染：端口按 AHB bundle 分组
    await waitFor(() => expect(screen.getByTestId('interface-group-AHB')).toBeTruthy());
    // 接口标题显示实例名 + 模块名
    expect(screen.getByTestId('interface-title')).toHaveTextContent('u_subsys0');
    expect(screen.getByTestId('interface-title')).toHaveTextContent('soc_subsys');
    // AHB bundle 分组内有端口行
    const ahbGroup = screen.getByTestId('interface-group-AHB');
    expect(ahbGroup.querySelectorAll('[data-testid="interface-signal"]')).toHaveLength(6);
    // leftovers 单列显示未入束信号
    expect(screen.getByTestId('interface-leftovers')).toHaveTextContent('irq_o');
  });
});

describe('DesignView 框图集成（issue 05）', () => {
  it('默认右侧为框图（顶层为图根）；选中实例后以实例为图根；切到接口再切回保持图根', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');

    // 默认框图：等待 getSubgraph 异步返回后面包屑显示 spike_top（图根）
    expect(await screen.findByTestId('diagram-breadcrumb')).toHaveTextContent('spike_top');
    // 子实例 box 渲染
    expect(screen.getByTestId('diagram-node-spike_top.u_subsys0')).toBeTruthy();

    // 选择 u_subsys0 → 框图以它为图根（面包屑变化 + getSubgraph 调用）
    fireEvent.click(screen.getByTestId('design-tree-stub-select'));
    await waitFor(() => {
      expect(trpcMocks.getSubgraph.query).toHaveBeenCalledWith({ projectId: 'proj-1', path: 'spike_top.u_subsys0' });
    });
    // 面包屑更新为 u_subsys0 路径
    expect(await screen.findByTestId('diagram-breadcrumb')).toHaveTextContent('spike_top');
    expect(screen.getByTestId('diagram-breadcrumb')).toHaveTextContent('u_subsys0');

    // 切到接口再切回框图：保持实例图根
    fireEvent.click(screen.getByTestId('design-detail-interface'));
    expect(screen.queryByTestId('diagram-breadcrumb')).toBeNull();
    fireEvent.click(screen.getByTestId('design-detail-diagram'));
    // 切回框图后面包屑仍为 u_subsys0
    expect(await screen.findByTestId('diagram-breadcrumb')).toHaveTextContent('u_subsys0');
  });

  it('接口页未选中实例时显示引导提示', async () => {
    render(<DesignView />);
    await screen.findByTestId('design-view-header');
    fireEvent.click(screen.getByTestId('design-detail-interface'));
    expect(screen.queryByTestId('interface-group-AHB')).toBeNull();
    expect(screen.getByText('在左侧层级树选择实例查看接口')).toBeTruthy();
  });
});

function optionValues(el: Element): string[] {
  return Array.from(el.querySelectorAll('option')).map((o) => o.value);
}

// ─── 层级树侧边栏拖拽调宽（issue 反馈：无法调整大小） ──────────

describe('DesignView 层级树侧边栏拖拽调宽', () => {
  it('树面板宽度由 designTreeWidth 控制，拖拽 handle 更新宽度', async () => {
    useUiStore.setState({ designTreeWidth: 300 });
    render(<DesignView />);
    await screen.findByTestId('design-tree-panel');
    expect(screen.getByTestId('design-tree-panel')).toHaveStyle({ width: '300px' });

    // handle = 树面板紧邻兄弟（ResizeHandle 根 div）：右移 100px → 宽度 +100
    const handle = screen.getByTestId('design-tree-panel').nextElementSibling!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(useUiStore.getState().designTreeWidth).toBe(400);
    expect(screen.getByTestId('design-tree-panel')).toHaveStyle({ width: '400px' });
  });

  it('拖拽越界 clamp 到 [200, 600]', async () => {
    useUiStore.setState({ designTreeWidth: 300 });
    render(<DesignView />);
    await screen.findByTestId('design-tree-panel');
    await screen.findByTestId('diagram-breadcrumb');

    const handle = screen.getByTestId('design-tree-panel').nextElementSibling!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 5000 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(useUiStore.getState().designTreeWidth).toBe(600);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 5000 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(useUiStore.getState().designTreeWidth).toBe(200);
  });
});
