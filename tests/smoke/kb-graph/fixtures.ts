/**
 * 冒烟 fixture：确定性生成，同一名称每次运行产生完全一致的数据，
 * 因此「首个可交互画面」的测量值可以跨运行比较。
 */

import type {
  WikiCommunitySummary,
  WikiFindingListResult,
  WikiGraphInsightResult,
  WikiGraphViewOk,
  WikiGraphViewNode,
  WikiGraphViewResult,
  WikiPageType,
  WikiStructuralFinding,
} from '@shared/kb-types';

export type KbGraphSmokeFixtureName = 'small' | 'large';

/** 注入给 stub-trpc 的载荷（harness 传输层替身的数据源） */
export type KbGraphSmokePayload = {
  graph: WikiGraphViewResult;
  insights: WikiGraphInsightResult;
  findings: WikiFindingListResult;
};

declare global {
  interface Window {
    __kbGraphSmokeFixture?: KbGraphSmokePayload;
  }
}

export type KbGraphSmokeFixture = {
  name: KbGraphSmokeFixtureName;
  nodeCount: number;
  edgeCount: number;
  /** 期望被预算隐藏的节点数（GRAPH_INITIAL_NODE_BUDGET = 400） */
  expectedHidden: number;
  /** 存在于 fixture 中、可被点击命中的枢纽 pageId */
  hubPageId: string;
  graph: WikiGraphViewOk;
  insights: WikiGraphInsightResult;
  findings: WikiFindingListResult;
};

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function node(pageId: string, type: WikiPageType, title: string, keywords: string[] = []): WikiGraphViewNode {
  return { pageId, title, type, outlinks: [], inlinks: [], keywords };
}

function bridgeFinding(kbId: string, revision: number, hubPageId: string): WikiStructuralFinding {
  return {
    findingId: `bridge:${hubPageId}`,
    kbId,
    kind: 'bridge-node',
    pageIds: [hubPageId],
    evidenceRefs: [`revision:${revision}`, hubPageId],
    evidenceHashes: ['smoke-hash'],
    status: 'open',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
  };
}

function smallFixture(): KbGraphSmokeFixture {
  const nodes: WikiGraphViewNode[] = [
    node('concepts/hub', 'concept', '时钟复位枢纽', ['clkmgr', 'reset']),
    node('entities/axi', 'entity', 'AXI 总线', ['axi']),
    node('entities/apb', 'entity', 'APB 总线', ['apb']),
    node('sources/spec', 'source', '接口手册'),
    node('pitfalls/deadlock', 'pitfall', '死锁陷阱'),
    node('synthesis/clocking', 'synthesis', '时钟方案综述'),
    node('concepts/isolated', 'concept', '孤立概念页'),
    node('queries/why-reset', 'query', '为什么复位要同步'),
  ];
  const edges = [
    { source: 'concepts/hub', target: 'entities/axi' },
    { source: 'concepts/hub', target: 'entities/apb' },
    { source: 'concepts/hub', target: 'pitfalls/deadlock' },
    { source: 'entities/axi', target: 'sources/spec' },
    { source: 'entities/apb', target: 'sources/spec' },
    { source: 'synthesis/clocking', target: 'concepts/hub' },
    { source: 'queries/why-reset', target: 'concepts/hub' },
    { source: 'pitfalls/deadlock', target: 'synthesis/clocking' },
  ];
  const communities: WikiCommunitySummary[] = [
    {
      communityId: 0,
      size: 3,
      internalEdges: 2,
      sparse: false,
      members: ['concepts/hub', 'entities/axi', 'entities/apb'],
    },
    { communityId: 1, size: 3, internalEdges: 2, sparse: false, members: ['sources/spec', 'synthesis/clocking', 'pitfalls/deadlock'] },
    { communityId: 2, size: 2, internalEdges: 1, sparse: true, members: ['queries/why-reset', 'concepts/isolated'] },
  ];
  const kbId = 'kb-smoke-small';
  const revision = 12;
  return {
    name: 'small',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    expectedHidden: 0,
    hubPageId: 'concepts/hub',
    graph: { ok: true, kbId, revision, rebuilding: false, nodes, edges, brokenLinks: [] },
    insights: {
      ok: true,
      kbId,
      revision,
      findings: [bridgeFinding(kbId, revision, 'concepts/hub')],
      communities,
      ranAt: '2026-09-14T00:00:00Z',
    },
    findings: { ok: true, findings: [bridgeFinding(kbId, revision, 'concepts/hub')] },
  };
}

/** 规模对齐 issue 30 的门禁数据：1000 页 / 10000 边。 */
function largeFixture(): KbGraphSmokeFixture {
  const CLUSTERS = 10;
  const PER_CLUSTER = 100;
  const random = lcg(20260914);
  const nodes: WikiGraphViewNode[] = [];
  const members: string[][] = [];

  for (let cluster = 0; cluster < CLUSTERS; cluster++) {
    const group: string[] = [];
    for (let index = 0; index < PER_CLUSTER; index++) {
      const pageId = `concepts/c${cluster}-p${String(index).padStart(3, '0')}`;
      group.push(pageId);
      nodes.push(node(pageId, 'concept', `簇 ${cluster} 页 ${index}`, [`cluster${cluster}`]));
    }
    members.push(group);
  }

  const edgeSet = new Set<string>();
  const edges: Array<{ source: string; target: string }> = [];
  const addEdge = (source: string, target: string): void => {
    if (source === target) return;
    const key = `${source}->${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source, target });
  };

  // 簇内稠密连接（每簇 900 条）
  for (let cluster = 0; cluster < CLUSTERS; cluster++) {
    const group = members[cluster]!;
    let added = 0;
    let guard = 0;
    while (added < 900 && guard < 20000) {
      guard += 1;
      const before = edges.length;
      const a = group[Math.floor(random() * group.length)]!;
      const b = group[Math.floor(random() * group.length)]!;
      addEdge(a, b);
      if (edges.length > before) added += 1;
    }
  }
  // 跨簇连接（约 1000 条）→ 产生桥接节点
  for (let i = 0; i < 1000; i++) {
    const from = members[Math.floor(random() * CLUSTERS)]!;
    const to = members[Math.floor(random() * CLUSTERS)]!;
    addEdge(from[Math.floor(random() * from.length)]!, to[Math.floor(random() * to.length)]!);
  }

  const communities: WikiCommunitySummary[] = members.map((group, communityId) => ({
    communityId,
    size: group.length,
    internalEdges: 0,
    sparse: false,
    members: group,
  }));

  const kbId = 'kb-smoke-large';
  const revision = 33;
  const hubPageId = members[0]![0]!;
  return {
    name: 'large',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    expectedHidden: Math.max(0, nodes.length - 400),
    hubPageId,
    graph: { ok: true, kbId, revision, rebuilding: false, nodes, edges, brokenLinks: [] },
    insights: {
      ok: true,
      kbId,
      revision,
      findings: [bridgeFinding(kbId, revision, hubPageId)],
      communities,
      ranAt: '2026-09-14T00:00:00Z',
    },
    findings: { ok: true, findings: [bridgeFinding(kbId, revision, hubPageId)] },
  };
}

export function makeFixture(name: KbGraphSmokeFixtureName): KbGraphSmokeFixture {
  return name === 'large' ? largeFixture() : smallFixture();
}
