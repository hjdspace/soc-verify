/**
 * KB Context Injector — 会话创建时注入知识库索引上下文。
 *
 * 在会话创建时读取挂载库的 index.md，注入 Agent 系统上下文
 * （与项目信息注入同层，复用现有 session-context 机制）。
 *
 * 索引超长时不做硬截断（硬截断会让排在后面的分类对 Agent 完全不可见，
 * Agent 不知道它们存在，自然也不会去 kb_search），而是结构化降级为
 * 压缩视图，逐级保留可发现性：
 *   1. 原文注入（不超限时）
 *   2. 全条目压缩：每条目一行「标题（路径）」，省略摘要/关键词
 *   3. 标题行压缩：每分类一行，保留全部文档标题
 *   4. 仅分类名：每分类一行「分类名（N 篇）」
 * 压缩时附加"索引已截断，完整检索请使用 kb_search 工具"提示。
 * 未挂载库时不注入。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { kbRegistry } from '../kb/registry';
import { kbLayout } from '../kb/layout';
import { parseIndexMd } from '../kb/indexer';
import type { IndexEntry } from '../kb/types';

// ── 常量 ────────────────────────────────────────────────────────

/** 索引注入的最大字符数（超出时结构化降级为压缩视图） */
const MAX_INDEX_CHARS = 8000;

/** 截断提示语 */
const TRUNCATION_NOTICE =
  '\n\n<!-- 索引已截断：以上为压缩视图（保留全部分类）。完整检索请使用 kb_search 工具 -->\n';

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
 * 索引超长时的结构化降级。
 *
 * 硬截断会把 index.md 后半部分的分类整体丢掉——Agent 不知道它们存在，
 * 自然也不会去 kb_search。这里改为逐级压缩，保证所有分类始终可见：
 *   阶段 1：全条目压缩（标题 + 路径，去摘要/关键词）
 *   阶段 2：每分类单行（全部文档标题）
 *   阶段 3：仅分类名 + 文档数
 */
function compactIndex(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }

  const { entries, categoryOrder } = parseIndexMd(content);
  if (entries.length === 0) {
    // 解析失败（可能是手工编辑的非标准格式）→ 退回行边界硬截断
    let cutPoint = maxChars;
    const lastNewline = content.lastIndexOf('\n', maxChars);
    if (lastNewline > maxChars * 0.8) {
      cutPoint = lastNewline;
    }
    return { text: content.slice(0, cutPoint) + TRUNCATION_NOTICE, truncated: true };
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

  // 阶段 1：全条目压缩
  const stage1 = categories
    .map((c) => {
      const list = byCategory.get(c) ?? [];
      return [`## ${c}（${list.length} 篇）`, ...list.map((e) => `- ${e.title}（${e.path}）`)].join('\n');
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

  const { text, truncated } = compactIndex(indexContent, MAX_INDEX_CHARS);

  const contextText = `<kb-index kb-name="${kbName}">\n${text}\n</kb-index>`;

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
