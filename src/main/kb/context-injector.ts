/**
 * KB Context Injector — 会话创建时注入知识库索引上下文。
 *
 * 两种布局分支（issue 14）：
 *
 *  - wiki 布局（ADR 0034）：从已发布页面 frontmatter 生成注入内容，
 *    不读 index.md 聚合页做排名来源。预算硬上限 8000 字符（含工具
 *    说明与路径）：先输出类型骨架（各类型计数），再按类型轮询加入
 *    完整条目（整条目组装完成才检查预算，不在半个链接处截断）。
 *    仅 raw（无已发布页）时说明「有未编译来源」并给出 kb_search 检索
 *    入口；空库/无挂载不注入。
 *  - legacy 布局：沿用旧 index.md 压缩注入（issue 28 退役）。
 *
 * 注入前把条目路径改写为绝对路径：Agent 的 read 工具以会话 cwd
 * （项目根目录）解析相对路径，库目录与 cwd 往往不同。
 *
 * @see ADR 0034 — 知识库重构为 LLM Wiki 双层架构
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { kbRegistry } from '../kb/registry';
import { kbLayout } from '../kb/layout';
import { wikiLayout } from '../kb/wiki-layout';
import { scanWikiCatalog } from '../kb/wiki-catalog';
import { parseIndexMd, PATH_PREFIX } from '../kb/indexer';
import type { IndexEntry } from '../kb/types';
import type { WikiCatalogPage, WikiPageType } from '@shared/kb-types';

// ── 常量 ────────────────────────────────────────────────────────

/** 索引注入的最大字符数（硬上限，含工具说明与路径） */
const MAX_INJECT_CHARS = 8000;

/** 旧布局截断提示语 */
const TRUNCATION_NOTICE =
  '\n\n<!-- 索引已截断：以上为压缩视图（保留全部分类）。完整检索请使用 kb_search 工具 -->\n';

/** 注入给 Agent 的检索工具说明（计入预算） */
const KB_SEARCH_TOOL_HINT =
  '检索工具：kb_search(query, pageType?, tag?, kind?, topK?) — 关键词检索已发布知识页与来源全文；' +
  'kb_read 式分页读取见 kb_doc_read。完整条目未列出时请用 kb_search 检索。';

/** wiki 布局注入的预算截断提示（恒预留长度，保证总注入不越硬上限） */
const WIKI_TRUNCATION_NOTICE =
  '\n<!-- 注入预算已达上限（8000 字符），其余条目未列出——请用 kb_search 检索 -->\n';

// ── 类型 ────────────────────────────────────────────────────────

/** KB 上下文注入结果 */
export type KbContextResult = {
  /** 注入到 Agent 系统上下文的文本（未挂载库时为空字符串） */
  contextText: string;
  /** 库名称 */
  kbName: string | null;
  /** 库路径 */
  kbPath: string | null;
  /** 是否被截断 */
  truncated: boolean;
};

// ── 辅助函数 ────────────────────────────────────────────────────

/**
 * 把 index.md 中相对 docs/ 的条目路径改写为绝对路径。
 *
 * index.md 路径行格式：`- **路径**: `docs/ 相对路径``。
 * 已是绝对路径的（手工编辑过）保持原样。
 */
function absolutizeIndexPaths(content: string, docsDir: string): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith(PATH_PREFIX)) return line;

      const relPath = trimmed
        .slice(PATH_PREFIX.length)
        .replace(/^`+/, '')
        .replace(/`+$/, '');
      if (!relPath || isAbsolute(relPath)) return line;

      const absPath = join(docsDir, relPath);
      return `${PATH_PREFIX}\`${absPath}\``;
    })
    .join('\n');
}

/**
 * 索引超长时的结构化降级。
 *
 * 硬截断会把 index.md 后半部分的分类整体丢掉——Agent 不知道它们存在，
 * 自然也不会去 kb_search。这里改为逐级压缩，保证所有分类始终可见：
 *   阶段 1：全条目压缩（标题 + 路径，去摘要/关键词）
 *   阶段 2：每分类单行（全部文档标题）
 *   阶段 3：仅分类名 + 文档数
 *
 * 各阶段条目路径均改写为绝对路径（相对 docs/ 的路径 Agent 读不到）。
 */
function compactIndex(content: string, maxChars: number, docsDir: string): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: absolutizeIndexPaths(content, docsDir), truncated: false };
  }

  const { entries, categoryOrder } = parseIndexMd(content);
  if (entries.length === 0) {
    // 解析失败（可能是手工编辑的非标准格式）→ 退回行边界硬截断
    let cutPoint = maxChars;
    const lastNewline = content.lastIndexOf('\n', maxChars);
    if (lastNewline > maxChars * 0.8) {
      cutPoint = lastNewline;
    }
    return { text: absolutizeIndexPaths(content.slice(0, cutPoint), docsDir) + TRUNCATION_NOTICE, truncated: true };
  }

  const byCategory = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  const categories = categoryOrder.filter((c) => byCategory.has(c));
  for (const c of byCategory.keys()) {
    if (!categories.includes(c)) categories.push(c);
  }

  // 相对 docs/ → 绝对路径（Agent read 工具按 cwd 解析相对路径，读不到库内文档）
  const absOf = (p: string): string => (isAbsolute(p) ? p : join(docsDir, p));

  // 阶段 1：全条目压缩
  const stage1 = categories
    .map((c) => {
      const list = byCategory.get(c) ?? [];
      return [`## ${c}（${list.length} 篇）`, ...list.map((e) => `- ${e.title}（${absOf(e.path)}）`)].join('\n');
    })
    .join('\n\n');
  if (stage1.length <= maxChars) {
    return { text: stage1 + TRUNCATION_NOTICE, truncated: true };
  }

  // 阶段 2：每分类单行（全部标题）
  const stage2 = categories
    .map((c) => {
      const list = byCategory.get(c) ?? [];
      return `## ${c}（${list.length} 篇）: ${list.map((e) => e.title).join('；')}`;
    })
    .join('\n');
  if (stage2.length <= maxChars) {
    return { text: stage2 + TRUNCATION_NOTICE, truncated: true };
  }

  // 阶段 3：仅分类名
  const stage3 = categories
    .map((c) => `## ${c}（${(byCategory.get(c) ?? []).length} 篇）`)
    .join('\n');
  return { text: stage3 + TRUNCATION_NOTICE, truncated: true };
}

// ── 主函数 ────────────────────────────────────────────────────────

/**
 * 构建知识库索引上下文文本，用于注入 Agent 系统上下文。
 *
 * 读取挂载库的 index.md，格式化为 `<kb-index>` block。
 * 未挂载库时返回空上下文。索引超长时截断并附加提示。
 *
 * @param projectRoot 项目根目录
 * @returns KB 上下文注入结果
 */
export async function buildKbContext(projectRoot: string): Promise<KbContextResult> {
  const status = await kbRegistry.status(projectRoot);

  if (!status.mounted) {
    return { contextText: '', kbName: null, kbPath: null, truncated: false };
  }

  const kbPath = status.mounted.path;
  const kbName = status.mounted.name;

  // wiki 布局：从已发布页面 frontmatter 生成注入（spec §8，issue 14）
  if (status.mounted.format === 'wiki') {
    return buildWikiKbContext(kbPath, kbName);
  }

  // legacy 布局：沿用旧 index.md 压缩注入（issue 28 退役）
  const layout = kbLayout(kbPath);

  if (!existsSync(layout.indexMdPath)) {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  let indexContent: string;
  try {
    indexContent = await readFile(layout.indexMdPath, 'utf-8');
  } catch {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  // 空索引不注入
  const trimmed = indexContent.trim();
  if (!trimmed) {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  const { text, truncated } = compactIndex(indexContent, MAX_INJECT_CHARS, layout.docsDir);

  // 头部说明：库根目录与路径语义（条目路径均为绝对路径，可直接用 read 工具读取）
  const header =
    `知识库「${kbName}」已挂载，根目录：${kbPath}\n` +
    '以下为文档索引，每条目「路径」为文档 Markdown 绝对路径，可直接读取：';

  const contextText = `<kb-index kb-name="${kbName}" kb-path="${kbPath}">\n${header}\n\n${text}\n</kb-index>`;

  return { contextText, kbName, kbPath, truncated };
}

/**
 * 将 KB 索引上下文追加到系统提示词。
 *
 * 如果已有 systemPrompt，在末尾追加 KB 上下文；
 * 如果没有 systemPrompt，以 KB 上下文作为 systemPrompt。
 *
 * @param systemPrompt 原始系统提示词
 * @param projectRoot 项目根目录
 * @returns 追加了 KB 上下文的系统提示词
 */
export async function injectKbContext(
  systemPrompt: string | undefined,
  projectRoot: string,
): Promise<string | undefined> {
  const kbContext = await buildKbContext(projectRoot);

  if (!kbContext.contextText) {
    return systemPrompt;
  }

  const prefix = systemPrompt ? systemPrompt + '\n\n' : '';
  return prefix + kbContext.contextText;
}

// ── wiki 布局注入（spec §8，issue 14）───────────────────────────

/** 固定类型顺序（与 wiki-aggregates 的 TYPE_ORDER 一致） */
const WIKI_TYPE_ORDER: readonly WikiPageType[] = [
  'source', 'entity', 'concept', 'comparison',
  'synthesis', 'query', 'pitfall', 'interface',
];

const WIKI_TYPE_LABEL: Record<WikiPageType, string> = {
  source: '来源', entity: '实体', concept: '概念', comparison: '对照',
  synthesis: '综合', query: '问答', pitfall: '踩坑', interface: '接口',
};

/**
 * wiki 布局注入：从已发布页面 frontmatter 生成。
 *
 * 预算 = 8000 字符硬上限（含头说明 + 工具说明 + 路径）：
 *  1. 无已发布页且无 raw → 空库不注入；
 *  2. 无已发布页但有 raw → 只注入「有未编译来源 + kb_search 检索入口」说明；
 *  3. 有已发布页 → 类型骨架（计数）+ 按类型轮询加入完整条目
 *     （标题 + pageId + 绝对路径 + 摘要），整条目组装完才检查预算，
 *     不在半个链接处截断；未放入的条目由 kb_search 兜底。
 */
async function buildWikiKbContext(kbPath: string, kbName: string): Promise<KbContextResult> {
  const layout = wikiLayout(kbPath);

  const scan = await scanWikiCatalog(kbPath);
  const goodPages: WikiCatalogPage[] = scan.ok
    ? scan.catalog.pages.filter((p) => p.parse.ok)
    : [];

  const hasSources = (await countFiles(layout.rawSourcesDir)) > 0;

  // 空库（无已发布页也无来源）不注入
  if (goodPages.length === 0 && !hasSources) {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  // 仅 raw：说明未编译来源 + 检索入口
  if (goodPages.length === 0) {
    const contextText =
      `<kb-index kb-name="${kbName}" kb-path="${kbPath}">\n` +
      `知识库「${kbName}」已挂载。该库尚未编译出任何已发布知识页，但有未编译来源（raw/sources/）。` +
      `\n${KB_SEARCH_TOOL_HINT}\n` +
      '来源全文可用 doc_to_markdown 转换读取。\n' +
      `</kb-index>`;
    return { contextText, kbName, kbPath, truncated: false };
  }

  // 按类型分组（保持固定类型顺序）
  const groups = WIKI_TYPE_ORDER
    .map((type) => ({ type, pages: goodPages.filter((p) => p.type === type) }))
    .filter((g) => g.pages.length > 0);

  // 骨架（必须完整，条目在其后逐个加入）
  const skeletonLines: string[] = [
    `知识库「${kbName}」已挂载，根目录：${kbPath}`,
    `已发布知识页共 ${goodPages.length} 页：`,
    ...groups.map((g) => `- ${g.type}（${WIKI_TYPE_LABEL[g.type]}）：${g.pages.length} 页`),
    KB_SEARCH_TOOL_HINT,
    '',
  ];
  const skeleton = skeletonLines.join('\n');

  // 预算硬上限含 wrapper（<kb-index 头/尾）与截断提示（提示只在截断时
  // 出现，恒预留其长度，保证任何情况下总注入 ≤ MAX_INJECT_CHARS）
  const prefix = `<kb-index kb-name="${kbName}" kb-path="${kbPath}">\n`;
  const suffix = '</kb-index>';
  const bodyBudget = MAX_INJECT_CHARS - prefix.length - suffix.length - WIKI_TRUNCATION_NOTICE.length;

  // 按类型轮询加入完整条目（round-robin 保证各类型公平可见）
  const cursors = groups.map(() => 0);
  const bodyLines: string[] = [];
  let used = skeleton.length;
  let added = 0;
  let budgetExhausted = false;

  for (;;) {
    let advanced = false;
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const cursor = cursors[gi];
      if (cursor >= group.pages.length) continue;
      cursors[gi] = cursor + 1;
      advanced = true;

      const line = formatWikiEntryLine(group.pages[cursor], kbPath);
      if (line.length === 0 || used + line.length + 1 > bodyBudget) {
        // 预算不足 → 整条目不放入（不截半）；后续条目只会更长，直接终止
        budgetExhausted = true;
        break;
      }
      bodyLines.push(line);
      used += line.length + 1;
      added++;
    }
    if (!advanced || budgetExhausted) break;
  }

  const truncated = budgetExhausted && added < goodPages.length;
  const notice = truncated ? WIKI_TRUNCATION_NOTICE : '';

  const contextText =
    prefix +
    skeleton +
    (bodyLines.length > 0 ? bodyLines.join('\n') + '\n' : '') +
    notice +
    suffix;

  return { contextText, kbName, kbPath, truncated };
}

/** 单条注入条目：标题 [tags]（pageId）: 绝对路径 — 摘要（整行组装，不截半） */
function formatWikiEntryLine(page: WikiCatalogPage, kbPath: string): string {
  if (!page.parse.ok) return '';
  const fm = page.parse.frontmatter;
  const absPath = join(kbPath, page.relPath);
  const summary = fm.summary.replace(/\s+/g, ' ').trim();
  const tagPart = fm.tags.length > 0 ? ` [${fm.tags.join('/')}]` : '';
  return `- ${fm.title}${tagPart}（${page.pageId}）: ${absPath}${summary.length > 0 ? ` — ${summary}` : ''}`;
}

/** 递归统计目录下文件数（判断 raw/sources 是否有内容） */
async function countFiles(dir: string): Promise<number> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' }) as unknown as import('node:fs').Dirent[];
  } catch {
    return 0; // raw 目录不存在
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) count++;
    else if (entry.isDirectory()) count += await countFiles(join(dir, entry.name));
  }
  return count;
}
