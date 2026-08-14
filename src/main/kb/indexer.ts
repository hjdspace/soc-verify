/**
 * Knowledge Base Indexer — LLM 分类索引 + index.md 增量合并。
 *
 * 核心职责：
 *  1. 骨架截取：从 Markdown 提取标题层级 + 前若干行（非全文）
 *  2. Prompt 组装：将骨架 + 现有分类体系组合为 LLM prompt
 *  3. LLM 调用：单次调用产出分类 + 标题 + 摘要 + 关键词
 *  4. 降级：LLM 失败时降级为占位条目，不阻塞上传
 *  5. index.md 增量合并：插入/更新/移除条目，保持人可读 Markdown
 *
 * LLM 调用复用应用已配置的 openai-compatible 直连端点。
 *
 * index.md 格式约定：
 *   # 知识库索引
 *
 *   <!-- 此文件由 AI Agent 会话启动时注入为库地图 -->
 *   <!-- 手动编辑可调整分类体系与条目 -->
 *
 *   ## <分类名>
 *
 *   ### <标题>
 *   - **路径**: `<相对路径>`
 *   - **摘要**: <一句话摘要>
 *   - **关键词**: `keyword1` · `keyword2`
 *
 *   ### ...
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { IndexEntry, ClassificationResult } from './types';

// ── 常量 ────────────────────────────────────────────────────────

/** 骨架截取的最大行数 */
const SKELETON_MAX_LINES = 60;

/** LLM 调用超时（毫秒） */
const LLM_TIMEOUT_MS = 30_000;

/** index.md 中条目块的分隔标记 */
const PATH_PREFIX = '- **路径**: `';
const SUMMARY_PREFIX = '- **摘要**: ';
const KEYWORDS_PREFIX = '- **关键词**: ';

// ── 骨架截取 ────────────────────────────────────────────────────

/**
 * 从 Markdown 内容提取骨架：标题层级 + 前若干行。
 * 非全文传递，控制 LLM token 消耗。
 */
export function extractSkeleton(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // 保留标题行
    if (/^#{1,6}\s/.test(line)) {
      result.push(line);
    }
    // 保留非空非标题行（正文前几行）
    else if (line.trim() && result.length < SKELETON_MAX_LINES) {
      result.push(line);
    }
    if (result.length >= SKELETON_MAX_LINES) break;
  }

  return result.join('\n');
}

// ── Prompt 组装 ──────────────────────────────────────────────────

/**
 * 组装 LLM 分类 prompt。
 *
 * 输入：文档骨架 + 现有分类体系（空时为冷启动）。
 * 输出：要求 LLM 返回 JSON 格式的分类结果。
 */
export function buildClassificationPrompt(skeleton: string, existingCategories: string[]): string {
  const categoryList = existingCategories.length > 0
    ? existingCategories.map((c) => `- ${c}`).join('\n')
    : '（冷启动：尚无分类体系，请建议合适的顶层分类）';

  return `你是一个文档分类助手。请分析以下文档骨架，产出一个 JSON 对象。

要求：
1. 从现有分类体系中选择最合适的分类，或建议新分类
2. 给出文档标题（简洁，不超过 20 字）
3. 给出一句话摘要（不超过 50 字）
4. 给出 3-5 个关键词

现有分类体系：
${categoryList}

文档骨架：
---
${skeleton}
---

请返回 JSON 格式（不要 markdown 代码块标记）：
{"category": "分类名", "title": "标题", "summary": "摘要", "keywords": ["关键词1", "关键词2"]}`;
}

// ── LLM 调用 ────────────────────────────────────────────────────

/** LLM 调用配置 */
export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
};

/** LLM 调用结果（成功） */
type LlmSuccess = { ok: true; result: ClassificationResult };
type LlmFailure = { ok: false; error: string };
type LlmResponse = LlmSuccess | LlmFailure;

/**
 * 解析 LLM 返回的 JSON 文本为 ClassificationResult。
 * 容错：去除 markdown 代码块标记、补全缺失字段。
 */
export function parseClassificationResponse(raw: string): ClassificationResult {
  // 去除 markdown 代码块标记
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  return {
    category: typeof parsed.category === 'string' && parsed.category.trim()
      ? parsed.category.trim()
      : '未分类',
    title: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : '未命名文档',
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : '',
    keywords: Array.isArray(parsed.keywords)
      ? (parsed.keywords as unknown[]).filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())
      : [],
  };
}

/**
 * 调用 LLM 获取分类结果。
 *
 * 使用 openai-compatible API（chat/completions），
 * 单次调用产出分类 + 标题 + 摘要 + 关键词。
 *
 * 失败时返回 { ok: false }，由调用方决定降级策略。
 */
export async function classifyWithLlm(
  skeleton: string,
  existingCategories: string[],
  config: LlmConfig,
): Promise<LlmResponse> {
  const prompt = buildClassificationPrompt(skeleton, existingCategories);
  const fetchFn = config.fetchFn ?? fetch;

  const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: '你是一个文档分类助手。只返回 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      return { ok: false, error: `LLM API 返回 ${response.status}: ${details.slice(0, 200)}` };
    }

    const payload = await response.json() as Record<string, unknown>;
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content !== 'string') {
      return { ok: false, error: 'LLM 返回格式异常：缺少 message.content' };
    }

    const result = parseClassificationResponse(content);
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── 降级占位条目 ────────────────────────────────────────────────

/**
 * 生成降级占位条目（LLM 失败时使用）。
 * 标题用文档名，摘要留空，分类为"未分类"。
 */
export function makePlaceholderEntry(docName: string, markdownRelPath: string): IndexEntry {
  return {
    title: docName,
    path: markdownRelPath,
    category: '未分类',
    summary: '',
    keywords: [],
  };
}

// ── index.md 增量合并 ────────────────────────────────────────────

/**
 * 解析 index.md 内容为条目列表 + 分类顺序。
 *
 * index.md 格式：
 *   # 知识库索引
 *   <!-- 注释 -->
 *
 *   ## 分类A
 *
 *   ### 标题1
 *   - **路径**: `path1`
 *   - **摘要**: summary1
 *   - **关键词**: `kw1` · `kw2`
 *
 *   ### 标题2
 *   ...
 *
 *   ## 分类B
 *   ...
 */
export function parseIndexMd(content: string): { entries: IndexEntry[]; categoryOrder: string[] } {
  const entries: IndexEntry[] = [];
  const categoryOrder: string[] = [];
  let currentCategory = '';
  let currentTitle = '';
  let currentPath = '';
  let currentSummary = '';
  let currentKeywords: string[] = [];

  function flushEntry(): void {
    if (currentTitle && currentPath) {
      entries.push({
        title: currentTitle,
        path: currentPath,
        category: currentCategory || '未分类',
        summary: currentSummary,
        keywords: currentKeywords,
      });
    }
    currentTitle = '';
    currentPath = '';
    currentSummary = '';
    currentKeywords = [];
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // 分类标题行
    const catMatch = trimmed.match(/^##\s+(.+)$/);
    if (catMatch) {
      flushEntry();
      currentCategory = catMatch[1].trim();
      if (!categoryOrder.includes(currentCategory)) {
        categoryOrder.push(currentCategory);
      }
      continue;
    }

    // 条目标题行
    const titleMatch = trimmed.match(/^###\s+(.+)$/);
    if (titleMatch) {
      flushEntry();
      currentTitle = titleMatch[1].trim();
      continue;
    }

    // 路径行
    if (trimmed.startsWith(PATH_PREFIX)) {
      currentPath = trimmed.slice(PATH_PREFIX.length, -1); // 去掉末尾的 `
      continue;
    }

    // 摘要行
    if (trimmed.startsWith(SUMMARY_PREFIX)) {
      currentSummary = trimmed.slice(SUMMARY_PREFIX.length);
      continue;
    }

    // 关键词行
    if (trimmed.startsWith(KEYWORDS_PREFIX)) {
      const kwStr = trimmed.slice(KEYWORDS_PREFIX.length);
      currentKeywords = kwStr.split('·').map((k) => k.trim().replace(/`/g, '')).filter(Boolean);
      continue;
    }
  }
  flushEntry();

  return { entries, categoryOrder };
}

/**
 * 将单个条目格式化为 index.md 文本块。
 */
function formatEntryBlock(entry: IndexEntry): string {
  const keywords = entry.keywords.length > 0
    ? entry.keywords.map((k) => `\`${k}\``).join(' · ')
    : '';
  const lines = [
    `### ${entry.title}`,
    `${PATH_PREFIX}\`${entry.path}\``,
    `${SUMMARY_PREFIX}${entry.summary || '（暂无摘要）'}`,
  ];
  if (keywords) {
    lines.push(`${KEYWORDS_PREFIX}${keywords}`);
  }
  return lines.join('\n');
}

/**
 * 将条目列表 + 分类顺序序列化为 index.md 文本。
 */
function serializeIndexMd(entries: IndexEntry[], categoryOrder: string[]): string {
  // 收集实际有条目的分类
  const byCategory = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  // 确保 categoryOrder 包含所有有条目的分类
  const allCategories = [...categoryOrder];
  for (const cat of byCategory.keys()) {
    if (!allCategories.includes(cat)) {
      allCategories.push(cat);
    }
  }

  const parts: string[] = [
    '# 知识库索引',
    '',
    '<!-- 此文件由 AI Agent 会话启动时注入为库地图 -->',
    '<!-- 手动编辑可调整分类体系与条目 -->',
    '',
  ];

  for (const cat of allCategories) {
    const list = byCategory.get(cat);
    if (!list || list.length === 0) continue;

    parts.push(`## ${cat}`, '');
    for (const entry of list) {
      parts.push(formatEntryBlock(entry), '');
    }
  }

  return parts.join('\n');
}

/**
 * 增量合并：插入或更新一个条目。
 *
 * 如果同路径条目已存在，替换其内容；否则插入到对应分类节。
 * 保持人可读 Markdown 格式。
 */
export function mergeEntry(indexContent: string, entry: IndexEntry): string {
  const { entries, categoryOrder } = parseIndexMd(indexContent);

  // 查找同路径条目
  const existingIdx = entries.findIndex((e) => e.path === entry.path);
  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }

  // 确保分类在顺序中
  if (!categoryOrder.includes(entry.category)) {
    categoryOrder.push(entry.category);
  }

  return serializeIndexMd(entries, categoryOrder);
}

/**
 * 增量合并：移除一个条目（按路径匹配）。
 */
export function removeEntry(indexContent: string, markdownRelPath: string): string {
  const { entries, categoryOrder } = parseIndexMd(indexContent);
  const filtered = entries.filter((e) => e.path !== markdownRelPath);
  return serializeIndexMd(filtered, categoryOrder);
}

// ── 完整索引流程 ─────────────────────────────────────────────────

/**
 * 完整的分类索引流程：
 *  1. 读取 Markdown 骨架
 * 2. 调用 LLM 分类
 * 3. LLM 失败时降级为占位条目
 * 4. 合并到 index.md
 *
 * @param markdownPath Markdown 文件绝对路径
 * @param docsDir docs/ 目录绝对路径
 * @param indexMdPath index.md 绝对路径
 * @param existingCategories 现有分类列表
 * @param llmConfig LLM 配置（为 null 时直接降级占位）
 * @param categoryOverride 覆盖分类（非空时跳过 LLM，直接用此分类）
 * @returns 分类结果 + 是否降级
 */
export async function indexDocument(
  markdownPath: string,
  docsDir: string,
  indexMdPath: string,
  existingCategories: string[],
  llmConfig: LlmConfig | null,
): Promise<{ entry: IndexEntry; degraded: boolean }> {
  // 读取 Markdown
  const markdown = await readFile(markdownPath, 'utf-8');
  const skeleton = extractSkeleton(markdown);

  // 计算相对路径
  const markdownRelPath = markdownPath.replace(docsDir + '/', '').replace(docsDir + '\\', '').replace(/\\/g, '/');

  // 调用 LLM 分类
  let classification: ClassificationResult;
  let degraded = false;

  if (llmConfig) {
    const llmResult = await classifyWithLlm(skeleton, existingCategories, llmConfig);
    if (llmResult.ok) {
      classification = llmResult.result;
    } else {
      // 降级为占位条目
      degraded = true;
      classification = {
        category: '未分类',
        title: basename(markdownPath, '.md'),
        summary: '',
        keywords: [],
      };
    }
  } else {
    // 无 LLM 配置，直接降级
    degraded = true;
    classification = {
      category: '未分类',
      title: basename(markdownPath, '.md'),
      summary: '',
      keywords: [],
    };
  }

  const entry: IndexEntry = {
    title: classification.title,
    path: markdownRelPath,
    category: classification.category,
    summary: classification.summary,
    keywords: classification.keywords,
  };

  // 读取现有 index.md
  let indexContent = '';
  if (existsSync(indexMdPath)) {
    indexContent = await readFile(indexMdPath, 'utf-8');
  }

  // 增量合并
  const merged = mergeEntry(indexContent, entry);
  await mkdir(dirname(indexMdPath), { recursive: true });
  await writeFile(indexMdPath, merged, 'utf-8');

  return { entry, degraded };
}

/**
 * 从 index.md 移除文档条目。
 */
export async function removeFromIndex(
  indexMdPath: string,
  markdownRelPath: string,
): Promise<void> {
  let content = '';
  if (existsSync(indexMdPath)) {
    content = await readFile(indexMdPath, 'utf-8');
  }
  const updated = removeEntry(content, markdownRelPath);
  await writeFile(indexMdPath, updated, 'utf-8');
}

/**
 * 列出当前 index.md 中的所有分类。
 */
export function listCategoriesFromIndex(indexContent: string): string[] {
  const { categoryOrder } = parseIndexMd(indexContent);
  return categoryOrder;
}
