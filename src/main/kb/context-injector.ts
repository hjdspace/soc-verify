/**
 * KB Context Injector — 会话创建时注入知识库索引上下文。
 *
 * 在会话创建时读取挂载库的 index.md，注入 Agent 系统上下文
 * （与项目信息注入同层，复用现有 session-context 机制）。
 *
 * 索引超长时截断并附加提示"索引已截断，完整检索请使用 kb_search 工具"。
 * 未挂载库时不注入。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { kbRegistry } from '../kb/registry';

// ── 常量 ────────────────────────────────────────────────────────

/** 索引注入的最大字符数（超出截断） */
const MAX_INDEX_CHARS = 8000;

/** 截断提示语 */
const TRUNCATION_NOTICE =
  '\n\n<!-- 索引已截断，完整检索请使用 kb_search 工具 -->\n';

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
 * 截断索引内容，超出限制时附加提示。
 */
function truncateIndex(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }

  // 截断到最大长度，尽量在完整行处截断
  let cutPoint = maxChars;
  const lastNewline = content.lastIndexOf('\n', maxChars);
  if (lastNewline > maxChars * 0.8) {
    cutPoint = lastNewline;
  }

  return {
    text: content.slice(0, cutPoint) + TRUNCATION_NOTICE,
    truncated: true,
  };
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
  const indexMdPath = join(kbPath, 'index.md');

  if (!existsSync(indexMdPath)) {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  let indexContent: string;
  try {
    indexContent = await readFile(indexMdPath, 'utf-8');
  } catch {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  // 空索引不注入
  const trimmed = indexContent.trim();
  if (!trimmed) {
    return { contextText: '', kbName, kbPath, truncated: false };
  }

  const { text, truncated } = truncateIndex(indexContent, MAX_INDEX_CHARS);

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
