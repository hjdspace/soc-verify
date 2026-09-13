/**
 * Wiki Aggregates — 确定性聚合页与操作日志生成（spec §6、§8，issue 06）。
 *
 * 「正式页及确定性 index/overview/log/manifest 属同一次提交」的前提是
 * 聚合内容**只由已发布页面决定**：同目录两次生成必须逐字节相同，
 * 否则每次发布都会被误判为「聚合页有变动」，也无法用 hash 做基线校验。
 * 因此本模块不写入时间戳、不依赖遍历顺序，只按类型与 pageId 排序。
 *
 * log.md 是追加日志，不能由当前页重建；写入用 commitId 去重，
 * 使崩溃恢复（roll-forward 重放同一 after 镜像）与重复调用都不会重复追加。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6、§8
 */

import type { WikiCatalog, WikiCatalogPage, WikiPageType } from '@shared/kb-types';

/** 固定类型顺序（与 wiki-schema 的八类一致；不随时间/目录变化） */
const TYPE_ORDER: readonly WikiPageType[] = [
  'source', 'entity', 'concept', 'comparison',
  'synthesis', 'query', 'pitfall', 'interface',
];

export const INDEX_HEADER = [
  '# 知识索引',
  '',
  '> 由已发布页面 frontmatter 确定性生成（按类型与规范 pageId 排序），请勿手工编辑。',
  '',
  '',
].join('\n');

export const OVERVIEW_HEADER = [
  '# 知识库概览',
  '',
  '> 由已发布页面 frontmatter 确定性生成，请勿手工编辑。',
  '',
  '',
].join('\n');

export const LOG_HEADER = [
  '# 操作日志',
  '',
  '> 追加记录，不能由当前页面重建。每条以 `## [ISO日期] <operation> | <subject>` 开头。',
  '',
  '',
].join('\n');

// ── index ───────────────────────────────────────────────────────

/**
 * 生成 wiki/index.md：按类型分组登记所有页面。
 *
 * 坏元数据页不静默漏项 —— 统一列在「元数据问题」段并附问题说明。
 */
export function buildWikiIndex(catalog: WikiCatalog): string {
  const good = sortPages(catalog.pages.filter((p) => p.parse.ok));
  const bad = [...catalog.pages.filter((p) => !p.parse.ok)].sort((a, b) => a.pageId.localeCompare(b.pageId));

  const lines: string[] = [INDEX_HEADER.trimEnd()];
  for (const type of TYPE_ORDER) {
    const group = good.filter((p) => p.type === type);
    if (group.length === 0) continue;
    lines.push('', `## ${type}（${group.length}）`);
    for (const p of group) {
      const fm = p.parse.ok ? p.parse.frontmatter : null;
      const title = fm?.title ?? p.pageId;
      const summary = flatten(fm?.summary ?? '');
      lines.push(`- [[${p.pageId}|${title}]]${summary.length > 0 ? ` — ${summary}` : ''}`);
    }
  }

  if (bad.length > 0) {
    lines.push('', `## 元数据问题（${bad.length}）`);
    for (const p of bad) {
      const reason = p.parse.ok ? '' : p.parse.issues.map((i) => i.message).join('；');
      lines.push(`- \`${p.relPath}\`：${reason}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ── overview ────────────────────────────────────────────────────

/** 生成 wiki/overview.md：各类型页数统计（确定性，零值类型也登记）。 */
export function buildWikiOverview(catalog: WikiCatalog): string {
  const good = catalog.pages.filter((p) => p.parse.ok);
  const badCount = catalog.pages.length - good.length;

  const lines: string[] = [OVERVIEW_HEADER.trimEnd(), '', `共 ${catalog.pages.length} 页。`, '', '| 类型 | 页数 |', '| --- | --- |'];
  for (const type of TYPE_ORDER) {
    lines.push(`| ${type} | ${good.filter((p) => p.type === type).length} |`);
  }
  lines.push(`| 元数据问题 | ${badCount} |`);
  return lines.join('\n') + '\n';
}

// ── log ─────────────────────────────────────────────────────────

export type WikiLogEntryInput = {
  /** ISO 时间（由应用统一生成，不信任模型时钟） */
  at: string;
  /** 操作类型（`publish` / `rollback` / …） */
  operation: string;
  /** 操作对象（页相对路径或说明） */
  subject: string;
  commitId: string;
};

/** 生成一条日志条目（首行格式由 spec §6 固定）。 */
export function buildWikiLogEntry(input: WikiLogEntryInput): string {
  return [
    `## [${input.at}] ${input.operation} | ${input.subject}`,
    '',
    `- commitId: \`${input.commitId}\``,
    '',
  ].join('\n');
}

/**
 * 幂等追加日志：已有内容包含同一 commitId 的条目时原样返回。
 *
 * 崩溃恢复的 roll-forward 会重放同一 after 镜像；重复调用
 * （同一次提交被重放）不得在 `wiki/log.md` 里留下两条记录。
 * 判定按**整行**匹配 `- commitId: \`<id>\``，避免某条记录的前缀
 * 与另一条记录相同（`abc` vs `abc-2`）时误判为已存在。
 */
export function appendLogEntryIdempotent(
  existing: string | null,
  entry: string,
  commitId: string,
): string {
  if (existing !== null && existingHasLogCommitId(existing, commitId)) return existing;
  const base = existing === null || existing.trim().length === 0
    ? LOG_HEADER
    : existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${base}${entry}`;
}

function existingHasLogCommitId(log: string, commitId: string): boolean {
  const needle = `- commitId: \`${commitId}\``;
  return log.split('\n').some((line) => line.trim() === needle);
}

// ── 内部工具 ────────────────────────────────────────────────────

/** 类型顺序 + pageId 稳定排序 */
function sortPages(pages: WikiCatalogPage[]): WikiCatalogPage[] {
  return [...pages].sort((a, b) => {
    const byType = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    return byType !== 0 ? byType : a.pageId.localeCompare(b.pageId);
  });
}

/** 摘要压平成单行（保留可读内容，不破坏聚合页行结构） */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
