/**
 * KB Read Gate — 未恢复事务期间的读取门禁（spec §6，issue 06）。
 *
 * 「事务未恢复前同库的读取/检索 API 暂停，避免读到混合页集。」
 * 发布事务的 rename 是逐文件的：prepare 之后、complete 结束之前，
 * wiki/ 下可能同时存在新旧两版页面。本模块为读接口提供统一入口，
 * 在此时拒绝服务，直到 `recoverTransactions` 把事务收敛为完整旧版或完整新版。
 *
 * 门禁状态**由磁盘推导**而非内存标志：应用重启后内存状态清空，
 * 但只要 `.kb/transactions/` 下仍有 `state=prepared` 的事务，读取
 * 就必须继续暂停——这正是「重启读取门禁先恢复」的含义。
 * 挂载时 registry 已先跑 `recoverTransactions`，恢复完成后门禁自然放行。
 *
 * 不阻塞的两类残留：无 manifest（意向未持久化，rename 必然未发生 →
 * 完整旧版）与 `state=committed`（rename 已全部完成，只剩清理 → 完整新版）。
 * 阻塞的两类：`state=prepared`（rename 可能已部分发生）与 manifest 损坏
 * （无法判断 rename 是否发生）。损坏现场由恢复流程保留并在挂载报告里
 * 上报，读取在此前保持暂停 —— 宁可拒绝服务，也不读到混合页集。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §5、§6
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { wikiLayout } from './wiki-layout';
import type { WikiReadGateStatus } from '@shared/kb-types';

export const READ_GATE_BLOCKED_CODE = 'readGateBlocked';

export class WikiReadGateError extends Error {
  readonly code = READ_GATE_BLOCKED_CODE;
  readonly status: WikiReadGateStatus;

  constructor(status: WikiReadGateStatus) {
    const parts = [
      status.pending.length > 0 ? `未完成事务: ${status.pending.join(', ')}` : '',
      status.corrupt.length > 0
        ? `损坏事务清单（现场已保留，需人工检查 .kb/transactions/）: ${status.corrupt.join(', ')}`
        : '',
    ].filter((p) => p.length > 0);
    super(
      `知识库存在未恢复的发布事务，读取与发布已暂停；`
      + `请先完成恢复（重新挂载知识库）。${parts.join('；')}`,
    );
    this.name = 'WikiReadGateError';
    this.status = status;
  }
}

/** 读取门禁状态（prepared 或损坏清单的事务 = 阻塞）。 */
export async function readGateStatus(kbPath: string): Promise<WikiReadGateStatus> {
  const txRoot = wikiLayout(kbPath).transactionsDir;
  let entries: string[];
  try {
    entries = await readdir(txRoot);
  } catch {
    return { blocked: false, pending: [], corrupt: [] };
  }

  const pending: string[] = [];
  const corrupt: string[] = [];

  for (const txId of entries) {
    const txDir = join(txRoot, txId);
    try {
      if (!(await stat(txDir)).isDirectory()) continue;
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(join(txDir, 'manifest.json'), 'utf-8');
    } catch {
      continue; // 无 manifest：意向未持久化，目标未被触碰
    }

    try {
      const manifest = JSON.parse(raw) as { txId?: unknown; state?: unknown };
      if (manifest.state === 'prepared') pending.push(txId);
    } catch {
      corrupt.push(txId);
    }
  }

  pending.sort((a, b) => a.localeCompare(b));
  corrupt.sort((a, b) => a.localeCompare(b));
  return { blocked: pending.length > 0 || corrupt.length > 0, pending, corrupt };
}

/** 门禁阻塞时抛 WikiReadGateError；否则放行。 */
export async function assertReadGateOpen(kbPath: string): Promise<void> {
  const status = await readGateStatus(kbPath);
  if (status.blocked) throw new WikiReadGateError(status);
}
