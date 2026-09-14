/**
 * Wiki Search — 统一关键词检索服务（spec §8，issue 14）。
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
 *  4. 无嵌入也能检索（本期 mode 恒为 'keyword'；向量/图由后继票在同一
 *     契约上扩展）。
 *  5. stale 由 frontmatter sources 与 manifest 当前修订**动态核对**：
 *     页面来源引用的修订与 manifest 当前修订不一致（或来源已删除）时
 *     标记 stale，不信任缓存结果。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8
 */

import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { assertReadGateOpen, WikiReadGateError } from './read-gate';
import { readWikiManifest, wikiLayout } from './wiki-layout';
import { scanWikiCatalog } from './wiki-catalog';
import type {
  WikiSearchError,
  WikiSearchHit,
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
 * 统一关键词检索：已发布 wiki 页 + 当前 parsed 来源全文。
 *
 * @param kbPath 当前挂载库根目录（每次调用由调用方从 registry 动态解析）
 * @param options 查询与筛选
 */
export async function searchWiki(
  kbPath: string,
  options: WikiSearchOptions,
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
  const ranked = Array.from(deduped.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同分按规范身份稳定排序（不依赖文件遍历顺序）
    return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  });

  return {
    ok: true,
    result: {
      mode: 'keyword',
      kbId: manifest.manifest.kbId,
      coverage: {
        wikiPages: wantWiki ? catalog.pages.filter((p) => p.parse.ok).length : 0,
        parsedSources: parsedCount,
      },
      hits: ranked.slice(0, topK),
    },
  };
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
