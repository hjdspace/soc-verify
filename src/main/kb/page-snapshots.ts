/**
 * KB 页面快照存储 — 发布时按 commitId 保存页面内容快照（issue 19，spec §6）。
 *
 * 页面历史（`.kb/page-history/<pageId>.jsonl`）只存 hash 和元数据，不含正文。
 * 回滚需要历史版本的**正文**，因此在发布时同步写一份快照到
 * `.kb/page-snapshots/<pageId 展平>/<commitId>.md`。
 *
 * 快照是派生数据：可从历史 + 事务日志重建，但本期直接写入以简化回滚读取。
 * 快照内容 = 发布后该页的正文（即 history entry 的 afterHash 对应的内容）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 */

import { join } from 'node:path';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { wikiLayout } from './wiki-layout';

// ── 路径 ──────────────────────────────────────────────────────────

/** 快照目录：`.kb/page-snapshots/<pageId 展平>/` */
function snapshotDir(kbPath: string, pageId: string): string {
  return join(wikiLayout(kbPath).kbDir, 'page-snapshots', pageId.replace(/[/\\]/g, '__'));
}

/** 快照文件路径：`.kb/page-snapshots/<pageId 展平>/<commitId>.md` */
export function snapshotFilePath(kbPath: string, pageId: string, commitId: string): string {
  return join(snapshotDir(kbPath, pageId), `${commitId}.md`);
}

// ── 写入 ──────────────────────────────────────────────────────────

/**
 * 写入页面快照（发布时调用，与 historyWrites 同一次原子提交）。
 *
 * 快照内容 = 发布后该页正文（即 after 内容）。commitId 幂等：
 * 同一 commitId 重复写时跳过（崩溃恢复的 roll-forward 会重放同一内容）。
 */
export async function ensureSnapshotDir(kbPath: string, pageId: string): Promise<string> {
  const dir = snapshotDir(kbPath, pageId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── 读取 ──────────────────────────────────────────────────────────

/**
 * 读取指定 commitId 的页面快照正文。
 *
 * 不存在时返回 null（可能快照尚未写入或已被清理）。
 * 调用方应在快照缺失时给出明确错误（不静默用当前页代替）。
 */
export async function readSnapshot(
  kbPath: string,
  pageId: string,
  commitId: string,
): Promise<string | null> {
  try {
    return await readFile(snapshotFilePath(kbPath, pageId, commitId), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 列出某页所有可用的快照 commitId（用于校验回滚目标是否存在）。
 */
export async function listSnapshotCommitIds(
  kbPath: string,
  pageId: string,
): Promise<string[]> {
  try {
    const entries = await readdir(snapshotDir(kbPath, pageId));
    return entries
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}
