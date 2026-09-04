// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { DesignInstRow } from '@main/rtl/types';

/**
 * DesignTree 组件测试（issue 03 层级树可用性）：
 *
 * - 虚拟滚动：50k 子实例 fixture 下 DOM 行数有上限，滚动到底可见末尾节点
 * - 树节点显示子树实例数徽标（instCount）
 * - 树节点跳转 Workbench 文件 tab：解析 src 属性 → 定位模块声明行
 *
 * Mock 策略：trpc（getChildren 按需返回合成树）、project store（rootPath）；
 * workbench/ui store 用真实 zustand（纯前端无 IPC），断言 tabs destination。
 */

const { trpcMocks, projectState, uiState } = vi.hoisted(() => ({
  trpcMocks: {
    getChildren: vi.fn(),
  },
  projectState: {
    currentProjectId: 'proj-1' as string | null,
    projects: [{ id: 'proj-1', rootPath: 'D:\\proj', name: 'P' }],
    pushRecentFile: vi.fn(),
  },
  uiState: { setActiveView: vi.fn() },
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    rtl: {
      getChildren: { query: trpcMocks.getChildren },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: Object.assign(
    (selector: (s: typeof projectState) => unknown) => selector(projectState),
    { getState: () => projectState },
  ),
}));

vi.mock('@renderer/stores/ui', () => ({
  useUiStore: Object.assign(
    (selector: (s: typeof uiState) => unknown) => selector(uiState),
    { getState: () => uiState },
  ),
}));

// jsdom 无布局：虚拟滚动首测依赖 offsetHeight/offsetWidth
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 480 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

import { DesignTree } from '@renderer/components/design/DesignTree';
import { useWorkbenchStore } from '@renderer/stores/workbench';

// ─── 合成层级树 fixture ─────────────────────────────────────

function inst(path: string, module: string, instCount: number, src: string | null = null): DesignInstRow {
  const name = path.split('.').pop() ?? path;
  return {
    path,
    name,
    module,
    parent: path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null,
    depth: path.split('.').length - 1,
    src,
    params: {},
    instCount,
  };
}

/** soc_top → u_big（5 万 leaf）的大规模 fixture（SoC 级虚拟滚动验证） */
const BIG_N = 50_000;
const ROOT: DesignInstRow = inst('soc_top', 'soc_top', BIG_N + 2, 'rtl\\soc_top.sv:2.8');
const U_BIG: DesignInstRow = inst('soc_top.u_big', 'big_mod', BIG_N + 1, 'rtl\\big.sv:10.8');

function bigChildren(path: string): DesignInstRow[] {
  if (path === 'soc_top') return [U_BIG];
  if (path === 'soc_top.u_big') {
    return Array.from({ length: BIG_N }, (_, i) => inst(`soc_top.u_big.g[${i}]`, 'leaf_mod', 1));
  }
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkbenchStore.getState().closeAll();
  trpcMocks.getChildren.mockImplementation(async ({ path }: { path: string }) =>
    bigChildren(path),
  );
});

// ─── 虚拟滚动 ────────────────────────────────────────────────

describe('DesignTree 虚拟滚动（issue 03）', () => {
  it('50k 子实例展开后 DOM 行数有上限（不整树渲染）', async () => {
    render(<DesignTree projectId="proj-1" node={ROOT} />);

    // 展开根 → u_big 出现
    fireEvent.click(screen.getByTestId('design-tree-node'));
    await waitFor(() => expect(screen.getByText('u_big')).toBeTruthy());

    // 展开 u_big → 5 万子实例（懒加载）
    fireEvent.click(screen.getByText('u_big').closest('[data-testid="design-tree-node"]')!);
    await waitFor(() => expect(screen.getByText('g[0]')).toBeTruthy());

    // 虚拟化：仅渲染可视窗口附近行，而非 50002 行全部进 DOM
    const rendered = document.querySelectorAll('[data-testid="design-tree-node"]').length;
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(100);
  });

  it('滚动到底部后末尾节点进入可视窗口', async () => {
    render(<DesignTree projectId="proj-1" node={ROOT} />);
    fireEvent.click(screen.getByTestId('design-tree-node'));
    await waitFor(() => expect(screen.getByText('u_big')).toBeTruthy());
    fireEvent.click(screen.getByText('u_big').closest('[data-testid="design-tree-node"]')!);
    await waitFor(() => expect(screen.getByText('g[0]')).toBeTruthy());

    const scrollEl = document.querySelector<HTMLElement>('[data-testid="design-tree-scroll"]')!;
    Object.defineProperty(scrollEl, 'scrollTop', { configurable: true, value: (BIG_N + 1) * 24 });
    fireEvent.scroll(scrollEl);

    await waitFor(() => expect(screen.getByText(`g[${BIG_N - 1}]`)).toBeTruthy());
  });
});

// ─── 实例数徽标 ──────────────────────────────────────────────

describe('DesignTree 实例数徽标（issue 03）', () => {
  it('节点显示子树实例数（含自身），无需展开即可判断规模', async () => {
    render(<DesignTree projectId="proj-1" node={ROOT} />);
    const rootRow = screen.getByTestId('design-tree-node');
    expect(within(rootRow).getByTestId('design-tree-inst-count')).toHaveTextContent(`${BIG_N + 2} 实例`);

    fireEvent.click(rootRow);
    await waitFor(() => expect(screen.getByText('u_big')).toBeTruthy());
    const bigRow = screen.getByText('u_big').closest<HTMLElement>('[data-testid="design-tree-node"]')!;
    expect(within(bigRow).getByTestId('design-tree-inst-count')).toHaveTextContent(`${BIG_N + 1} 实例`);
  });
});

// ─── 源码跳转 ────────────────────────────────────────────────

describe('DesignTree 源码跳转（issue 03 → Workbench 文件 tab）', () => {
  it('点击跳转按钮：解析 src → 打开文件 tab 并定位模块声明行', async () => {
    render(<DesignTree projectId="proj-1" node={ROOT} />);
    const rootRow = screen.getByTestId('design-tree-node');
    fireEvent.click(within(rootRow).getByTestId('design-tree-jump'));

    const { tabs, activeTabId } = useWorkbenchStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.destination).toMatchObject({
      type: 'file',
      path: 'D:\\proj\\rtl\\soc_top.sv',
      line: 2,
    });
    expect(activeTabId).toBe(tabs[0]!.id);
  });

  it('无 src 属性的节点不渲染跳转按钮', () => {
    const { container } = render(
      <DesignTree projectId="proj-1" node={inst('soc_top', 'soc_top', 3, null)} />,
    );
    expect(container.querySelectorAll('[data-testid="design-tree-jump"]')).toHaveLength(0);
  });
});
