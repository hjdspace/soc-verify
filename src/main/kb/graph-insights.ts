/**
 * Graph Insights — 图启发式洞察（spec §9，issue 26）。
 *
 * 基于既有图快照与社区统计生成有限数量的知识线索：
 *  - **桥接节点**（bridge-node）：连接多个社区的节点，可为健康枢纽
 *  - **稀疏社区**（sparse-community）：内聚度低的社区
 *
 * 这些洞察是**启发式建议**，不阻断发布（spec §9：图洞察不必须成为阻断发布的问题）。
 * 桥接节点可为健康枢纽——文案明确标注为「启发式建议，桥接节点可为健康枢纽」。
 *
 * 社区检测：对无向投影使用标签传播 + 连通分量混合策略。
 *   - 不连通子图各自为社区（连通分量）
 *   - 连通子图内部用标签传播进一步发现密集子群
 *
 * 桥接节点检测基于结构洞理论：一个节点的邻居如果分属不同社区，
 * 则该节点是连接这些社区的桥接。
 *
 * 聚合页和 raw 不作为知识节点（已在图快照构建时排除）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §9
 */

import { createHash } from 'node:crypto';
import type {
  WikiCommunitySummary,
  WikiGraphInsightOk,
  WikiGraphInsightResult,
  WikiGraphSnapshot,
  WikiStructuralFinding,
} from '@shared/kb-types';
import { computeFindingId } from './structural-lint';
import { buildWikiGraphSnapshot } from './wiki-graph';
import { assertReadGateOpen, WikiReadGateError } from './read-gate';

// ── 无向图构建 ──────────────────────────────────────────────────

/** 无向边 key（规范化：a < b → "a|b"） */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 无向邻接表 */
type UndirectedGraph = {
  adj: Map<string, Set<string>>;
  /** 无向边集合（key = edgeKey(a, b)） */
  edges: Set<string>;
  /** 总无向边数 */
  m: number;
};

function buildUndirected(snapshot: WikiGraphSnapshot): UndirectedGraph {
  const adj = new Map<string, Set<string>>();
  const edges = new Set<string>();

  for (const [pageId] of snapshot.nodes) {
    adj.set(pageId, new Set());
  }

  for (const edge of snapshot.edges) {
    if (!snapshot.nodes.has(edge.source) || !snapshot.nodes.has(edge.target)) continue;
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
    edges.add(edgeKey(edge.source, edge.target));
  }

  return { adj, edges, m: edges.size };
}

// ── 社区检测（连通分量 + 标签传播）──────────────────────────────

/**
 * 检测社区（无向投影）。
 *
 * 策略：先用连通分量将不连通的子图分开，再在每个连通分量内部
 * 用标签传播进一步发现密集子群。
 *
 * 对于两个子图只有一条桥接边连接的情况：
 * - 连通分量会把它们合成一个分量
 * - 标签传播在密集子群间边数很少时可能不会拆分（取决于传播方向）
 * - 因此同时用结构洞方法检测桥接节点（不完全依赖社区归属）
 */
export function detectCommunities(snapshot: WikiGraphSnapshot): WikiCommunitySummary[] {
  const { nodes } = snapshot;

  if (nodes.size === 0) return [];

  const { adj, edges, m } = buildUndirected(snapshot);
  const allPageIds = Array.from(nodes.keys()).sort();

  // 无边图：每个节点自成一个社区
  if (m === 0) {
    return allPageIds.map((pageId, i) => ({
      communityId: i,
      size: 1,
      internalEdges: 0,
      sparse: true,
      members: [pageId],
    }));
  }

  // 1. 连通分量（BFS）
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const startPage of allPageIds) {
    if (visited.has(startPage)) continue;

    const members: string[] = [];
    const queue = [startPage];
    visited.add(startPage);

    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);
      const neighbors = adj.get(current);
      if (neighbors) {
        for (const next of neighbors) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
    }

    members.sort();
    components.push(members);
  }

  // 2. 在每个连通分量内部用标签传播细分社区
  const allCommunities: { members: string[]; internalEdges: number }[] = [];

  for (const component of components) {
    const compSet = new Set(component);

    // 标签传播
    const labels = new Map<string, string>();
    for (const pageId of component) {
      labels.set(pageId, pageId);
    }

    const maxIterations = component.length;
    let changed = true;
    let iter = 0;

    while (changed && iter < maxIterations) {
      changed = false;
      iter++;

      for (const pageId of component) {
        const neighbors = adj.get(pageId);
        if (!neighbors || neighbors.size === 0) continue;

        // 只统计同连通分量内的邻居
        const labelCounts = new Map<string, number>();
        for (const neighbor of neighbors) {
          if (!compSet.has(neighbor)) continue;
          const label = labels.get(neighbor);
          if (label !== undefined) {
            labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
          }
        }

        if (labelCounts.size === 0) continue;

        let bestLabel = '';
        let bestCount = 0;
        for (const [label, count] of labelCounts) {
          if (count > bestCount || (count === bestCount && label < bestLabel)) {
            bestLabel = label;
            bestCount = count;
          }
        }

        if (bestLabel !== labels.get(pageId)) {
          labels.set(pageId, bestLabel);
          changed = true;
        }
      }
    }

    // 收集标签组
    const labelGroups = new Map<string, string[]>();
    for (const pageId of component) {
      const label = labels.get(pageId)!;
      const group = labelGroups.get(label);
      if (group) {
        group.push(pageId);
      } else {
        labelGroups.set(label, [pageId]);
      }
    }

    for (const [, members] of labelGroups) {
      members.sort();
      const memberSet = new Set(members);

      // 计算社区内边数（无向）
      let internalEdges = 0;
      for (const edgeKeyStr of edges) {
        const sep = edgeKeyStr.indexOf('|');
        const a = edgeKeyStr.substring(0, sep);
        const b = edgeKeyStr.substring(sep + 1);
        if (memberSet.has(a) && memberSet.has(b)) {
          internalEdges++;
        }
      }

      allCommunities.push({ members, internalEdges });
    }
  }

  // 3. 构建结果（按大小降序，同大小按最小 pageId）
  allCommunities.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return a.members[0].localeCompare(b.members[0]);
  });

  const result: WikiCommunitySummary[] = allCommunities.map((c, idx) => {
    const maxEdges = c.members.length * (c.members.length - 1) / 2;
    const density = maxEdges > 0 ? c.internalEdges / maxEdges : 0;
    const sparse = c.members.length <= 1 || (c.members.length >= 2 && density < 0.5);

    return {
      communityId: idx,
      size: c.members.length,
      internalEdges: c.internalEdges,
      sparse,
      members: c.members,
    };
  });

  return result;
}

// ── 桥接节点检测 ────────────────────────────────────────────────

/** 桥接节点检测结果 */
export type BridgeNodeInfo = {
  pageId: string;
  /** 连接的社区 ID 列表（>= 2 才是桥接） */
  connectedCommunities: number[];
  /** 用户可见的启发式建议文案 */
  hint: string;
};

/**
 * 检测桥接节点：连接 2 个或以上社区的节点。
 *
 * 桥接节点可为健康枢纽——文案明确标注为启发式建议。
 *
 * 如果社区检测只产生一个社区，使用结构洞方法补充检测：
 * 一个节点是桥接节点，如果它的邻居中存在至少两个邻居之间没有边连接
 * （即该节点跨越了结构洞）。
 */
export function findBridgeNodes(
  snapshot: WikiGraphSnapshot,
  communities: WikiCommunitySummary[],
): BridgeNodeInfo[] {
  // 建立 pageId → communityId 映射
  const pageToCommunity = new Map<string, number>();
  for (const c of communities) {
    for (const member of c.members) {
      pageToCommunity.set(member, c.communityId);
    }
  }

  const bridges: BridgeNodeInfo[] = [];

  // 构建无向邻接表（用于结构洞检测）
  const adj = new Map<string, Set<string>>();
  for (const [pageId] of snapshot.nodes) {
    adj.set(pageId, new Set());
  }
  for (const edge of snapshot.edges) {
    if (!snapshot.nodes.has(edge.source) || !snapshot.nodes.has(edge.target)) continue;
    adj.get(edge.source)!.add(edge.target);
    adj.get(edge.target)!.add(edge.source);
  }

  for (const [pageId, node] of snapshot.nodes) {
    const ownCommunity = pageToCommunity.get(pageId);
    if (ownCommunity === undefined) continue;

    // 方法1：基于社区归属检测桥接
    const connectedCommunities = new Set<number>();
    connectedCommunities.add(ownCommunity);

    for (const outId of node.outlinks) {
      const targetCommunity = pageToCommunity.get(outId);
      if (targetCommunity !== undefined && targetCommunity !== ownCommunity) {
        connectedCommunities.add(targetCommunity);
      }
    }
    for (const inId of node.inlinks) {
      const sourceCommunity = pageToCommunity.get(inId);
      if (sourceCommunity !== undefined && sourceCommunity !== ownCommunity) {
        connectedCommunities.add(sourceCommunity);
      }
    }

    if (connectedCommunities.size >= 2) {
      const communityList = Array.from(connectedCommunities).sort((a, b) => a - b);
      bridges.push({
        pageId,
        connectedCommunities: communityList,
        hint: `启发式建议：此页面连接 ${communityList.length} 个社区，可能是知识网络的健康枢纽。桥接节点可为健康枢纽，此项为启发式建议，不阻断发布。`,
      });
      continue; // 已识别为桥接，跳过结构洞检测
    }

    // 方法2：结构洞检测（当社区检测未能分出多个社区时）
    // 如果节点有 >= 2 个邻居，且这些邻居之间不全部互相连接
    // 则该节点跨越了结构洞，是潜在的桥接节点
    const neighbors = adj.get(pageId);
    if (neighbors && neighbors.size >= 2) {
      const neighborArr = Array.from(neighbors).sort();
      let hasStructuralHole = false;

      // 检查是否存在不互相连接的邻居对
      for (let i = 0; i < neighborArr.length - 1 && !hasStructuralHole; i++) {
        for (let j = i + 1; j < neighborArr.length; j++) {
          const ni = neighborArr[i];
          const nj = neighborArr[j];
          const niNeighbors = adj.get(ni);
          // 如果 ni 和 nj 之间没有边，则存在结构洞
          if (!niNeighbors?.has(nj)) {
            hasStructuralHole = true;
            break;
          }
        }
      }

      if (hasStructuralHole) {
        // 结构洞桥接：只标自身社区（因为只有一个社区）
        // 但仍生成 finding 以提示用户
        bridges.push({
          pageId,
          connectedCommunities: [ownCommunity],
          hint: `启发式建议：此页面的邻居之间存在结构洞（未直接互链），可能是知识网络的健康枢纽。桥接节点可为健康枢纽，此项为启发式建议，不阻断发布。`,
        });
      }
    }
  }

  // 按 pageId 排序，稳定
  bridges.sort((a, b) => a.pageId.localeCompare(b.pageId));
  return bridges;
}

// ── 稀疏社区检测 ────────────────────────────────────────────────

/**
 * 检测稀疏社区：内聚度低的社区。
 *
 * 判定标准：
 *  - 单节点社区（size=1, edges=0）→ 稀疏
 *  - 多节点社区密度 < 0.5 → 稀疏
 *
 * 密度 = internalEdges / (size * (size - 1) / 2)，无向图最大边数。
 */
export function findSparseCommunities(
  communities: WikiCommunitySummary[],
): WikiCommunitySummary[] {
  return communities.filter((c) => c.sparse);
}

// ── 证据 hash ───────────────────────────────────────────────────

/**
 * 计算桥接节点证据 hash。
 *
 * 证据 = 节点的 outlinks + inlinks + 连接的社区列表。
 */
function bridgeNodeEvidenceHash(
  node: { pageId: string; outlinks: string[]; inlinks: string[] },
  connectedCommunities: number[],
): string {
  const material = `${node.pageId}|out:${node.outlinks.join(',')}|in:${node.inlinks.join(',')}|communities:${connectedCommunities.join(',')}`;
  return createHash('sha256').update(material, 'utf-8').digest('hex').slice(0, 16);
}

/**
 * 计算稀疏社区证据 hash。
 *
 * 证据 = 社区成员 + 内部边数。
 */
function sparseCommunityEvidenceHash(
  members: string[],
  internalEdges: number,
): string {
  const material = `members:${members.join(',')}|edges:${internalEdges}`;
  return createHash('sha256').update(material, 'utf-8').digest('hex').slice(0, 16);
}

// ── 图洞察综合 ──────────────────────────────────────────────────

/** 图洞察运行选项 */
export type RunGraphInsightsOptions = {
  /** 注入时钟（测试用） */
  now?: string;
};

/**
 * 从图快照推导图洞察 findings。
 *
 * 生成两类 finding：
 *  1. bridge-node — 连接多个社区的节点（启发式建议，可为健康枢纽）
 *  2. sparse-community — 内聚度低的社区（启发式建议）
 *
 * finding 使用统一身份模型（computeFindingId），接入同一 finding-store。
 * 证据 hash 控制是否仍适用；重复扫描保留 ignored/resolved，证据改变可重开。
 *
 * 图 revision 进入 evidenceRefs，确保切库/重开图不串 revision。
 */
export function detectGraphInsights(
  snapshot: WikiGraphSnapshot,
  now: string,
): WikiGraphInsightOk {
  const { kbId, revision, nodes } = snapshot;

  const communities = detectCommunities(snapshot);
  const bridgeNodes = findBridgeNodes(snapshot, communities);
  const sparseCommunities = findSparseCommunities(communities);

  const findings: WikiStructuralFinding[] = [];

  // 桥接节点 findings
  for (const bridge of bridgeNodes) {
    const node = nodes.get(bridge.pageId);
    if (!node) continue;

    const evidenceRefs = [
      `wiki/${bridge.pageId}.md`,
      `revision:${revision}`,
      `communities:${bridge.connectedCommunities.join(',')}`,
    ];
    const pageIds = [bridge.pageId];

    findings.push({
      findingId: computeFindingId('bridge-node', pageIds, evidenceRefs),
      kbId,
      kind: 'bridge-node',
      pageIds,
      evidenceRefs,
      evidenceHashes: [bridgeNodeEvidenceHash(node, bridge.connectedCommunities)],
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
  }

  // 稀疏社区 findings
  for (const sparse of sparseCommunities) {
    const evidenceRefs = [
      `community:${sparse.communityId}`,
      `revision:${revision}`,
      `members:${sparse.members.join(',')}`,
    ];
    const pageIds = sparse.members;

    findings.push({
      findingId: computeFindingId('sparse-community', pageIds, evidenceRefs),
      kbId,
      kind: 'sparse-community',
      pageIds,
      evidenceRefs,
      evidenceHashes: [sparseCommunityEvidenceHash(sparse.members, sparse.internalEdges)],
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    ok: true,
    kbId,
    revision,
    findings,
    communities,
    ranAt: now,
  };
}

// ── 运行图洞察（从磁盘）────────────────────────────────────────

/**
 * 运行图洞察：从磁盘构建图快照 → 推导洞察 → 返回结果。
 *
 * 不持久化 findings——持久化由 finding-store 负责。
 */
export async function runGraphInsights(
  kbPath: string,
  options?: RunGraphInsightsOptions,
): Promise<WikiGraphInsightResult> {
  // 读取门禁
  try {
    await assertReadGateOpen(kbPath);
  } catch (err) {
    if (err instanceof WikiReadGateError) {
      return { ok: false, code: 'readGateBlocked', message: err.message };
    }
    throw err;
  }

  const result = await buildWikiGraphSnapshot(kbPath);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const { snapshot } = result;
  const now = options?.now ?? new Date().toISOString();

  return detectGraphInsights(snapshot, now);
}
