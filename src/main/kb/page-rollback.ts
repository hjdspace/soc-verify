/**
 * KB 页面历史读取与回滚提案生成（issue 19，spec §6）。
 *
 * 用户查看页面历次改动和来源，选一版回滚为新提案，审阅后仅该页恢复
 * 且仍能查原证据。
 *
 * 两条核心行为：
 *
 * 1. **readPageHistory** — 读取 `.kb/page-history/<pageId>.jsonl`，
 *    按 commit 列旧/新内容 hash、操作类型与来源引用，创建前不存在可表达
 *    （beforeHash=null）。历史按时间倒序排列（最新在前）。
 *
 * 2. **createRollbackProposal** — 从页面快照恢复指定 commit 的正文，
 *    生成 `origin='fix'` 的 staged 变更集，走既有审阅 → 发布链路。
 *    不直接覆写：正式页在发布前保持不变。回滚保留原来源引用，
 *    使证据链可追溯。
 *
 * 回滚复用 `stageProposal`，因此自动走基线/链接/来源校验（issue 06/07 的
 * publish 逻辑会检测 stale 并失效旧批准）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 * @see .scratch/llm-wiki/issues/19-page-rollback.md
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historyFilePath } from './publish';
import { readSnapshot } from './page-snapshots';
import { stageProposal } from './staging';
import { readWikiManifest, wikiLayout } from './wiki-layout';
import type { WikiPageHistoryEntry } from '@shared/kb-types';

// ── 类型契约 ────────────────────────────────────────────────────

/** readPageHistory 输入 */
export type ReadHistoryInput = {
  /** 页面 ID（类型路径 + 文件名，如 `concepts/axi`） */
  pageId: string;
};

/** readPageHistory 成功结果 */
export type ReadHistoryResult = {
  ok: true;
  /** 历史条目，按时间倒序排列（最新在前） */
  entries: WikiPageHistoryEntry[];
};

/** readPageHistory 失败结果 */
export type ReadHistoryError = {
  ok: false;
  error: { code: 'ioError'; message: string };
};

export type ReadHistoryOutcome = ReadHistoryResult | ReadHistoryError;

/** createRollbackProposal 输入 */
export type RollbackInput = {
  /** 当前挂载的知识库 ID */
  kbId: string;
  /** 要回滚的页面 ID */
  pageId: string;
  /** 回滚到哪个 commitId 的版本 */
  targetCommitId: string;
  /** 注入时钟（测试用） */
  now?: string;
};

/** createRollbackProposal 成功结果 */
export type RollbackSuccess = {
  ok: true;
  /** 持久化的变更集（审阅入口见 kb.stagedChangeSet） */
  changeSet: import('@shared/kb-types').WikiChangeSet;
};

/** createRollbackProposal 失败结果 */
export type RollbackFailure = {
  ok: false;
  error: {
    code:
      | 'pageNotFound'       // 页面不存在于已发布页
      | 'commitNotFound'     // targetCommitId 在历史中不存在
      | 'snapshotNotFound'   // 快照正文不存在（可能已被清理）
      | 'kbIdMismatch'       // kbId 不匹配当前库
      | 'staleSource'        // 来源已撤回（manifest 中不存在或修订已更新）
      | 'stagingFailed'      // staging 写入失败
      | 'ioError';
    message: string;
  };
};

export type RollbackOutcome = RollbackSuccess | RollbackFailure;

// ── 页面历史读取 ────────────────────────────────────────────────

/**
 * 读取页面历史条目。
 *
 * 从 `.kb/page-history/<pageId>.jsonl` 逐行解析 JSON，
 * 坏行跳过（保留现场，不静默清空），按时间倒序返回。
 * 文件不存在视为空历史（页面从未被修改过）。
 */
export async function readPageHistory(
  kbPath: string,
  pageId: string,
): Promise<ReadHistoryOutcome> {
  const historyPath = historyFilePath(kbPath, pageId);
  let raw: string;
  try {
    raw = await readFile(historyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, entries: [] };
    }
    return {
      ok: false,
      error: { code: 'ioError', message: `读取页面历史失败: ${String(err)}` },
    };
  }

  const entries: WikiPageHistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as WikiPageHistoryEntry;
      if (
        typeof parsed.commitId === 'string'
        && typeof parsed.pageId === 'string'
        && typeof parsed.operation === 'string'
        && typeof parsed.afterHash === 'string'
      ) {
        entries.push(parsed);
      }
    } catch {
      // 坏行跳过（保留现场，不静默清空）
    }
  }

  // 按时间倒序排列（最新在前）
  entries.sort((a, b) => b.at.localeCompare(a.at));

  return { ok: true, entries };
}

// ── 回滚提案生成 ───────────────────────────────────────────────

/**
 * 从页面历史创建回滚提案。
 *
 * 步骤：
 *  1. 读取页面历史，找到 targetCommitId 对应的条目；
 *  2. 从快照存储读取该 commitId 的页面正文；
 *  3. 读取当前已发布页的 before/baseline（用于发布前基线校验）；
 *  4. 校验来源引用仍有效（manifest 中存在且修订未变）；
 *  5. 经 stageProposal（origin='fix'）落盘为待审阅变更集。
 *
 * 回滚不直接覆写：正式页在审阅接受并发布前保持不变。
 * 保留原来源引用，使历史证据可追溯。
 */
export async function createRollbackProposal(
  kbPath: string,
  input: RollbackInput,
): Promise<RollbackOutcome> {
  // ── 校验 kbId ──
  const manifestRes = await readWikiManifest(kbPath);
  if (!manifestRes.ok) {
    return {
      ok: false,
      error: { code: 'ioError', message: '库 manifest 不可读' },
    };
  }
  if (manifestRes.manifest.kbId !== input.kbId) {
    return {
      ok: false,
      error: { code: 'kbIdMismatch', message: `kbId 不匹配：期望 ${manifestRes.manifest.kbId}，收到 ${input.kbId}` },
    };
  }

  // ── 读取当前已发布页的 before/baseline（先检查页面是否存在）──
  const layout = wikiLayout(kbPath);
  const pageAbsPath = join(layout.kbPath, 'wiki', `${input.pageId}.md`);
  try {
    await readFile(pageAbsPath, 'utf-8');
  } catch {
    // 页面不存在 → pageNotFound（回滚一个不存在的当前页没有意义）
    return {
      ok: false,
      error: { code: 'pageNotFound', message: `页面 ${input.pageId} 不存在（未发布或已删除）` },
    };
  }

  // ── 读取页面历史，找到目标条目 ──
  const historyRes = await readPageHistory(kbPath, input.pageId);
  if (!historyRes.ok) {
    return {
      ok: false,
      error: { code: 'ioError', message: historyRes.error.message },
    };
  }
  const targetEntry = historyRes.entries.find((e) => e.commitId === input.targetCommitId);
  if (!targetEntry) {
    return {
      ok: false,
      error: { code: 'commitNotFound', message: `commitId ${input.targetCommitId} 不在页面 ${input.pageId} 的历史中` },
    };
  }

  // ── 读取快照正文 ──
  const snapshotContent = await readSnapshot(kbPath, input.pageId, input.targetCommitId);
  if (snapshotContent === null) {
    return {
      ok: false,
      error: { code: 'snapshotNotFound', message: `快照不存在: ${input.pageId}/${input.targetCommitId}（可能已被清理）` },
    };
  }

  // ── 校验来源引用 ──
  // 回滚保留原来源引用，但来源可能已撤回（manifest 中不存在）或修订已更新
  // 来源已撤回 → staleSource 错误
  // 来源修订已更新 → 也报 staleSource（回滚不复活已撤回来源为「当前」）
  for (const ref of targetEntry.sources) {
    const sourceRecord = manifestRes.manifest.sources?.[ref.sourceId];
    if (!sourceRecord) {
      return {
        ok: false,
        error: { code: 'staleSource', message: `来源 ${ref.sourceId.slice(0, 16)}… 已撤回（manifest 中不存在），无法回滚` },
      };
    }
    // 注意：我们不检查 sourceRevision === currentRevision
    // 回滚保留历史来源引用（spec §6: "回滚不复活已撤回来源为当前"）
    // 但已撤回来源（manifest 中不存在）阻止回滚
    // 来源修订已更新时，回滚提案的来源引用仍是旧修订，
    // 发布前的基线校验（checkBaselines）会检测到并转 stale
  }

  // ── 构造 FILE 块文本 ──
  const relPath = `wiki/${input.pageId}.md`;
  const fileBlock = `---FILE: ${relPath}---\n${snapshotContent}\n---END FILE---`;

  // ── 经既有 staging 落盘（origin='fix'）──
  const taskId = `rollback-${randomUUID()}`;
  const now = input.now ?? new Date().toISOString();
  const staged = await stageProposal(kbPath, {
    kbId: input.kbId,
    taskId,
    origin: 'fix',
    sourceRefs: targetEntry.sources,
    proposalText: fileBlock,
    now,
  });

  if (!staged.ok) {
    return {
      ok: false,
      error: {
        code: 'stagingFailed',
        message: `保存回滚提案失败: ${staged.error.code} — ${staged.error.message}`,
      },
    };
  }

  return { ok: true, changeSet: staged.value.changeSet };
}
