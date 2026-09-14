/**
 * 冒烟专用 tRPC 替身（spec §11 sigma/CSP/worker spike，issue 26）。
 *
 * 只替换传输层：组件的渲染、交互、worker 与释放路径都走真实实现。
 * 主进程侧的图快照构建/社区分析另有 tests/kb-wiki-graph.test.ts、
 * tests/kb-graph-insights.test.ts 与 tests/kb-router.test.ts 覆盖。
 *
 * 通过 vite alias 注入（见 scripts/build-kb-graph-smoke.mjs）。
 */

import type { WikiGraphViewResult, WikiGraphInsightResult, WikiFindingListResult } from '@shared/kb-types';

type Fixture = {
  graph: WikiGraphViewResult;
  insights: WikiGraphInsightResult;
  findings: WikiFindingListResult;
};

function fixtureSource(): Fixture {
  const fixture = window.__kbGraphSmokeFixture;
  if (!fixture) throw new Error('冒烟 fixture 未注入（window.__kbGraphSmokeFixture）');
  return fixture;
}

export const trpc = {
  kb: {
    wikiGraph: { query: async (): Promise<WikiGraphViewResult> => fixtureSource().graph },
    graphInsights: { mutate: async (): Promise<WikiGraphInsightResult> => fixtureSource().insights },
    lintFindings: { query: async (): Promise<WikiFindingListResult> => fixtureSource().findings },
  },
};
