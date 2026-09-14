/**
 * Wiki Search — 统一关键词 + 向量混合检索服务（spec §8，issue 14/24）。
 *
 * 用户（tRPC kb.wikiSearch）与 Agent（kb_search Host Tool）共用同一个
 * 服务与排序实现，不复制第二套排名：
 *
 *  1. 元数据（标题/keywords/summary/tags）与正文合为**一份排名**；
 *     中文按相邻双字 bigram 匹配（单字低权重兜底），`AWLEN`、`[7:0]`、
 *     `0x10`、`tRCD` 等按原样精确匹配（分词不拆 `[`、`]`、`:`、`.`）。
 *  2. 只检索**已发布 wiki 页**（staging/历史/log/聚合页/orphan 一律排除）
 *     与**当前可用 parsed**（raw/parsed 下、manifest 中存在的来源；
 *     历史修订只有显式原文定位才读）。
 *  3. 去重、topK 限量（默认 20，1–50），同分按 `(kind, id)` 规范身份
 *     稳定排序。
 *  4. 无嵌入也能检索（mode='keyword'）；有嵌入时关键词/向量 RRF k=60
 *     融合（mode='hybrid'），向量结果先按页聚合再 RRF（issue 24）。
 *  5. stale 由 frontmatter sources 与 manifest 当前修订**动态核对**：
 *     页面来源引用的修订与 manifest 当前修订不一致（或来源已删除）时
 *     标记 stale，不信任缓存结果。
 *  6. 嵌入降级（未配置/401/坏模型/429/网络）时关键词/图保持可用，
 *     vectorStatus.degraded=true 并按库配置提示一次（issue 24）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8
 */

import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { assertReadGateOpen, WikiReadGateError } from './read-gate';
import { readWikiManifest, wikiLayout } from './wiki-layout';
import { scanWikiCatalog } from './wiki-catalog';
import { getWikiGraphSnapshot, getOneHopNeighbors } from './wiki-graph';
import type { EmbeddingService } from './embedding-service';
import type {
  EmbeddingErrorKind,
  EmbeddingRuntimeConfig,
  VectorPageResult,
  VectorSearchStatus,
  WikiGraphExpansionInfo,
  WikiGraphRelatedTo,
  WikiSearchError,
  WikiSearchHit,
  WikiSearchMode,
  WikiSearchOptions,
  WikiSearchOutcome,
  WikiSourceRef,
} from '@shared/kb-types';

// ── 评分权重（与旧 searcher 同量级，保证行为连续）───────────────

const SCORE_TITLE = 10;
const SCORE_KEYWORD = 5;
const SCORE_SUMMARY = 3;
const SCORE_TAG = 5;
const SCORE_FULLTEXT = 1;
/** CJK 单字 token 的得分权重（单字命中噪音大） */
const SCORE_CJK_CHAR_WEIGHT = 0.2;

const DEFAULT_TOP_K = 20;
const MAX_TOP_K = 50;
const SNIPPET_MAX_CHARS = 400;

/** RRF k 常数（spec §8.2: sum(1/(60+rank))） */
const RRF_K = 60;

/** 搜索上下文（issue 24：向量混合搜索注入） */
export type SearchContext = {
  /** 嵌入服务实例（提供向量搜索能力） */
  embeddingService: EmbeddingService;
  /** 嵌入运行时配置 */
  embeddingCfg: EmbeddingRuntimeConfig;
};

// ── 分词与匹配 ──────────────────────────────────────────────────

/**
 * 将查询拆为搜索词：按空白/常见标点分词，中文按相邻双字 bigram 拆分。
 * `[`、`]`、`:`、`.`、`_`、`-` 不参与分词——`[7:0]`、`0x10`、`tRCD`、
 * `AWLEN` 等原样保留，做精确子串匹配（大小写不敏感）。
 */
export function tokenizeQuery(query: string): string[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];

  const tokens = lower.split(/[\s,，、;；|/]+/).filter(Boolean);

  const result = new Set<string>();
  for (const token of tokens) {
    result.add(token);
    const chineseChars = token.match(/[\u4e00-\u9fa5]/g);
    if (chineseChars && chineseChars.length > 1) {
      for (let i = 0; i < chineseChars.length - 1; i++) {
        result.add(chineseChars[i] + chineseChars[i + 1]);
      }
      // 单字兜底（得分时按 SCORE_CJK_CHAR_WEIGHT 降权）
      for (const ch of chineseChars) {
        result.add(ch);
      }
    }
  }
  return Array.from(result);
}

/** CJK 单字 token 降权，其余权重 1 */
function tokenWeight(token: string): number {
  return token.length === 1 && /[\u4e00-\u9fa5]/.test(token) ? SCORE_CJK_CHAR_WEIGHT : 1;
}

/** 加权命中计数（每次命中 1 分，CJK 单字按 0.2 折算） */
function countMatches(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (lower.includes(token)) score += tokenWeight(token);
  }
  return score;
}

/** 从正文中提取首个命中行附近的片段（无命中返回 null） */
function extractSnippet(text: string, tokens: string[]): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (tokens.some((t) => t.length > 0 && lower.includes(t))) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 2);
      const snippet = lines.slice(start, end).join(' ⏎ ').trim();
      return snippet.length > 0 ? snippet.slice(0, SNIPPET_MAX_CHARS) : null;
    }
  }
  return null;
}

/** stale：来源引用与 manifest 当前修订动态核对 */
function isStale(refs: WikiSourceRef[], sources: Record<string, { currentRevision: string }> | undefined): boolean {
  if (!sources) return refs.length > 0;
  return refs.some((r) => {
    const rec = sources[r.sourceId];
    return !rec || rec.currentRevision !== r.sourceRevision;
  });
}

// ── 主服务 ──────────────────────────────────────────────────────

/**
 * 统一关键词 + 向量混合检索：已发布 wiki 页 + 当前 parsed 来源全文。
 *
 * @param kbPath 当前挂载库根目录（每次调用由调用方从 registry 动态解析）
 * @param options 查询与筛选
 * @param ctx 搜索上下文（issue 24：注入嵌入服务以启用向量混合搜索）
 */
export async function searchWiki(
  kbPath: string,
  options: WikiSearchOptions,
  ctx?: SearchContext,
): Promise<WikiSearchOutcome> {
  const query = options.query.trim();
  if (!query) {
    return fail('emptyQuery', 'query 不能为空');
  }

  try {
    await assertReadGateOpen(kbPath);
  } catch (err) {
    if (err instanceof WikiReadGateError) {
      return fail('readGateBlocked', err.message);
    }
    throw err;
  }

  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) {
    return fail('catalogFailed', manifest.reason === 'missing' ? '库 manifest 不存在' : '库 manifest 损坏');
  }
  const manifestSources = manifest.manifest.sources ?? {};

  const scan = await scanWikiCatalog(kbPath);
  if (!scan.ok) {
    return fail('catalogFailed', 'schema 无法解析，页面目录不可用');
  }
  const catalog = scan.catalog;

  const tokens = tokenizeQuery(query);
  const wantWiki = options.kind !== 'parsed';
  const wantParsed = options.kind !== 'wiki';
  const hits: WikiSearchHit[] = [];
  const layout = wikiLayout(kbPath);

  // ── 已发布 wiki 页（排除聚合页/orphan/坏元数据页；staging/历史
  //    在 .kb/ 与 .kb/page-history 下，本就不在 wiki/ 编目范围）────
  if (wantWiki) {
    for (const page of catalog.pages) {
      if (!page.parse.ok) continue; // 坏元数据页不静默参与检索
      if (options.pageType && page.type !== options.pageType) continue;
      const fm = page.parse.frontmatter;
      if (options.tag && !fm.tags.includes(options.tag)) continue;

      const metaScore =
        countMatches(fm.title, tokens) * SCORE_TITLE +
        countMatches(fm.keywords.join(' '), tokens) * SCORE_KEYWORD +
        countMatches(fm.summary, tokens) * SCORE_SUMMARY +
        countMatches(fm.tags.join(' '), tokens) * SCORE_TAG;
      const bodyMatches = countMatches(page.parse.body, tokens);
      if (metaScore <= 0 && bodyMatches <= 0) continue;

      hits.push({
        kind: 'wiki',
        id: page.pageId,
        relativePath: page.relPath.replace(/\\/g, '/'),
        absolutePath: join(layout.kbPath, page.relPath),
        title: fm.title,
        snippet: bodyMatches > 0 ? extractSnippet(page.parse.body, tokens) : null,
        pageType: page.type,
        tags: fm.tags,
        keywords: fm.keywords,
        sourceRefs: fm.sources,
        stale: isStale(fm.sources, manifestSources),
        score: metaScore + bodyMatches * SCORE_FULLTEXT,
      });
    }
  }

  // ── 当前可用 parsed（raw/parsed 下、manifest 中存在的来源全文）──
  let parsedCount = 0;
  if (wantParsed) {
    const parsedList = await listCurrentParsed(layout, manifestSources);
    parsedCount = parsedList.length;
    for (const parsed of parsedList) {
      const titleScore = countMatches(parsed.title, tokens) * SCORE_TITLE;
      const bodyMatches = countMatches(parsed.content, tokens);
      if (titleScore <= 0 && bodyMatches <= 0) continue;

      hits.push({
        kind: 'parsed',
        id: parsed.sourceId,
        relativePath: `raw/parsed/${parsed.relPath}`,
        absolutePath: join(layout.rawParsedDir, parsed.relPath),
        title: parsed.title,
        snippet: bodyMatches > 0 ? extractSnippet(parsed.content, tokens) : null,
        stale: false,
        sourceRevision: parsed.parsedRevision,
        score: titleScore + bodyMatches * SCORE_FULLTEXT,
      });
    }
  }

  // ── 去重 + 稳定排序 + topK ────────────────────────────────────
  const deduped = new Map<string, WikiSearchHit>();
  for (const hit of hits) {
    deduped.set(`${hit.kind}:${hit.id}`, hit); // 规范身份去重
  }
  const topK = clampTopK(options.topK);

  // 关键词排名（按原始 score 降序，同分按规范身份稳定排序）
  const keywordRanked = Array.from(deduped.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  });

  // ── 向量搜索 + RRF 融合（issue 24，spec §8.2）─────────────────
  // 向量按 chunk 检索，先按 pageId 聚合为页面候选，再与关键词排名做
  // sum(1/(60+rank))。缺一个信号时保持已有信号排名，缺失值不计票。
  // 嵌入降级（未配置/失败）时关键词/图保持可用，vectorStatus.degraded=true。
  let vectorStatus: VectorSearchStatus | undefined;
  let vectorResults: VectorPageResult[] = [];
  let vectorPageHits = 0;

  if (ctx) {
    const revision = options.revision;
    const vecResult = await ctx.embeddingService.searchByQuery(
      manifest.manifest.kbId,
      query,
      ctx.embeddingCfg,
      topK,
      revision,
    );

    if (vecResult.degraded) {
      // 降级：关键词/图保持可用，提示一次
      // 推断降级原因
      let errorKind: EmbeddingErrorKind | undefined;
      let degradeReason: string | undefined;
      if (!ctx.embeddingCfg.endpoint || !ctx.embeddingCfg.apiKey || !ctx.embeddingCfg.model) {
        errorKind = 'notConfigured';
        degradeReason = '嵌入端点未配置';
      } else {
        // 查看索引错误状态以推断原因
        const status = await ctx.embeddingService.getIndexStatus(
          manifest.manifest.kbId,
          ctx.embeddingCfg,
        );
        if (status.errorStatus && status.errorStatus.kind) {
          errorKind = status.errorStatus.kind;
          degradeReason = status.errorStatus.message;
        } else {
          errorKind = 'network';
          degradeReason = '向量搜索降级';
        }
      }
      vectorStatus = {
        degraded: true,
        ...(degradeReason ? { degradeReason } : {}),
        ...(errorKind ? { errorKind } : {}),
        vectorPageHits: 0,
      };
    } else {
      vectorResults = vecResult.results;
      // 过滤不在 catalog 中的页面（失效向量过滤）
      const validPageIds = new Set(catalog.pages.filter((p) => p.parse.ok).map((p) => p.pageId));
      vectorResults = vectorResults.filter((r) => validPageIds.has(r.id));
      vectorPageHits = vectorResults.length;
      vectorStatus = {
        degraded: false,
        vectorPageHits,
      };
    }
  }

  // ── RRF 融合 ──────────────────────────────────────────────────
  // 关键词排名和向量排名通过 RRF sum(1/(60+rank)) 融合。
  // 缺一个信号时保持已有信号排名，缺失值不计票。
  // 向量结果先按页聚合（searchByQuery 已做 per-page 聚合）。
  let baseHits: WikiSearchHit[];
  let mode: WikiSearchMode;

  if (vectorStatus && !vectorStatus.degraded && vectorResults.length > 0) {
    // RRF 融合
    const kwRankMap = new Map<string, number>();
    keywordRanked.forEach((hit, rank) => {
      kwRankMap.set(`${hit.kind}:${hit.id}`, rank);
    });

    const vecRankMap = new Map<string, number>();
    vectorResults.forEach((vr, rank) => {
      vecRankMap.set(`wiki:${vr.id}`, rank);
    });

    // 收集所有出现在任一排名中的身份
    const allKeys = new Set<string>([...kwRankMap.keys(), ...vecRankMap.keys()]);

    // 计算 RRF 分数
    const rrfScored: Array<{ key: string; rrfScore: number; hit?: WikiSearchHit; vecResult?: VectorPageResult }> = [];
    for (const key of allKeys) {
      let rrfScore = 0;
      const kwRank = kwRankMap.get(key);
      if (kwRank !== undefined) {
        rrfScore += 1 / (RRF_K + kwRank);
      }
      const vecRank = vecRankMap.get(key);
      if (vecRank !== undefined) {
        rrfScore += 1 / (RRF_K + vecRank);
      }

      const hit = deduped.get(key);
      const vecResult = vectorResults.find((vr) => `wiki:${vr.id}` === key);
      rrfScored.push({ key, rrfScore, hit, vecResult });
    }

    // 按 RRF 分数降序，同分按规范身份稳定排序
    rrfScored.sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      return a.key.localeCompare(b.key);
    });

    // 构建 baseHits
    baseHits = rrfScored.slice(0, topK).map((entry) => {
      if (entry.hit) {
        // 已有 hit（来自关键词搜索），更新 score 为 RRF 分数
        return { ...entry.hit, score: entry.rrfScore };
      }
      // 来自向量搜索但不在关键词结果中的页面
      const page = catalog.pages.find((p) => p.pageId === entry.vecResult?.id);
      if (!page || !page.parse.ok) {
 // 不应发生（已过滤），防御性跳过
        return null;
      }
      const fm = page.parse.frontmatter;
      return {
        kind: 'wiki' as const,
        id: page.pageId,
        relativePath: page.relPath.replace(/\\\\/g, '/'),
        absolutePath: join(layout.kbPath, page.relPath),
        title: fm.title,
        snippet: null,
        pageType: page.type,
        tags: fm.tags,
        keywords: fm.keywords,
        sourceRefs: fm.sources,
        stale: isStale(fm.sources, manifestSources),
        score: entry.rrfScore,
      };
    }).filter((h): h is WikiSearchHit => h !== null);

    mode = 'hybrid';
  } else {
    // 无向量或降级 → 使用关键词排名
    baseHits = keywordRanked.slice(0, topK);
    mode = 'keyword';
  }

  // ── 图一跳扩展（spec §8.3-4）──────────────────────────────────
  // 从初筛前 min(topK,10) 个 Wiki Page 沿入/出链接一跳扩展。
  // 图名额 = ceil(topK × (0.30 - 0.15 × min(vectorPageHits,topK)/topK))，
  // 限制为 1..topK-1，topK<2 时为 0；没有图候选时归还名额。
  // 无向量时 vectorPageHits=0，稀疏/无候选归还名额，不减少可用基础结果。
  // 图 revision 落后时只返回关键词并标 rebuilding，不使用过时边。
  let graphExpansion: WikiGraphExpansionInfo | null = null;
  let finalHits = baseHits;
  // 最终模式：基础模式 + 图扩展后缀
  let finalMode: WikiSearchMode = mode;

  if (topK < 2) {
    // topK < 2 → 图名额为 0，不扩展
    graphExpansion = { rebuilding: false, quota: 0, expanded: 0 };
  } else if (baseHits.length > 0) {
    const graphResult = await getWikiGraphSnapshot(kbPath);
    if (!graphResult.ok) {
      // 图构建失败 → 不扩展，不影响基础搜索
      graphExpansion = { rebuilding: true, quota: 0, expanded: 0 };
    } else if (graphResult.rebuilding) {
      // 图 revision 落后 → 标 rebuilding，不使用过时边
      graphExpansion = { rebuilding: true, quota: 0, expanded: 0 };
    } else {
      const { snapshot } = graphResult;
      // 向量命中页数影响图名额（issue 24：vectorPageHits 不再恒为 0）
      const graphQuota = computeGraphQuota(topK, vectorPageHits);

      if (graphQuota > 0) {
        // seed = 基础结果中前 min(topK,10) 个 wiki 命中
        const seedCount = Math.min(topK, 10);
        const seeds = baseHits
          .filter((h) => h.kind === 'wiki')
          .slice(0, seedCount);

        // 已在基础结果中的 pageId 集合
        const existingIds = new Set(baseHits.map((h) => `${h.kind}:${h.id}`));

        // 图候选分数：各 seed 1/(seedRank+1) 之和
        const graphCandidates = new Map<string, {
          pageId: string;
          score: number;
          seedPageId: string;
          seedRank: number;
        }>();

        for (let rank = 0; rank < seeds.length; rank++) {
          const seed = seeds[rank];
          const seedPageId = seed.id; // wiki hit 的 id = pageId
          const seedContribution = 1 / (rank + 1);
          const neighbors = getOneHopNeighbors(snapshot, seedPageId);

          for (const neighborId of neighbors) {
            const key = `wiki:${neighborId}`;
            if (existingIds.has(key)) continue; // 已在基础结果中
            const existing = graphCandidates.get(key);
            if (existing) {
              existing.score += seedContribution;
            } else {
              graphCandidates.set(key, {
                pageId: neighborId,
                score: seedContribution,
                seedPageId,
                seedRank: rank,
              });
            }
          }
        }

        // 按分数降序、同分按 pageId 稳定排序
        const sortedGraphCandidates = Array.from(graphCandidates.values()).sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.pageId.localeCompare(b.pageId);
        });

        // 取 graphQuota 个图补召回
        const expanded: WikiSearchHit[] = [];
        for (const candidate of sortedGraphCandidates) {
          if (expanded.length >= graphQuota) break;
          // 从 catalog 获取页面信息构建 hit
          const page = catalog.pages.find((p) => p.pageId === candidate.pageId);
          if (!page || !page.parse.ok) continue;

          const fm = page.parse.frontmatter;
          const graphRelatedTo: WikiGraphRelatedTo = {
            seedPageId: candidate.seedPageId,
            seedRank: candidate.seedRank,
            relation: 'one-hop',
          };

          expanded.push({
            kind: 'wiki',
            id: page.pageId,
            relativePath: page.relPath.replace(/\\/g, '/'),
            absolutePath: join(layout.kbPath, page.relPath),
            title: fm.title,
            snippet: null, // 图补召回不做正文片段
            pageType: page.type,
            tags: fm.tags,
            keywords: fm.keywords,
            sourceRefs: fm.sources,
            stale: isStale(fm.sources, manifestSources),
            score: candidate.score,
            graphRelatedTo,
          });
        }

        // 图补召回附在基础结果后
        finalHits = [...baseHits, ...expanded];
        graphExpansion = {
          rebuilding: false,
          quota: graphQuota,
          expanded: expanded.length,
        };
        // 有图补召回 → 模式加 +graph 后缀
        if (expanded.length > 0) {
          finalMode = mode === 'hybrid' ? 'hybrid+graph' : 'keyword+graph';
        }
      } else {
        // graphQuota = 0 → 不扩展
        graphExpansion = { rebuilding: false, quota: 0, expanded: 0 };
      }
    }
  } else {
    // baseHits 为空 → 无 seed 可扩展
    graphExpansion = { rebuilding: false, quota: 0, expanded: 0 };
  }

  return {
    ok: true,
    result: {
      mode: finalMode,
      kbId: manifest.manifest.kbId,
      coverage: {
        wikiPages: wantWiki ? catalog.pages.filter((p) => p.parse.ok).length : 0,
        parsedSources: parsedCount,
      },
      hits: finalHits,
      graphExpansion,
      ...(vectorStatus ? { vectorStatus } : {}),
    },
  };
}

/**
 * 计算图扩展名额（spec §8.3）。
 *
 * 名额 = ceil(topK × (0.30 - 0.15 × min(vectorPageHits,topK)/topK))
 * 限制为 1..topK-1；topK<2 时为 0。
 * 无向量时 vectorPageHits=0 → 系数 = 0.30，名额 = ceil(topK × 0.30)。
 */
function computeGraphQuota(topK: number, vectorPageHits: number): number {
  if (topK < 2) return 0;
  const ratio = Math.min(vectorPageHits, topK) / topK;
  const raw = Math.ceil(topK * (0.30 - 0.15 * ratio));
  return Math.min(topK - 1, Math.max(1, raw));
}

/** topK 限制：默认 20，范围 1–50 */
function clampTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isFinite(topK)) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(topK)));
}
type ParsedCandidate = {
  sourceId: string;
  /** 相对 raw/parsed/ 的路径（`/` 分隔，如 `sub/report.pdf.md`） */
  relPath: string;
  /** 来源显示路径（parsed 相对路径去掉末尾 `.md`） */
  title: string;
  parsedRevision: string;
  content: string;
};

/**
 * 枚举当前可用 parsed：raw/parsed/ 下的 .md 文件，按
 * `sourcePath + '.md' === parsedRel` 与 manifest 来源记录配对；
 * manifest 中不存在的（来源已删除的孤儿 parsed）不参与检索。
 *
 * 修订标注用 `parsedRevision`（磁盘上这份全文实际所属的修订）而非
 * `currentRevision`：转换失败/进行中时两者不同，spec §8 要求
 * 「不把旧来源全文伪装为当前」。从未成功转换（parsedRevision null）
 * 的来源没有可检索的机械全文，跳过。
 */
async function listCurrentParsed(
  layout: ReturnType<typeof wikiLayout>,
  manifestSources: Record<string, { sourcePath: string; currentRevision: string; parsedRevision?: string | null }>,
): Promise<ParsedCandidate[]> {
  const byParsedRel = new Map<string, { sourceId: string; parsedRevision: string }>();
  for (const [sourceId, rec] of Object.entries(manifestSources)) {
    if (!rec.parsedRevision) continue; // 从未成功转换，无可检索全文
    byParsedRel.set(`${rec.sourcePath}.md`, { sourceId, parsedRevision: rec.parsedRevision });
  }

  const files = await collectMdFiles(layout.rawParsedDir);

  const out: ParsedCandidate[] = [];
  for (const file of files) {
    const rec = byParsedRel.get(file.relPath);
    if (!rec) continue; // 孤儿 parsed：来源已不在 manifest，不检索

    let content: string;
    try {
      content = await readFile(file.absPath, 'utf-8');
    } catch {
      continue; // 读取失败跳过，不中断检索
    }

    const sourcePath = file.relPath.slice(0, -3); // 去掉末尾 `.md`
    const base = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
    out.push({
      sourceId: rec.sourceId,
      relPath: file.relPath,
      title: base,
      parsedRevision: rec.parsedRevision,
      content,
    });
  }
  return out;
}

async function collectMdFiles(
  dir: string,
  prefix = '',
): Promise<Array<{ relPath: string; absPath: string }>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // parsed 目录不存在 = 无 parsed，可检索
  }

  const out: Array<{ relPath: string; absPath: string }> = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectMdFiles(abs, rel)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push({ relPath: rel, absPath: abs });
    }
  }
  return out;
}


function fail(code: WikiSearchError['code'], message: string): WikiSearchOutcome {
  return { ok: false, error: { code, message } };
}
