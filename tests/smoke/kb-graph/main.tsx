/**
 * 冒烟 harness 入口（spec §11 sigma/CSP/worker spike，issue 26）。
 *
 * 在真实 Electron 渲染进程里挂载真实 `KbWikiGraph` 组件（传输层用 stub-trpc
 * 替换），并由外部（Electron 主进程）通过 `window.__kbGraphSmoke` 驱动：
 * 挂载 / 卸载 / 读状态。断言逻辑集中在 scripts/kb-graph-smoke/main.cjs，
 * 这里只暴露最小控制面。
 *
 * 刻意不在 harness 里写断言：断言必须独立于被测代码。
 */

import { createRoot, type Root } from 'react-dom/client';
import { KbWikiGraph } from '@renderer/components/kb/KbWikiGraph';
import { useKbWikiGraphStore } from '@renderer/stores/kb-wiki-graph';
// 与应用完全同一份样式表（见 harness.css 的 @source 说明）：Tailwind 布局类、
// 主题变量、按钮重置都必须真实生效，否则冒烟测到的是一个没有布局的「同组件」
import './harness.css';
import { makeFixture, type KbGraphSmokeFixture, type KbGraphSmokeFixtureName } from './fixtures';

// 应用由 stores/theme.ts 写入 data-theme / data-shade；harness 直接固定深色，
// 让画布取到深色调色板并让 CSS 变量可用。
document.documentElement.dataset.theme = 'bench';
document.documentElement.dataset.shade = 'dark';
document.documentElement.style.colorScheme = 'dark';

export type KbGraphSmokeState = {
  fixture: KbGraphSmokeFixtureName | null;
  loading: boolean;
  error: string | null;
  kbId: string | null;
  revision: number | null;
  nodeCount: number;
  edgeCount: number;
  selectedPageId: string | null;
  colorMode: string;
  firstFrameMs: number | null;
  layoutChannel: string | null;
  layoutError: string | null;
  manualLayoutCount: number;
};

export type KbGraphSmokeController = {
  /** 注入 fixture 并挂载组件（重复调用先卸载） */
  mount: (name: KbGraphSmokeFixtureName) => void;
  /** 卸载组件（触发 worker 终止与 WebGL 释放路径） */
  unmount: () => void;
  /** 直接设置选中节点（用于把目标节点聚焦到视口中心，随后用真实鼠标点击验证命中） */
  select: (pageId: string | null) => void;
  /** 当前 store 状态快照 */
  state: () => KbGraphSmokeState;
  /** fixture 元数据（节点/边数量与预期隐藏数） */
  fixtureInfo: () => { name: string; nodeCount: number; edgeCount: number; expectedHidden: number; hubPageId: string } | null;
  /** 组件「打开知识页」回调收到的 pageId */
  openedPages: () => string[];
  /** 组件挂载起止时间（用于对齐 firstFrameMs 的观测时机） */
  mountedAt: () => number | null;
};

declare global {
  interface Window {
    __kbGraphSmoke?: KbGraphSmokeController;
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('harness 缺少 #root 容器');

let root: Root | null = null;
let currentFixture: KbGraphSmokeFixture | null = null;
let mountedAt: number | null = null;
const openedPages: string[] = [];

const controller: KbGraphSmokeController = {
  mount: (name) => {
    controller.unmount();
    const fixture = makeFixture(name);
    currentFixture = fixture;
    window.__kbGraphSmokeFixture = {
      graph: fixture.graph,
      insights: fixture.insights,
      findings: fixture.findings,
    };
    openedPages.length = 0;
    useKbWikiGraphStore.getState().reset();
    root = createRoot(container);
    mountedAt = performance.now();
    root.render(
      <KbWikiGraph
        onOpenPage={(pageId) => {
          openedPages.push(pageId);
        }}
      />,
    );
  },
  unmount: () => {
    if (!root) return;
    root.unmount();
    root = null;
    mountedAt = null;
  },
  select: (pageId) => {
    useKbWikiGraphStore.getState().selectNode(pageId);
  },
  state: () => {
    const state = useKbWikiGraphStore.getState();
    return {
      fixture: currentFixture?.name ?? null,
      loading: state.loading,
      error: state.error,
      kbId: state.snapshot?.kbId ?? null,
      revision: state.snapshot?.revision ?? null,
      nodeCount: state.snapshot?.nodes.length ?? 0,
      edgeCount: state.snapshot?.edges.length ?? 0,
      selectedPageId: state.selectedPageId,
      colorMode: state.colorMode,
      firstFrameMs: state.firstFrameMs,
      layoutChannel: state.layoutChannel,
      layoutError: state.layoutError,
      manualLayoutCount: state.manualLayoutCount,
    };
  },
  fixtureInfo: () => (currentFixture === null ? null : {
    name: currentFixture.name,
    nodeCount: currentFixture.nodeCount,
    edgeCount: currentFixture.edgeCount,
    expectedHidden: currentFixture.expectedHidden,
    hubPageId: currentFixture.hubPageId,
  }),
  openedPages: () => [...openedPages],
  mountedAt: () => mountedAt,
};

window.__kbGraphSmoke = controller;
