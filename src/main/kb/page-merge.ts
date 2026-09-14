/**
 * KB Page Merge — 来源感知合并（issue 16，spec §4 合并策略）。
 *
 * 区分两种合并语义：
 *  1. **同来源修订**（`isOwnedOnlyBySource` = true）→ `replaceExistingBody`：
 *     允许撤回旧论断，新正文直接替换旧正文，来源引用只保留新修订。
 *     不无限 union 旧文案——纠正后的来源不应让旧错误永久残留。
 *  2. **跨来源合并**（页被多个来源拥有）→ LLM 正文合并 + 来源引用 union：
 *     保留各来源贡献，冲突保留适用范围（协议 vs DUT）。
 *
 * 锁定字段（type/title/created）：即使 LLM 改写也强制回写旧值——
 * 改 type 会破坏路由/链接；改 title 会破坏用户心智模型；created 是一次性戳。
 *
 * 异常收缩检测（spec §4：初始阈值 70%）：合并后正文显著短于旧/新较长者
 * 的 70% → 判定异常收缩，保留旧页并阻止该提案发布。阈值只作风险信号，
 * 不证明语义正确；合理的大幅删减通过独立可审阅修订重新提出。
 *
 * 来源引用确定性去重：按 (sourceId, sourceRevision, parsedHash) 三元组
 * 去重，模型不能编造来源。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §4 合并策略
 * @see D:/AI/llm_wiki/src/lib/page-merge.ts R05（参考实现，不照搬异常回退语义）
 * @see D:/AI/llm_wiki/src/lib/sources-merge.ts R05（来源引用合并）
 */

import { parseWikiPage, type WikiPageFrontmatter, type WikiSourceRef } from './wiki-page';

// ── 常量 ─────────────────────────────────────────────────────────

/**
 * 正文长度安全阈值（spec §4：初始阈值 70%）。
 * 合并后正文短于旧/新较长者的此比例 → 判定异常收缩。
 */
export const BODY_SHRINK_THRESHOLD = 0.7;

// ── 类型 ─────────────────────────────────────────────────────────

/** LLM 合并函数签名：接收旧内容、新内容（已 union 来源）、来源名 */
export type MergeFn = (
  existingContent: string,
  incomingContent: string,
  sourceFileName: string,
  signal?: AbortSignal,
) => Promise<string>;

/** mergePageContent 输入 */
export type MergePageContentInput = {
  /** 模型产出的新页内容（frontmatter + 正文） */
  incomingContent: string;
  /** 磁盘上的已有页内容；null = 新页 */
  existingContent: string | null;
  /** 本来源的 SourceRef（判断单来源修订用） */
  incomingSourceRef: WikiSourceRef;
  /** LLM 合并入口（跨来源合并时调用） */
  merger: MergeFn;
  /** 来源文件名（传给 merger） */
  sourceFileName?: string;
  /** 页面路径（诊断用） */
  pagePath?: string;
  /** 应用统一时钟（ISO 8601） */
  now: string;
  /** 外部取消信号 */
  signal?: AbortSignal;
};

/** 合并成功 */
export type MergeSuccess = {
  ok: true;
  /** 合并后的完整页面内容（frontmatter + 正文） */
  content: string;
  /** 是否触发了 LLM 合并（跨来源时为 true） */
  llmMerged: boolean;
};

/** 合并失败（保留旧页、阻止发布） */
export type MergeFailure = {
  ok: false;
  /** 失败原因码 */
  reason: 'bodyShrank' | 'llmFailed' | 'badFrontmatter';
  /** 可读消息 */
  message: string;
  /**
   * 回退内容（保留旧页或旧正文）。
   * - llmFailed/badFrontmatter → 旧页原文
   * - bodyShrank → 旧页原文
   * 调用方应保留此内容并阻止该提案发布（spec §4：异常不覆盖旧页）。
   */
  fallback: string | null;
};

export type MergeResult = MergeSuccess | MergeFailure;

// ── 公开纯函数 ───────────────────────────────────────────────────

/**
 * 判断已有页是否仅由指定来源拥有（单来源页）。
 *
 * 用于区分同来源修订（replaceExistingBody）与跨来源合并。
 * 单来源 = frontmatter sources 数组恰好 1 条且 sourceId 匹配。
 */
export function isOwnedOnlyBySource(pageContent: string, sourceId: string): boolean {
  const parsed = parseWikiPage(pageContent);
  if (!parsed.ok) return false;
  const { sources } = parsed.frontmatter;
  return sources.length === 1 && sources[0]!.sourceId === sourceId;
}

/**
 * 来源引用确定性去重合并。
 *
 * 按 (sourceId, sourceRevision, parsedHash) 三元组去重，保留首次出现顺序。
 * 模型不能编造来源——合并只来自旧页和新页已有的引用。
 */
export function unionSourceRefs(
  existing: readonly WikiSourceRef[],
  incoming: readonly WikiSourceRef[],
): WikiSourceRef[] {
  const seen = new Set<string>();
  const out: WikiSourceRef[] = [];
  for (const ref of [...existing, ...incoming]) {
    const key = `${ref.sourceId}|${ref.sourceRevision}|${ref.parsedHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// ── 主入口 ───────────────────────────────────────────────────────

/**
 * 来源感知合并：根据来源关系选择替换或合并策略。
 *
 * 调用顺序：
 *  1. existingContent === null → 新页，直接返回 incoming
 *  2. 同来源修订（单来源且 sourceId 匹配）→ replaceExistingBody
 *  3. 跨来源合并 → union 来源 → LLM 正文合并 → 锁定字段回写 → 收缩检测
 *
 * spec §4 合并策略：
 *  - 同来源新修订必须允许撤回旧论断，不能无限 union 旧文案
 *  - 跨来源页面正文由模型提案合并、来源引用去重
 *  - 缺 frontmatter、异常收缩、来源丢失或中止时保留旧页并阻止该提案发布
 */
export async function mergePageContent(
  input: MergePageContentInput,
): Promise<MergeResult> {
  const { incomingContent, existingContent, incomingSourceRef, merger, now } = input;

  // 新页：直接返回
  if (existingContent === null) {
    return { ok: true, content: incomingContent, llmMerged: false };
  }

  // 新旧一致：无变化
  if (incomingContent === existingContent) {
    return { ok: true, content: existingContent, llmMerged: false };
  }

  // 解析旧页 frontmatter
  const existingParsed = parseWikiPage(existingContent);
  if (!existingParsed.ok) {
    // 旧页坏掉：不能安全合并，退回新内容（但标记未合并）
    return { ok: true, content: incomingContent, llmMerged: false };
  }

  const incomingParsed = parseWikiPage(incomingContent);
  if (!incomingParsed.ok) {
    return {
      ok: false,
      reason: 'badFrontmatter',
      message: `新页 frontmatter 非法: ${incomingParsed.issues.map((i) => i.message).join('；')}`,
      fallback: existingContent,
    };
  }

  // 判断合并策略
  const isSameSourceRevision = isOwnedOnlyBySource(existingContent, incomingSourceRef.sourceId);

  if (isSameSourceRevision) {
    // ── 同来源修订：replaceExistingBody ──
    return replaceExistingBody(input, existingParsed.frontmatter);
  }

  // ── 跨来源合并 ──
  return crossSourceMerge(input, existingParsed.frontmatter, incomingParsed.frontmatter, merger, now);
}

// ── 同来源修订 ───────────────────────────────────────────────────

/**
 * 单来源修订：新正文直接替换旧正文，来源引用只保留新修订。
 * 锁定字段（type/title/created）保留旧值；updated 设为 now。
 */
function replaceExistingBody(
  input: MergePageContentInput,
  existingFm: WikiPageFrontmatter,
): MergeResult {
  const { incomingContent, now } = input;
  const incomingParsed = parseWikiPage(incomingContent);
  if (!incomingParsed.ok) {
    return {
      ok: false,
      reason: 'badFrontmatter',
      message: `新页 frontmatter 非法: ${incomingParsed.issues.map((i) => i.message).join('；')}`,
      fallback: input.existingContent,
    };
  }

  // 用旧页的锁定字段 + 新页的正文
  const lockedFm: Partial<WikiPageFrontmatter> = {
    type: existingFm.type,
    title: existingFm.title,
    created: existingFm.created,
  };

  // 新页的来源引用保持不变（已是新修订）
  const content = rebuildPage(incomingParsed.frontmatter, incomingParsed.body, lockedFm, now);
  return { ok: true, content, llmMerged: false };
}

// ── 跨来源合并 ───────────────────────────────────────────────────

/**
 * 跨来源合并：union 来源引用 → LLM 正文合并 → 锁定字段回写 → 收缩检测。
 *
 * 失败语义（spec §4：异常不覆盖旧页）：
 *  - LLM 调用失败 → 保留旧页，reason='llmFailed'
 *  - LLM 输出无 frontmatter → 保留旧页，reason='badFrontmatter'
 *  - 合并正文异常收缩 → 保留旧页，reason='bodyShrank'
 */
async function crossSourceMerge(
  input: MergePageContentInput,
  existingFm: WikiPageFrontmatter,
  incomingFm: WikiPageFrontmatter,
  merger: MergeFn,
  now: string,
): Promise<MergeResult> {
  const { incomingContent, existingContent, incomingSourceRef } = input;
  // existingContent 非空：调用方已检查（mergePageContent 在 existingContent === null 时提前返回）
  const existing: string = existingContent ?? '';

  // 来源引用 union
  const mergedSources = unionSourceRefs(existingFm.sources, incomingFm.sources);
  const mergedKeywords = dedupeStrings([...existingFm.keywords, ...incomingFm.keywords]);
  const mergedTags = dedupeStrings([...existingFm.tags, ...incomingFm.tags]);

  // union 后的新内容（用于 LLM 输入）
  const arrayMergedIncoming = replaceFrontmatterArrays(incomingContent, mergedSources, mergedKeywords, mergedTags);

  // 正文相同（只有 frontmatter 数组差异）→ 无需 LLM
  const existingBody = extractBody(existing);
  const incomingBody = extractBody(arrayMergedIncoming);
  if (existingBody.trim() === incomingBody.trim()) {
    const content = rebuildPage(
      { ...incomingFm, sources: mergedSources, keywords: mergedKeywords, tags: mergedTags },
      incomingBody,
      { type: existingFm.type, title: existingFm.title, created: existingFm.created },
      now,
    );
    return { ok: true, content, llmMerged: false };
  }

  // LLM 正文合并
  let llmOutput: string;
  try {
    llmOutput = await merger(
      existing,
      arrayMergedIncoming,
      input.sourceFileName ?? incomingSourceRef.sourceId,
      input.signal,
    );
  } catch {
    return {
      ok: false,
      reason: 'llmFailed',
      message: `LLM 正文合并失败（保留旧页，阻止该提案发布）`,
      fallback: existing,
    };
  }

  // LLM 输出校验
  const llmParsed = parseWikiPage(llmOutput);
  if (!llmParsed.ok) {
    return {
      ok: false,
      reason: 'badFrontmatter',
      message: `LLM 合并输出 frontmatter 非法: ${llmParsed.issues.map((i) => i.message).join('；')}`,
      fallback: existing,
    };
  }

  // 异常收缩检测
  const oldBodyLen = existingBody.length;
  const newBodyLen = incomingBody.length;
  const llmBodyLen = llmParsed.body.length;
  const minThreshold = Math.max(oldBodyLen, newBodyLen) * BODY_SHRINK_THRESHOLD;
  if (llmBodyLen < minThreshold) {
    return {
      ok: false,
      reason: 'bodyShrank',
      message: `LLM 合并正文 ${llmBodyLen} 字符，低于阈值 ${minThreshold.toFixed(0)}（旧 ${oldBodyLen} / 新 ${newBodyLen} 的 ${BODY_SHRINK_THRESHOLD * 100}%）—— 异常收缩，保留旧页`,
      fallback: existing,
    };
  }

  // 锁定字段回写 + 来源引用确定性去重
  const lockedFm: Partial<WikiPageFrontmatter> = {
    type: existingFm.type,
    title: existingFm.title,
    created: existingFm.created,
  };
  const finalSources = unionSourceRefs(llmParsed.frontmatter.sources, mergedSources);
  const finalKeywords = dedupeStrings([...llmParsed.frontmatter.keywords, ...existingFm.keywords, ...incomingFm.keywords]);
  const finalTags = dedupeStrings([...llmParsed.frontmatter.tags, ...existingFm.tags, ...incomingFm.tags]);

  const content = rebuildPage(
    {
      ...llmParsed.frontmatter,
      sources: finalSources,
      keywords: finalKeywords,
      tags: finalTags,
    },
    llmParsed.body,
    lockedFm,
    now,
  );

  return { ok: true, content, llmMerged: true };
}

// ── 工具函数 ─────────────────────────────────────────────────────

/** 提取正文（frontmatter 之后的部分） */
function extractBody(content: string): string {
  const parsed = parseWikiPage(content);
  if (!parsed.ok) return content;
  return parsed.body;
}

/**
 * 用锁定字段重建页面：保留 LLM/新版的正文与大部分 frontmatter，
 * 但 type/title/created 强制使用旧值，updated 设为 now。
 */
function rebuildPage(
  fm: WikiPageFrontmatter,
  body: string,
  locked: Partial<Pick<WikiPageFrontmatter, 'type' | 'title' | 'created'>>,
  now: string,
): string {
  const finalFm: WikiPageFrontmatter = {
    type: locked.type ?? fm.type,
    title: locked.title ?? fm.title,
    summary: fm.summary,
    keywords: fm.keywords,
    tags: fm.tags,
    sources: fm.sources,
    created: locked.created ?? fm.created,
    updated: now,
  };
  return serializePage(finalFm, body);
}

/** 序列化 frontmatter + 正文（与 wiki-page.ts 模板格式一致） */
function serializePage(fm: WikiPageFrontmatter, body: string): string {
  const sourcesYaml = fm.sources.length === 0
    ? 'sources: []'
    : [
      'sources:',
      ...fm.sources.map((s) => [
        `  - sourceId: "${s.sourceId}"`,
        `    sourceRevision: "${s.sourceRevision}"`,
        `    parsedHash: "${s.parsedHash}"`,
      ].join('\n')),
    ].join('\n');
  return [
    '---',
    `type: ${fm.type}`,
    `title: "${fm.title}"`,
    `summary: ${fm.summary}`,
    `keywords: [${fm.keywords.map((k) => `"${k}"`).join(', ')}]`,
    `tags: [${fm.tags.map((t) => `"${t}"`).join(', ')}]`,
    sourcesYaml,
    `created: "${fm.created}"`,
    `updated: "${fm.updated}"`,
    '---',
    '',
    body,
  ].join('\n');
}

/** 替换 frontmatter 中的 sources/keywords/tags 数组 */
function replaceFrontmatterArrays(
  content: string,
  sources: WikiSourceRef[],
  keywords: string[],
  tags: string[],
): string {
  const parsed = parseWikiPage(content);
  if (!parsed.ok) return content;
  const fm: WikiPageFrontmatter = {
    ...parsed.frontmatter,
    sources,
    keywords,
    tags,
  };
  return serializePage(fm, parsed.body);
}

/** 字符串数组去重（大小写不敏感，保留首次出现的大小写） */
function dedupeStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
