// @vitest-environment jsdom
/**
 * 知识图谱视图组件行为（spec §9/§11，issue 26）。
 *
 * 覆盖：节点选择与跳转、类型/关键词过滤、社区着色、大图预算与展开、
 * WebGL 不可用/渲染失败的邻接列表降级、切换与卸载释放 worker 与渲染资源、
 * 切库/重开图不串 revision。
 *
 * sigma 与 worker 是可注入的缝：单测用假实现验证生命周期与交互契约，
 * 真实 WebGL/worker 由 `scripts/kb-graph-smoke.mjs` 在 Electron 中验证。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ─── Fake worker / renderer ─────────────────────────────────

const { fakeState } = vi.hoisted(() => ({
  fakeState: {
    workers: [] as Array<{
      terminateCount: number;
      posted: Array<{ key: string }>;
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
    }>,
    rendererCalls: [] as Array<Record<string, unknown>>,
    rendererKills: 0,
    releasedContexts: [] as number[],
    webglSupport: 'webgl2' as 'webgl2' | 'webgl' | 'none',
    rendererFailure: null as string | null,
    setHighlightCalls: [] as Array<Record<string, unknown>>,
    appliedPositions: [] as number[],
    focused: [] as string[],
    firstFrameCalls: 0,
  },
}));

vi.mock('@renderer/lib/graph-layout-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/graph-layout-client')>();
  return {
    ...actual,
    createModuleLayoutWorker: () => {
      const worker = {
        terminateCount: 0,
        posted: [] as Array<{ key: string }>,
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        postMessage(message: { key: string }) {
          worker.posted.push({ key: message.key });
        },
        terminate() {
          worker.terminateCount += 1;
        },
      };
      fakeState.workers.push(worker);
      return worker;
    },
  };
});

vi.mock('@renderer/lib/sigma-graph-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/sigma-graph-renderer')>();
  return {
    ...actual,
    createSigmaRenderer: vi.fn(async (options: Record<string, unknown>) => {
      if (fakeState.rendererFailure !== null) {
        throw new Error(fakeState.rendererFailure);
      }
      fakeState.rendererCalls.push(options);
      return {
        refresh: () => undefined,
        resize: () => undefined,
        applyPositions: (positions: unknown[]) => {
          fakeState.appliedPositions.push(positions.length);
          return positions.length;
        },
        setHighlight: (highlight: Record<string, unknown>) => {
          fakeState.setHighlightCalls.push(highlight);
        },
        focusNode: (pageId: string) => {
          fakeState.focused.push(pageId);
          return true;
        },
        kill: () => {
          fakeState.rendererKills += 1;
        },
      };
    }),
  };
});

vi.mock('@renderer/lib/webgl-support', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/webgl-support')>();
  return {
    ...actual,
    detectWebGLSupport: () => fakeState.webglSupport,
    releaseWebGLContexts: () => {
      fakeState.releasedContexts.push(1);
      return 1;
    },
  };
});

// ─── Mock tRPC ──────────────────────────────────────────────

const { wikiGraphQuery, graphInsightsMutate, lintFindingsQuery, wikiCatalogQuery, wikiPageQuery, wikiRulesQuery } = vi.hoisted(() => ({
  wikiGraphQuery: vi.fn(),
  graphInsightsMutate: vi.fn(),
  lintFindingsQuery: vi.fn(),
  wikiCatalogQuery: vi.fn(),
  wikiPageQuery: vi.fn(),
  wikiRulesQuery: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      wikiGraph: { query: wikiGraphQuery },
      graphInsights: { mutate: graphInsightsMutate },
      lintFindings: { query: lintFindingsQuery },
      wikiCatalog: { query: wikiCatalogQuery },
      wikiPage: { query: wikiPageQuery },
      wikiRules: { query: wikiRulesQuery },
      wikiSearch: { query: vi.fn().mockResolvedValue({ ok: true, hits: [], coverage: { wikiPages: 0, parsedSources: 0 }, mode: 'keyword', rebuilding: false }) },
      sourceParsed: { query: vi.fn() },
      saveWikiRules: { mutate: vi.fn() },
      validateWikiSchema: { mutate: vi.fn() },
    },
  },
}));

// ─── Import after mocks ─────────────────────────────────────

import { KbWikiGraph } from '@renderer/components/kb/KbWikiGraph';
import { KbWikiTab } from '@renderer/components/kb/KbWikiTab';
import { useKbWikiGraphStore } from '@renderer/stores/kb-wiki-graph';
import { useKbWikiStore } from '@renderer/stores/kb-wiki';
import type { WikiGraphViewOk } from '@shared/kb-types';

const NODE = (
  pageId: string,
  type: 'concept' | 'entity' | 'source' | 'pitfall',
  title: string,
  keywords: string[] = [],
) => ({ pageId, title, type, outlinks: [], inlinks: [], keywords });

function makeSnapshot(revision = 7, kbId = 'kb-1'): WikiGraphViewOk {
  return {
    ok: true,
    kbId,
    revision,
    rebuilding: false,
    nodes: [
      NODE('concepts/hub', 'concept', '时钟复位枢纽', ['clkmgr', 'reset']),
      NODE('entities/axi', 'entity', 'AXI 总线'),
      NODE('sources/spec', 'source', '接口手册'),
      NODE('pitfalls/deadlock', 'pitfall', '死锁陷阱'),
    ],
    edges: [
      { source: 'concepts/hub', target: 'entities/axi' },
      { source: 'concepts/hub', target: 'sources/spec' },
      { source: 'concepts/hub', target: 'pitfalls/deadlock' },
      { source: 'entities/axi', target: 'sources/spec' },
    ],
    brokenLinks: [],
  };
}

const COMMUNITIES = [
  { communityId: 0, size: 3, internalEdges: 2, sparse: false, members: ['concepts/hub', 'entities/axi', 'sources/spec'] },
  { communityId: 1, size: 1, internalEdges: 0, sparse: true, members: ['pitfalls/deadlock'] },
];

const BRIDGE_FINDING = {
  findingId: 'bridge:concepts/hub',
  kbId: 'kb-1',
  kind: 'bridge-node' as const,
  pageIds: ['concepts/hub'],
  evidenceRefs: ['revision:7'],
  evidenceHashes: ['h1'],
  status: 'open' as const,
  createdAt: '2026-09-14T00:00:00Z',
  updatedAt: '2026-09-14T00:00:00Z',
};

function lastRendererOptions(): {
  onNodeClick?: (pageId: string) => void;
  onStageClick?: () => void;
  onFirstFrame?: () => void;
  onNodeDragEnd?: (pageId: string, position: { x: number; y: number }) => void;
} {
  return (fakeState.rendererCalls.at(-1) ?? {}) as never;
}

function lastHighlight(): {
  selected: string | null;
  hidden: Set<string>;
  neighbors: Set<string>;
  bridges: Set<string>;
} {
  return (fakeState.setHighlightCalls.at(-1) ?? { selected: null, hidden: new Set(), neighbors: new Set(), bridges: new Set() }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeState.workers.length = 0;
  fakeState.rendererCalls.length = 0;
  fakeState.rendererKills = 0;
  fakeState.releasedContexts.length = 0;
  fakeState.webglSupport = 'webgl2';
  fakeState.rendererFailure = null;
  fakeState.setHighlightCalls.length = 0;
  fakeState.appliedPositions.length = 0;
  fakeState.focused.length = 0;
  fakeState.firstFrameCalls = 0;
  useKbWikiGraphStore.getState().reset();

  wikiGraphQuery.mockResolvedValue(makeSnapshot());
  graphInsightsMutate.mockResolvedValue({
    ok: true,
    kbId: 'kb-1',
    revision: 7,
    findings: [BRIDGE_FINDING],
    communities: COMMUNITIES,
    ranAt: '2026-09-14T00:00:00Z',
  });
  lintFindingsQuery.mockResolvedValue({ ok: true, findings: [BRIDGE_FINDING] });
  wikiCatalogQuery.mockResolvedValue({
    ok: true,
    catalog: { typeDirs: { concept: 'concepts' }, pages: [], aggregates: [], orphans: [] },
  });
  wikiPageQuery.mockResolvedValue({
    pageId: 'entities/axi',
    relPath: 'wiki/entities/axi.md',
    kind: 'page',
    content: '# AXI 总线',
    parse: {
      ok: true,
      frontmatter: {
        type: 'entity',
        title: 'AXI 总线',
        summary: '',
        keywords: [],
        tags: [],
        sources: [],
        created: '2026-09-14T00:00:00Z',
        updated: '2026-09-14T00:00:00Z',
      },
    },
    links: [],
  });
  wikiRulesQuery.mockResolvedValue({ schemaRaw: '', purposeRaw: '', schemaParse: { ok: true, routing: { typeDirs: {} } } });
  useKbWikiStore.setState({ activePageId: null, activePage: null, pageLoading: false });
});

afterEach(() => {
  useKbWikiGraphStore.getState().reset();
});

async function renderGraph(onOpenPage = vi.fn()) {
  const view = render(<KbWikiGraph onOpenPage={onOpenPage} />);
  await screen.findByTestId('kb-wiki-graph');
  await waitFor(() => expect(fakeState.rendererCalls.length).toBeGreaterThan(0));
  return { view, onOpenPage };
}

describe('KbWikiGraph — 画布模式（WebGL 可用）', () => {
  it('用主进程快照建图，并把邻接与社区写入画布', async () => {
    await renderGraph();
    const options = lastRendererOptions();
    expect(options.onNodeClick).toBeTypeOf('function');
    // 社区统计进入图例：社区 0 有 3 页
    expect(screen.getByTestId('kb-graph-color-mode')).toBeInTheDocument();
    await waitFor(() => expect(useKbWikiGraphStore.getState().communities).toHaveLength(2));
  });

  it('点击节点后详情面板给出度数、社区与一跳邻居，并可跳转知识页', async () => {
    const onOpenPage = vi.fn();
    await renderGraph(onOpenPage);

    act(() => lastRendererOptions().onNodeClick?.('concepts/hub'));

    const detail = await screen.findByTestId('kb-graph-detail');
    expect(detail).toHaveTextContent('时钟复位枢纽');
    expect(detail).toHaveTextContent('度数 3');
    expect(detail).toHaveTextContent('社区 0');
    expect(onOpenPage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('kb-graph-detail-open-page'));
    expect(onOpenPage).toHaveBeenCalledWith('concepts/hub');
  });

  it('节点跳转会聚焦相机（选择即聚焦，spec §9「点击线索聚焦」）', async () => {
    await renderGraph();
    act(() => lastRendererOptions().onNodeClick?.('entities/axi'));
    await waitFor(() => expect(fakeState.focused).toContain('entities/axi'));
  });

  it('桥接节点线索在详情中标注为启发式建议且不阻断发布', async () => {
    await renderGraph();
    await waitFor(() => expect(useKbWikiGraphStore.getState().findings).toHaveLength(1));
    act(() => lastRendererOptions().onNodeClick?.('concepts/hub'));
    const hint = await screen.findByTestId('kb-graph-detail-bridge-hint');
    expect(hint).toHaveTextContent('启发式建议');
    expect(hint).toHaveTextContent('不阻断发布');
  });

  it('类型过滤只保留命中的节点，边随之收敛', async () => {
    await renderGraph();
    fireEvent.click(screen.getByTestId('kb-graph-type-source'));
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 1 页');
    });
    await waitFor(() => {
      expect(lastHighlight().hidden.has('concepts/hub')).toBe(true);
    });

    fireEvent.click(screen.getByTestId('kb-graph-type-source'));
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 4 页');
    });
  });

  it('关键词过滤命中标题、pageId 与页面关键词', async () => {
    await renderGraph();
    fireEvent.change(screen.getByTestId('kb-graph-keyword'), { target: { value: 'clkmgr' } });
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 1 页');
    });
    fireEvent.change(screen.getByTestId('kb-graph-keyword'), { target: { value: '不存在的词' } });
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 0 页');
    });
  });

  it('社区过滤与着色模式可切换（社区颜色可演示）', async () => {
    await renderGraph();
    await waitFor(() => expect(useKbWikiGraphStore.getState().communities).toHaveLength(2));

    fireEvent.click(screen.getByTestId('kb-graph-color-community'));
    expect(useKbWikiGraphStore.getState().colorMode).toBe('community');

    fireEvent.change(screen.getByTestId('kb-graph-community-filter'), { target: { value: '1' } });
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 1 页');
    });
  });

  it('一键清除全部过滤条件（类型/关键词/社区）', async () => {
    await renderGraph();
    expect(screen.queryByTestId('kb-graph-clear-filter')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('kb-graph-type-source'));
    fireEvent.change(screen.getByTestId('kb-graph-keyword'), { target: { value: '手册' } });
    const clear = await screen.findByTestId('kb-graph-clear-filter');

    fireEvent.click(clear);

    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 4 页');
    });
    expect(useKbWikiGraphStore.getState().filter).toEqual({ types: null, keyword: '', communityId: null });
    expect(screen.queryByTestId('kb-graph-clear-filter')).not.toBeInTheDocument();
  });

  it('记录首个可交互画面耗时（不是组件挂载耗时）', async () => {
    await renderGraph();
    expect(screen.getByTestId('kb-graph-diagnostics')).not.toHaveTextContent('首帧');
    act(() => lastRendererOptions().onFirstFrame?.());
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-diagnostics')).toHaveTextContent('首帧');
    });
    expect(useKbWikiGraphStore.getState().firstFrameMs).not.toBeNull();
  });

  it('布局在 worker 中运行，结果写回画布并标记通道', async () => {
    await renderGraph();
    await waitFor(() => expect(fakeState.workers).toHaveLength(1));
    const worker = fakeState.workers[0]!;
    await waitFor(() => expect(worker.posted.length).toBeGreaterThan(0));

    act(() => {
      worker.onmessage?.({
        data: { key: worker.posted.at(-1)!.key, positions: [{ id: 'concepts/hub', x: 1, y: 2 }] },
      } as MessageEvent<unknown>);
    });

    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-layout-channel')).toHaveTextContent('worker');
    });
    expect(fakeState.appliedPositions.at(-1)).toBe(1);
  });

  it('worker 失败时回退主线程布局并把错误显示出来', async () => {
    await renderGraph();
    await waitFor(() => expect(fakeState.workers).toHaveLength(1));
    act(() => {
      fakeState.workers[0]!.onerror?.({ message: '模块加载失败' } as ErrorEvent);
    });
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-layout-channel')).toHaveTextContent('主线程回退');
    });
    expect(screen.getByTestId('kb-graph-layout-error')).toHaveTextContent('模块加载失败');
  });

  it('大图先按预算过滤，展开后隐藏数量下降', async () => {
    const many = {
      ...makeSnapshot(),
      nodes: Array.from({ length: 600 }, (_, i) => NODE(`concepts/p${String(i).padStart(4, '0')}`, 'concept', `页 ${i}`)),
      edges: Array.from({ length: 599 }, (_, i) => ({
        source: `concepts/p${String(i).padStart(4, '0')}`,
        target: `concepts/p${String(i + 1).padStart(4, '0')}`,
      })),
    };
    wikiGraphQuery.mockResolvedValue(many);
    await renderGraph();

    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('其余 200 页待展开');
    });
    // 预算外的节点由 reducer 隐藏，而不是继续画在画布上
    await waitFor(() => expect(lastHighlight().hidden.size).toBe(200));

    fireEvent.click(screen.getByTestId('kb-graph-expand'));
    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-coverage')).toHaveTextContent('共 600 页');
    });
    expect(lastHighlight().hidden.size).toBe(0);
  });

  it('拖动节点后暴露手动布局状态并支持回到自动布局', async () => {
    await renderGraph();
    expect(screen.queryByTestId('kb-graph-manual-layout')).not.toBeInTheDocument();

    act(() => lastRendererOptions().onNodeDragEnd?.('concepts/hub', { x: 42, y: -7 }));

    const notice = await screen.findByTestId('kb-graph-manual-layout');
    expect(notice).toHaveTextContent('已手动调整 1 个节点');

    const appliedBefore = fakeState.appliedPositions.length;
    fireEvent.click(screen.getByTestId('kb-graph-reset-layout'));

    await waitFor(() => {
      expect(screen.queryByTestId('kb-graph-manual-layout')).not.toBeInTheDocument();
    });
    // 重置会把全部节点按确定性初始坐标写回画布（不只是被拖的那个）
    await waitFor(() => expect(fakeState.appliedPositions.length).toBeGreaterThan(appliedBefore));
    expect(fakeState.appliedPositions.at(-1)).toBe(4);
  });
});

describe('KbWikiGraph — 邻接列表降级', () => {
  it('WebGL 不可用时直接给出邻接列表与原因', async () => {
    fakeState.webglSupport = 'none';
    render(<KbWikiGraph />);
    await screen.findByTestId('kb-wiki-graph');

    const notice = await screen.findByTestId('kb-graph-webgl-notice');
    expect(notice).toHaveTextContent('不可用 WebGL');
    expect(fakeState.rendererCalls).toHaveLength(0);

    // 邻接列表与画布等价：出入链与度数都在
    const row = await screen.findByTestId('kb-graph-adjacency-row-concepts/hub');
    expect(row).toHaveTextContent('时钟复位枢纽');
    expect(row).toHaveTextContent('AXI 总线');
  });

  it('渲染器初始化失败时降级为邻接列表并保留错误信息', async () => {
    fakeState.rendererFailure = 'WebGL 上下文创建失败';
    render(<KbWikiGraph />);
    await screen.findByTestId('kb-wiki-graph');

    await waitFor(() => {
      expect(screen.getByTestId('kb-graph-webgl-notice')).toHaveTextContent('WebGL 上下文创建失败');
    });
    expect(await screen.findByTestId('kb-graph-adjacency')).toBeInTheDocument();
  });

  it('可以手动在画布与列表之间切换（保留图数据，不需要重建）', async () => {
    await renderGraph();
    fireEvent.click(screen.getByTestId('kb-graph-toggle-list'));
    expect(await screen.findByTestId('kb-graph-adjacency')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('kb-graph-toggle-list'));
    await waitFor(() => {
      expect(screen.queryByTestId('kb-graph-adjacency')).not.toBeInTheDocument();
    });
  });

  it('邻接列表中选中节点后可跳转知识页', async () => {
    fakeState.webglSupport = 'none';
    const onOpenPage = vi.fn();
    render(<KbWikiGraph onOpenPage={onOpenPage} />);
    const row = await screen.findByTestId('kb-graph-adjacency-row-concepts/hub');
    fireEvent.click(withinRow(row, '时钟复位枢纽'));
    fireEvent.click(await screen.findByTestId('kb-graph-detail-open-page'));
    expect(onOpenPage).toHaveBeenCalledWith('concepts/hub');
  });
});

describe('KbWikiGraph — 生命周期', () => {
  it('卸载时终止 worker、kill 渲染器并释放 WebGL 上下文', async () => {
    const { view } = await renderGraph();
    await waitFor(() => expect(fakeState.workers).toHaveLength(1));
    const worker = fakeState.workers[0]!;

    view.unmount();

    expect(worker.terminateCount).toBeGreaterThan(0);
    expect(fakeState.rendererKills).toBeGreaterThan(0);
    expect(fakeState.releasedContexts.length).toBeGreaterThan(0);
  });

  it('切库/重开图（revision 变化）重建画布并重新启动 worker，不串 revision', async () => {
    await renderGraph();
    await waitFor(() => expect(fakeState.workers).toHaveLength(1));
    const firstWorker = fakeState.workers[0]!;
    const firstRenderer = lastRendererOptions();

    act(() => {
      useKbWikiGraphStore.setState({ snapshot: makeSnapshot(8, 'kb-1') });
    });

    await waitFor(() => expect(fakeState.rendererCalls.length).toBeGreaterThan(1));
    expect(lastRendererOptions()).not.toBe(firstRenderer);
    expect(firstWorker.terminateCount).toBeGreaterThan(0);
    await waitFor(() => expect(fakeState.workers.length).toBeGreaterThan(1));
  });

  it('重新读取同一 revision 时保留选中与布局通道（不误判为切换）', async () => {
    await renderGraph();
    act(() => lastRendererOptions().onNodeClick?.('entities/axi'));
    await waitFor(() => expect(useKbWikiGraphStore.getState().selectedPageId).toBe('entities/axi'));

    await act(async () => {
      await useKbWikiGraphStore.getState().load();
    });

    expect(useKbWikiGraphStore.getState().selectedPageId).toBe('entities/axi');
  });
});

/** 在给定行内按标题找到节点按钮 */
function withinRow(row: HTMLElement, title: string): HTMLElement {
  const button = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === title);
  if (!button) throw new Error(`未找到标题为 ${title} 的节点按钮`);
  return button;
}

describe('KbWikiTab — 图视图入口', () => {
  it('知识图谱作为独立子导航进入，并可跳回知识页阅读', async () => {
    render(<KbWikiTab />);
    fireEvent.click(await screen.findByTestId('kb-wiki-graph-tab'));

    await screen.findByTestId('kb-wiki-graph');
    await waitFor(() => expect(fakeState.rendererCalls.length).toBeGreaterThan(0));

    act(() => lastRendererOptions().onNodeClick?.('entities/axi'));
    fireEvent.click(await screen.findByTestId('kb-graph-detail-open-page'));

    // 跳转回到知识页区并打开了被选中的页
    await waitFor(() => expect(useKbWikiStore.getState().activePageId).toBe('entities/axi'));
    expect(screen.queryByTestId('kb-wiki-graph')).not.toBeInTheDocument();
  });
});
