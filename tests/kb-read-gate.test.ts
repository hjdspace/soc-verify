/**
 * 事务读取门禁测试（issue 06）。
 *
 * 验收（spec §6）：“事务未恢复前同库的读取/检索 API 暂停，避免读到混合页集”；
 * “重启读取门禁先恢复”。门禁状态由磁盘推导（不依赖内存标志），
 * 因此重启后只要还有未恢复的 prepared 事务就仍然阻塞，恢复完成后自动放行。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGateStatus, assertReadGateOpen, WikiReadGateError } from '../src/main/kb/read-gate';
import { initWikiLayout, wikiLayout } from '../src/main/kb/wiki-layout';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-gate-'));
  await initWikiLayout(kbPath, { kbId: 'kb-1', name: 'KB' });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

function writeTx(txId: string, manifest: string | null): void {
  const dir = join(wikiLayout(kbPath).transactionsDir, txId);
  mkdirSync(dir, { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, 'manifest.json'), manifest, 'utf-8');
}

const preparedManifest = (txId: string): string => JSON.stringify({
  txId,
  state: 'prepared',
  writes: [{ relPath: 'wiki/concepts/a.md', beforeFile: null, afterFile: 'after-0.bin', afterHash: 'h' }],
});

describe('readGateStatus', () => {
  it('无事务目录时放行', async () => {
    const status = await readGateStatus(kbPath);
    expect(status.blocked).toBe(false);
    expect(status.pending).toEqual([]);
  });

  it('存在 prepared 事务时阻塞，并列出事务 ID', async () => {
    writeTx('tx-1', preparedManifest('tx-1'));
    const status = await readGateStatus(kbPath);
    expect(status.blocked).toBe(true);
    expect(status.pending).toEqual(['tx-1']);
  });

  it('committed 事务只待清理，不阻塞读取', async () => {
    writeTx('tx-2', JSON.stringify({ txId: 'tx-2', state: 'committed', writes: [] }));
    const status = await readGateStatus(kbPath);
    expect(status.blocked).toBe(false);
    expect(status.pending).toEqual([]);
  });

  it('无 manifest 的事务目录（意向未持久化）不阻塞', async () => {
    writeTx('tx-3', null);
    const status = await readGateStatus(kbPath);
    expect(status.blocked).toBe(false);
  });

  it('manifest 损坏的事务计入 corrupt（现场保留）并阻塞读取', async () => {
    writeTx('tx-4', '{ 坏 JSON');
    const status = await readGateStatus(kbPath);
    expect(status.pending).toEqual([]);
    expect(status.corrupt).toEqual(['tx-4']);
    // 无法判断 rename 是否发生 → 宁可拒绝服务也不读到混合页集
    expect(status.blocked).toBe(true);
  });
});

describe('assertReadGateOpen', () => {
  it('门禁开放时不抛错', async () => {
    await expect(assertReadGateOpen(kbPath)).resolves.toBeUndefined();
  });

  it('门禁阻塞时抛 WikiReadGateError（结构化 code + pending）', async () => {
    writeTx('tx-1', preparedManifest('tx-1'));
    await expect(assertReadGateOpen(kbPath)).rejects.toBeInstanceOf(WikiReadGateError);
    const err = await assertReadGateOpen(kbPath).catch((e: unknown) => e) as WikiReadGateError;
    expect(err.code).toBe('readGateBlocked');
    expect(err.status.pending).toEqual(['tx-1']);
  });
});
