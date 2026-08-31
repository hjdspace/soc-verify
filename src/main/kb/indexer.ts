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
import { type LlmConfig, protocolForProvider } from './llm-config';
import { buildDirectChatRequest, extractOpenAiFamilyContent } from '../agent/openai-compatible';

// Re-export for backward compatibility — consumers that imported
// LlmConfig / protocolForProvider from indexer still work.
export { type LlmConfig, protocolForProvider };

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
 *
 * @param markdown Markdown 全文
 * @param maxLines 骨架最大行数（默认 SKELETON_MAX_LINES；deep-reindexer 等复用方可自定义）
 */
export function extractSkeleton(markdown: string, maxLines: number = SKELETON_MAX_LINES): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    // 保留标题行
    if (/^#{1,6}\s/.test(line)) {
      result.push(line);
    }
    // 保留非空非标题行（正文前几行）
    else if (line.trim() && result.length < maxLines) {
      result.push(line);
    }
    if (result.length >= maxLines) break;
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
// LlmConfig 类型和 protocolForProvider 函数已迁移到 ./llm-config.ts
// 此处通过文件顶部 re-export 重新导出，保持向后兼容。

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

/** LLM 请求的 max_tokens（推理模型需要更大预算，否则可能返回空 content） */
const LLM_MAX_TOKENS = 2000;

const CLASSIFY_SYSTEM_PROMPT = '你是一个文档分类助手。只返回 JSON。';

/** 从 anthropic /v1/messages 响应提取 content[].text */
function extractAnthropicContent(payload: Record<string, unknown>): string | null {
  const blocks = payload.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return text || null;
}

/** 从 gemini generateContent 响应提取 candidates[].content.parts[].text */
function extractGeminiContent(payload: Record<string, unknown>): string | null {
  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  return text || null;
}

/**
 * 调用 LLM 获取分类结果。
 *
 * 按凭证 providerId 分派协议：
 *  - anthropic / claude → Anthropic Messages API（/messages + x-api-key）
 *  - google / gemini    → Gemini generateContent API
 *  - 其余               → openai-compatible（/chat/completions + Bearer）
 *
 * 单次调用产出分类 + 标题 + 摘要 + 关键词。
 * 失败时返回 { ok: false }，由调用方决定降级策略。
 */
export async function classifyWithLlm(
  skeleton: string,
  existingCategories: string[],
  config: LlmConfig,
): Promise<LlmResponse> {
  const prompt = buildClassificationPrompt(skeleton, existingCategories);
  const fetchFn = config.fetchFn ?? fetch;
  const base = config.baseUrl.replace(/\/+$/, '');
  const protocol = protocolForProvider(config.providerId);

  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;

  if (protocol === 'anthropic') {
    url = `${base}/messages`;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: config.model,
      max_tokens: LLM_MAX_TOKENS,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    };
  } else if (protocol === 'gemini') {
    const vbase = base.includes('/v1beta') ? base : `${base}/v1beta`;
    url = `${vbase}/models/${config.model}:generateContent?key=${config.apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = {
      systemInstruction: { parts: [{ text: CLASSIFY_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: LLM_MAX_TOKENS },
    };
  } else {
    // openai 兼容协议 — 按凭证的 apiFormat 分派 /chat/completions 或 /responses
    const request = buildDirectChatRequest({
      baseUrl: base,
      apiFormat: config.apiFormat,
      model: config.model,
      system: CLASSIFY_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: LLM_MAX_TOKENS,
      temperature: 0.3,
    });
    url = request.url;
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };
    body = request.body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      return { ok: false, error: `LLM API 返回 ${response.status}: ${details.slice(0, 200)}` };
    }

    const payload = await response.json() as Record<string, unknown>;
    const content = protocol === 'anthropic'
      ? extractAnthropicContent(payload)
      : protocol === 'gemini'
        ? extractGeminiContent(payload)
        : extractOpenAiFamilyContent(payload);

    if (content === null) {
      return { ok: false, error: `LLM 返回格式异常：无法从 ${protocol} 响应中提取文本` };
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

// ── 单文档分类流程 ──────────────────────────────────────────────

/** classifyMarkdownFile 结果 */
export type ClassifyFileResult = {
  classification: ClassificationResult;
  /** true = LLM 未配置或调用失败，降级为占位分类 */
  degraded: boolean;
  /** 降级原因（用户可读） */
  error?: string;
};

/**
 * 读取 Markdown 文件 → 骨架截取 → LLM 分类。
 *
 * 不写 index.md（由调用方在文件归位后以最终路径调用 upsertIndexEntry），
 * 避免"临时路径写入 + 字符串替换修正"在重复上传时污染索引路径。
 *
 * LLM 失败时降级：分类"未分类"、标题用文件名、摘要留空。
 */
export async function classifyMarkdownFile(
  markdownPath: string,
  existingCategories: string[],
  llmConfig: LlmConfig | null,
): Promise<ClassifyFileResult> {
  const markdown = await readFile(markdownPath, 'utf-8');
  const skeleton = extractSkeleton(markdown);

  if (!llmConfig) {
    return {
      degraded: true,
      error: '未配置 LLM 凭证（设置 → 凭证管理）',
      classification: degradedClassification(markdownPath),
    };
  }

  const llmResult = await classifyWithLlm(skeleton, existingCategories, llmConfig);
  if (llmResult.ok) {
    return { classification: llmResult.result, degraded: false };
  }
  return {
    degraded: true,
    error: llmResult.error,
    classification: degradedClassification(markdownPath),
  };
}

/** 降级占位分类：分类"未分类"、标题用文件名 */
function degradedClassification(markdownPath: string): ClassificationResult {
  return {
    category: '未分类',
    title: basename(markdownPath, '.md'),
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

    // 路径行（容错：strip 首尾多余反引号，自愈历史双前导反引号脏数据）
    if (trimmed.startsWith(PATH_PREFIX)) {
      currentPath = trimmed.slice(PATH_PREFIX.length).replace(/^`+/, '').replace(/`+$/, '');
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
  // 注意：PATH_PREFIX 已含开头的反引号，这里只补结尾反引号。
  // （历史上此处多写了一个前导反引号，导致解析出的 path 带 ` 前缀，
  //  renameCategory 的路径前缀匹配失效 —— 路径永远是旧分类。）
  const lines = [
    `### ${entry.title}`,
    `${PATH_PREFIX}${entry.path}\``,
    `${SUMMARY_PREFIX}${entry.summary || '（暂无摘要）'}`,
  ];
  if (keywords) {
    lines.push(`${KEYWORDS_PREFIX}${keywords}`);
  }
  return lines.join('\n');
}

/**
 * 将条目列表 + 分类顺序序列化为 index.md 文本。
 *
 * 这是 index.md 格式的单一拥有者：parse / merge / remove / serialize 都住在此模块。
 * pipeline 的 moveDocumentCategory / renameCategory 消费此函数，不再各自维护副本。
 */
export function serializeIndexMd(entries: IndexEntry[], categoryOrder: string[]): string {
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

/** 判断 index 条目是否指向指定文档（按路径末段精确匹配，避免 `My_DDR5.md` 被误判为 `DDR5.md` 的条目） */
export function entryBelongsToDoc(entry: IndexEntry, docName: string): boolean {
  return entry.path === `${docName}.md` || entry.path.endsWith(`/${docName}.md`);
}

/**
 * 以最终路径写入/更新文档的索引条目。
 *
 * 先移除该文档的所有旧条目（覆盖重复上传、跨分类移动残留的
 * 陈旧路径，如「未分类/未分类/x.md」这类脏数据），再合并新条目。
 *
 * @param indexMdPath index.md 绝对路径
 * @param docName 文档名（不含扩展名，主键）
 * @param entry 新条目（path 必须是相对 docs/ 的最终路径）
 */
export async function upsertIndexEntry(
  indexMdPath: string,
  docName: string,
  entry: IndexEntry,
): Promise<void> {
  let indexContent = '';
  if (existsSync(indexMdPath)) {
    indexContent = await readFile(indexMdPath, 'utf-8');
  }

  const { entries, categoryOrder } = parseIndexMd(indexContent);
  const cleaned = entries.filter((e) => !entryBelongsToDoc(e, docName));
  cleaned.push(entry);

  const keptOrder = categoryOrder.filter((c) => cleaned.some((e) => e.category === c));
  if (!keptOrder.includes(entry.category)) {
    keptOrder.push(entry.category);
  }

  await mkdir(dirname(indexMdPath), { recursive: true });
  await writeFile(indexMdPath, serializeIndexMd(cleaned, keptOrder), 'utf-8');
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
