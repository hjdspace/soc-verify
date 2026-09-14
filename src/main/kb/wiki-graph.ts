/**
 * Wiki Graph — 知识图谱快照构建与关联检索（spec §8/§9，issue 23）。
 *
 * 一套主进程页面目录与链接解析服务产生图快照，缓存键包含
 * kbId + publishedRevision；renderer 不重新全量读文件建另一张图。
 *
 * 图节点是已发布 pageId，有向边保留引用方向（source → target）；
 * 相关性/社区分析可用无向投影。聚合页和 raw 不作为知识节点。
 *
 * 结构规则（spec §9）：
 *  - `orphan` 为没有其他知识页有效入链
 *  - `no-outlinks` 为没有有效出链
 *  - `broken-link` 包含缺目标和歧义
 *  - 自链不制造有效外部关联
 *
 * Relatedness 四信号（spec §9 初始四信号；SoC 类型亲和为中性）：
 *  1. sharedSources — 共享来源（同 sourceId 且兼容修订）
 *  2. sharedKeywords — 共享关键词
 *  3. linkNeighbor — 图邻居（入/出链一跳）
 *  4. typeAffinity — 类型亲和（本期中性，恒 0 分）
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8/§9
 */

import { assertReadGateOpen, WikiReadGateError } from './read-gate';
import { readWikiManifest } from './wiki-layout';
import { scanWikiCatalog, wikiCatalogLookup } from './wiki-catalog';
import { extractWikiLinks, resolveWikiTarget } from './wikilink';
import type {
  WikiBrokenLink,
  WikiCatalogPage,
  WikiGraphEdge,
  WikiGraphNode,
  WikiGraphSnapshot,
  WikiPageFrontmatter,
  WikiRelatedPage,
  WikiRelatedResult,
  WikiRelatednessSignal,
  WikiSourceRef,
} from '@shared/kb-types';

/** 类型守卫：parse.ok 为 true 的页面 */
type ParsedPage = WikiCatalogPage & {
  parse: { ok: true; frontmatter: WikiPageFrontmatter; body: string };
};

function isParsedPage(page: WikiCatalogPage): page is ParsedPage {
  return page.parse.ok;
}

// ── Relatedness 权重（spec §9 初始四信号；SoC 类型亲和为中性）────

const WEIGHT_SHARED_SOURCES = 1.0;
const WEIGHT_SHARED_KEYWORDS = 0.6;
const WEIGHT_LINK_NEIGHBOR = 0.8;
const WEIGHT_TYPE_AFFINITY = 0.0; // 本期中性，恒 0 分

// ── 图快照缓存（按 kbPath 隔离）──────────────────────────────────

type CachedSnapshot = {
  snapshot: WikiGraphSnapshot;
  /** manifest publish revision at build time */
  revision: number;
};

const snapshotCache = new Map<string, CachedSnapshot>();

/**
 * 获取图快照（带缓存）。
 *
 * 缓存键 = kbPath；命中时检查 manifest.publish.revision 是否变化，
 * 变化则重建。图 revision 落后时调用方应检查 rebuilding 状态。
 */
export async function getWikiGraphSnapshot(kbPath: string): Promise<{
  ok: true;
  snapshot: WikiGraphSnapshot;
  /** 图是否落后于 manifest publish revision */
  rebuilding: boolean;
} | {
  ok: false;
  code: 'catalogFailed' | 'readGateBlocked';
  message: string;
}> {
  // 检查 manifest revision
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) {
    return { ok: false, code: 'catalogFailed', message: '库 manifest 不存在或损坏' };
  }
  const currentRevision = manifest.manifest.publish?.revision ?? 0;

  // 缓存命中
  const cached = snapshotCache.get(kbPath);
  if (cached && cached.revision === currentRevision) {
    return { ok: true, snapshot: cached.snapshot, rebuilding: false };
  }

  // 构建
  const result = await buildWikiGraphSnapshot(kbPath);
  if (!result.ok) return result;

  snapshotCache.set(kbPath, { snapshot: result.snapshot, revision: currentRevision });

  return { ok: true, snapshot: result.snapshot, rebuilding: false };
}

/**
 * 使图快照缓存失效（发布后调用）。
 */
export function invalidateGraphSnapshot(kbPath: string): void {
  snapshotCache.delete(kbPath);
}

// ── 图快照构建 ──────────────────────────────────────────────────

/**
 * 从磁盘构建图快照。
 *
 * 1. 扫描 wiki/ 目录获得编目
 * 2. 为每个解析成功的页面构建节点（含 keywords/sources 副本）
 * 3. 提取 wikilink → resolveWikiTarget → 构建有向边
 * 4. 自链不产生有效边（spec：自链不制造有效外部关联）
 * 5. 断链/歧义收集到 brokenLinks
 */
export async function buildWikiGraphSnapshot(kbPath: string): Promise<{
  ok: true;
  snapshot: WikiGraphSnapshot;
} | {
  ok: false;
  code: 'catalogFailed' | 'readGateBlocked';
  message: string;
}> {
  try {
    await assertReadGateOpen(kbPath);
  } catch (err) {
    if (err instanceof WikiReadGateError) {
      return { ok: false, code: 'readGateBlocked', message: err.message };
    }
    throw err;
  }

  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) {
    return { ok: false, code: 'catalogFailed', message: '库 manifest 不存在或损坏' };
  }

  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) {
    return { ok: false, code: 'catalogFailed', message: 'schema 无法解析，页面目录不可用' };
  }

  const catalog = scan.catalog;
  const lookup = wikiCatalogLookup(catalog);
  const revision = manifest.manifest.publish?.revision ?? 0;
  const kbId = manifest.manifest.kbId;

  // 只收解析成功的页面作为知识节点
  const validPages = catalog.pages.filter(isParsedPage);

  // 初始化节点（含 keywords 和 sources 副本）
  const nodes = new Map<string, WikiGraphNode>();
  for (const page of validPages) {
    const fm = page.parse.frontmatter;
    nodes.set(page.pageId, {
      pageId: page.pageId,
      title: fm.title,
      type: page.type,
      outlinks: [],
      inlinks: [],
      keywords: fm.keywords,
      sources: fm.sources,
    });
  }

  // 提取链接，构建边
  const edges: WikiGraphEdge[] = [];
  const brokenLinks: WikiBrokenLink[] = [];
  const outlinksMap = new Map<string, Set<string>>();
  const inlinksMap = new Map<string, Set<string>>();

  for (const page of validPages) {
    const links = extractWikiLinks(page.parse.body);
    const outSet = new Set<string>();

    for (const link of links) {
      if (link.kind !== 'link') continue; // embed 不计入引用边
      if (link.target.length === 0) continue; // 纯本页 heading 链接

      const resolution = resolveWikiTarget(link.target, lookup);
      if (resolution.status === 'resolved') {
        // 自链不产生有效边
        if (resolution.pageId === page.pageId) continue;
        outSet.add(resolution.pageId);
        edges.push({
          source: page.pageId,
          target: resolution.pageId,
          ...(link.alias ? { alias: link.alias } : {}),
          ...(link.heading ? { heading: link.heading } : {}),
        });
      } else if (resolution.status === 'unresolved') {
        brokenLinks.push({
          source: page.pageId,
          target: link.target,
          status: 'unresolved',
        });
      } else if (resolution.status === 'ambiguous') {
        brokenLinks.push({
          source: page.pageId,
          target: link.target,
          status: 'ambiguous',
          candidates: resolution.candidates,
        });
      }
    }

    outlinksMap.set(page.pageId, outSet);
  }

  // 填充入链
  for (const edge of edges) {
    let inSet = inlinksMap.get(edge.target);
    if (!inSet) {
      inSet = new Set();
      inlinksMap.set(edge.target, inSet);
    }
    inSet.add(edge.source);
  }

  // 写入节点
  for (const [pageId, node] of nodes) {
    const outSet = outlinksMap.get(pageId);
    node.outlinks = outSet ? Array.from(outSet).sort() : [];
    const inSet = inlinksMap.get(pageId);
    node.inlinks = inSet ? Array.from(inSet).sort() : [];
  }

  return {
    ok: true,
    snapshot: { kbId, revision, nodes, edges, brokenLinks },
  };
}

// ── 相关页面计算 ────────────────────────────────────────────────

/**
 * 计算指定页面的相关页面（spec §9 Relatedness 四信号）。
 *
 * 自链不参与。结果按分数降序、同分按 pageId 稳定排序。
 */
export function computeRelatedPages(
  snapshot: WikiGraphSnapshot,
  pageId: string,
): WikiRelatedPage[] {
  const node = snapshot.nodes.get(pageId);
  if (!node) return [];

  const candidates = new Map<string, {
    signals: Set<WikiRelatednessSignal>;
    reasons: string[];
  }>();

  const ensure = (id: string) => {
    if (id === pageId) return null;
    let entry = candidates.get(id);
    if (!entry) {
      entry = { signals: new Set(), reasons: [] };
      candidates.set(id, entry);
    }
    return entry;
  };

  // 1) 图邻居（入链 + 出链一跳）
  for (const outId of node.outlinks) {
    const entry = ensure(outId);
    if (entry && !entry.signals.has('linkNeighbor')) {
      entry.signals.add('linkNeighbor');
      entry.reasons.push(`本页链接到 ${outId}`);
    }
  }
  for (const inId of node.inlinks) {
    const entry = ensure(inId);
    if (entry && !entry.signals.has('linkNeighbor')) {
      entry.signals.add('linkNeighbor');
      entry.reasons.push(`${inId} 链接到本页`);
    }
  }

  // 2) 共享关键词
  const pageKeywords = node.keywords;
  if (pageKeywords.length > 0) {
    const pageKwSet = new Set(pageKeywords.map((k) => k.toLowerCase()));
    for (const [otherId, otherNode] of snapshot.nodes) {
      if (otherId === pageId) continue;
      const shared = otherNode.keywords.filter((k) => pageKwSet.has(k.toLowerCase()));
      if (shared.length > 0) {
        const entry = ensure(otherId);
        if (entry) {
          entry.signals.add('sharedKeywords');
          entry.reasons.push(`共享关键词: ${shared.join(', ')}`);
        }
      }
    }
  }

  // 3) 共享来源
  const pageSources = node.sources;
  if (pageSources.length > 0) {
    const pageSrcSet = new Set(pageSources.map((s: WikiSourceRef) => s.sourceId));
    for (const [otherId, otherNode] of snapshot.nodes) {
      if (otherId === pageId) continue;
      const shared = otherNode.sources.filter((s: WikiSourceRef) => pageSrcSet.has(s.sourceId));
      if (shared.length > 0) {
        const entry = ensure(otherId);
        if (entry) {
          entry.signals.add('sharedSources');
          entry.reasons.push(`共享来源: ${shared.map((s: WikiSourceRef) => s.sourceId).join(', ')}`);
        }
      }
    }
  }

  // 4) 类型亲和（本期中性，恒 0 分——不添加信号）

  // 计算分数
  const results: WikiRelatedPage[] = [];
  for (const [otherId, entry] of candidates) {
    const otherNode = snapshot.nodes.get(otherId);
    if (!otherNode) continue;

    let score = 0;
    if (entry.signals.has('sharedSources')) score += WEIGHT_SHARED_SOURCES;
    if (entry.signals.has('sharedKeywords')) score += WEIGHT_SHARED_KEYWORDS;
    if (entry.signals.has('linkNeighbor')) score += WEIGHT_LINK_NEIGHBOR;
    if (entry.signals.has('typeAffinity')) score += WEIGHT_TYPE_AFFINITY;

    results.push({
      pageId: otherId,
      title: otherNode.title,
      type: otherNode.type,
      score,
      signals: Array.from(entry.signals).sort(),
      reasons: entry.reasons,
    });
  }

  // 按分数降序、同分按 pageId 稳定排序
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.pageId.localeCompare(b.pageId);
  });

  return results;
}

// ── 高层 API：相关页面查询 ───────────────────────────────────────

/**
 * 查询指定页面的相关页面（含断链/歧义信息）。
 *
 * spec：UI 列出相关页与理由，断链/歧义可见。
 */
export async function getRelatedPages(
  kbPath: string,
  pageId: string,
): Promise<WikiRelatedResult> {
  const result = await getWikiGraphSnapshot(kbPath);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const { snapshot } = result;
  if (!snapshot.nodes.has(pageId)) {
    return { ok: false, code: 'unknownPage', message: `页面 ${pageId} 不在已发布目录中` };
  }

  const related = computeRelatedPages(snapshot, pageId);
  // 过滤出与本页相关的断链
  const pageBrokenLinks = snapshot.brokenLinks.filter((bl) => bl.source === pageId);

  return {
    ok: true,
    kbId: snapshot.kbId,
    revision: snapshot.revision,
    pageId,
    related,
    brokenLinks: pageBrokenLinks,
  };
}

// ── 图一跳邻居获取（供搜索扩展使用）──────────────────────────────

/**
 * 获取指定 pageId 的一跳邻居（入链 + 出链），去重。
 * 自链不参与。
 */
export function getOneHopNeighbors(snapshot: WikiGraphSnapshot, pageId: string): string[] {
  const node = snapshot.nodes.get(pageId);
  if (!node) return [];
  const set = new Set<string>([...node.outlinks, ...node.inlinks]);
  set.delete(pageId); // 自链排除
  return Array.from(set).sort();
}
