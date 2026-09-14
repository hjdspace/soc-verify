/**
 * kb-wiki-graph store — 知识图谱视图状态（spec §9，issue 26）。
 *
 * 数据链路：tRPC `kb.wikiGraph`（主进程图快照的唯一投影）+
 * `kb.graphInsights`（社区统计与桥接线索）+ `kb.lintFindings`（处置状态）。
 *
 * 视图状态（过滤、预算、着色模式、选中）只活在 renderer；主进程不因为
 * 用户拖拽或过滤而重算图。切库/重开图时 `reset()` 清空，避免把旧库的
 * 过滤与选中带到新库。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import {
  EMPTY_GRAPH_FILTER,
  GRAPH_EXPAND_STEP,
  GRAPH_INITIAL_NODE_BUDGET,
  communityByPage,
  type GraphColorMode,
  type GraphFilter,
} from '@renderer/lib/kb-wiki-graph';
import type {
  WikiCommunitySummary,
  WikiGraphViewOk,
  WikiPageType,
  WikiStructuralFinding,
} from '@shared/kb-types';

/** 布局实际由谁完成（worker 失败时回退主线程，需要可见）。 */
export type GraphLayoutChannel = 'worker' | 'main-thread';

export type KbWikiGraphState = {
  /** 当前快照（含 kbId + revision，切库/重开图必须整体替换） */
  snapshot: WikiGraphViewOk | null;
  loading: boolean;
  /** 读取失败信息（主进程返回的错误或异常） */
  error: string | null;

  /** 社区统计（来自 kb.graphInsights） */
  communities: WikiCommunitySummary[];
  /** 图洞察 findings（桥接节点/稀疏社区），与结构 lint 共享存储 */
  findings: WikiStructuralFinding[];
  insightsRunning: boolean;
  insightsError: string | null;

  /** 过滤与展示 */
  filter: GraphFilter;
  colorMode: GraphColorMode;
  /** 当前节点预算（大图先过滤/按需展开） */
  nodeBudget: number;
  selectedPageId: string | null;

  /** 布局诊断 */
  layoutChannel: GraphLayoutChannel | null;
  layoutError: string | null;
  /** 首个可交互画面的耗时（ms），门禁测的是这个 */
  firstFrameMs: number | null;
  /** 最近一次 load 开始的时间戳；首个可交互画面从数据请求起算 */
  loadStartedAt: number | null;
  /** 用户手动拖动过的节点数（>0 时画布布局已偏离自动布局） */
  manualLayoutCount: number;
  /** 递增即要求画布重新按自动布局摆放节点 */
  layoutResetToken: number;

  load: () => Promise<void>;
  runInsights: () => Promise<void>;
  setKeyword: (keyword: string) => void;
  setTypes: (types: WikiPageType[] | null) => void;
  toggleType: (type: WikiPageType) => void;
  setCommunityFilter: (communityId: number | null) => void;
  /** 一键清空全部过滤条件（类型/关键词/社区） */
  clearFilter: () => void;
  setColorMode: (mode: GraphColorMode) => void;
  selectNode: (pageId: string | null) => void;
  expand: () => void;
  collapse: () => void;
  setLayoutChannel: (channel: GraphLayoutChannel, error?: string | null) => void;
  setFirstFrameMs: (ms: number) => void;
  noteManualLayout: () => void;
  resetLayout: () => void;
  reset: () => void;
};

const initialState = {
  snapshot: null,
  loading: false,
  error: null,
  communities: [] as WikiCommunitySummary[],
  findings: [] as WikiStructuralFinding[],
  insightsRunning: false,
  insightsError: null,
  filter: EMPTY_GRAPH_FILTER,
  colorMode: 'type' as GraphColorMode,
  nodeBudget: GRAPH_INITIAL_NODE_BUDGET,
  selectedPageId: null,
  layoutChannel: null,
  layoutError: null,
  firstFrameMs: null,
  loadStartedAt: null,
  manualLayoutCount: 0,
  layoutResetToken: 0,
};

export const useKbWikiGraphStore = create<KbWikiGraphState>((set, get) => ({
  ...initialState,

  load: async () => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    set({ loading: true, error: null, loadStartedAt: startedAt });
    try {
      const result = await trpc.kb.wikiGraph.query({});
      if (!result.ok) {
        set({ snapshot: null, loading: false, error: result.message });
        return;
      }
      const previous = get().snapshot;
      // 切库/重开图：revision 或 kbId 变化时清掉选中与布局诊断，
      // 否则旧库的选中节点会指向新库不存在的 pageId
      const sameGraph = previous?.kbId === result.kbId && previous.revision === result.revision;
      set({
        snapshot: {
          ok: true,
          kbId: result.kbId,
          revision: result.revision,
          rebuilding: result.rebuilding,
          nodes: result.nodes,
          edges: result.edges,
          brokenLinks: result.brokenLinks,
        },
        loading: false,
        error: null,
        nodeBudget: sameGraph ? get().nodeBudget : GRAPH_INITIAL_NODE_BUDGET,
        selectedPageId: sameGraph ? get().selectedPageId : null,
        layoutChannel: sameGraph ? get().layoutChannel : null,
        layoutError: sameGraph ? get().layoutError : null,
        firstFrameMs: sameGraph ? get().firstFrameMs : null,
        communities: sameGraph ? get().communities : [],
        findings: sameGraph ? get().findings : [],
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '读取知识图谱失败',
      });
    }
  },

  runInsights: async () => {
    set({ insightsRunning: true, insightsError: null });
    try {
      const result = await trpc.kb.graphInsights.mutate({});
      if (!result.ok) {
        set({ insightsRunning: false, insightsError: result.message });
        return;
      }
      // findings 的处置状态由知识待办拥有，这里只读一次用于桥接高亮
      const list = await trpc.kb.lintFindings.query({});
      set({
        insightsRunning: false,
        communities: result.communities,
        findings: list.ok ? list.findings : result.findings,
      });
    } catch (err) {
      set({
        insightsRunning: false,
        insightsError: err instanceof Error ? err.message : '图洞察运行失败',
      });
    }
  },

  setKeyword: (keyword) => set({ filter: { ...get().filter, keyword } }),

  setTypes: (types) => set({ filter: { ...get().filter, types } }),

  toggleType: (type) => {
    const current = get().filter.types;
    // 未指定 = 全选；点第一个变成「只选它」，再点取消回到全选
    if (current === null) {
      set({ filter: { ...get().filter, types: [type] } });
      return;
    }
    const next = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    set({ filter: { ...get().filter, types: next.length === 0 ? null : next } });
  },

  setCommunityFilter: (communityId) => set({ filter: { ...get().filter, communityId } }),

  clearFilter: () => set({ filter: EMPTY_GRAPH_FILTER }),

  setColorMode: (colorMode) => set({ colorMode }),

  selectNode: (pageId) => set({ selectedPageId: pageId }),

  expand: () => set({ nodeBudget: get().nodeBudget + GRAPH_EXPAND_STEP }),

  collapse: () => set({ nodeBudget: GRAPH_INITIAL_NODE_BUDGET }),

  setLayoutChannel: (channel, error = null) => set({ layoutChannel: channel, layoutError: error }),

  setFirstFrameMs: (firstFrameMs) => set({ firstFrameMs }),

  noteManualLayout: () => set({ manualLayoutCount: get().manualLayoutCount + 1 }),

  resetLayout: () => set({
    manualLayoutCount: 0,
    layoutResetToken: get().layoutResetToken + 1,
  }),

  reset: () => set({ ...initialState, filter: EMPTY_GRAPH_FILTER }),
}));

/** 社区归属映射（pageId → communityId）；不在组件 selector 中新建对象。 */
export function graphCommunityMap(
  communities: readonly WikiCommunitySummary[],
): Map<string, number> {
  return communityByPage(communities);
}
