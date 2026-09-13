/**
 * KB Atomic Commit 测试（真实临时目录 + 故障注入）。
 *
 * 直接对着原子提交原语断言，不借道路由。故障注入方式：
 *  - rename 失败：prepare 后用同位置「目录」占位目标（rename 文件到目录必败）
 *  - 崩溃现场：手工构造 .kb/transactions/<txId> 镜像与 manifest 状态
 *  - 逃逸：Windows junction（免管理员权限）/ POSIX symlink 指向库外
 *
 * 覆盖场景：
 *  - runAtomicCommit：覆盖 + 新建端到端、tx 目录清理
 *  - prepareCommit：非法 txId / 空写入 / 重复目标（斜杠等价）/ 穿越 / junction 逃逸 /
 *    库根不可访问；镜像与 prepared 清单落盘、complete 前目标未变
 *  - completeCommit：rename 中途失败 → 进程内回滚还原旧版；committed 清单幂等补清理；
 *    未知事务 txNotFound
 *  - recoverTransactions：manifest 缺失清理 / 损坏保留现场 / txId 不符保留现场 /
 *    committed 清理 / prepared roll-forward（after 完整、rename 已发生 hash 匹配）/
 *    prepared 回滚（覆盖还原旧版、新建删除）/ 无事务目录 / 混合现场计数
 *  - writeFileAtomic：写入覆盖无残留、父目录缺失抛错
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  realpath,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import {
  prepareCommit,
  completeCommit,
  runAtomicCommit,
  recoverTransactions,
  writeFileAtomic,
} from '../src/main/kb/atomic-commit';

// ── 测试工具 ──────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function txDirOf(root: string, txId: string): string {
  return join(root, '.kb', 'transactions', txId);
}

/** 手工构造一个事务现场（模拟崩溃残留） */
async function craftTx(
  root: string,
  txId: string,
  manifest: Record<string, unknown> | null,
  files: Array<[string, string]>,
): Promise<string> {
  const txDir = txDirOf(root, txId);
  await mkdir(join(txDir, 'before'), { recursive: true });
  await mkdir(join(txDir, 'after'), { recursive: true });
  if (manifest !== null) {
    await writeFile(join(txDir, 'manifest.json'), JSON.stringify(manifest));
  }
  for (const [rel, content] of files) {
    await writeFile(join(txDir, rel), content);
  }
  return txDir;
}

// ── runAtomicCommit 端到端 ────────────────────────────────────────

describe('runAtomicCommit 端到端', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-tx-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('覆盖已存在文件 + 新建文件，提交后完整新版且事务目录清理', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'old.md'), 'V1');

    const result = await runAtomicCommit(root, {
      txId: 'tx-e2e',
      writes: [
        { relPath: 'doc/old.md', content: 'V2' },
        { relPath: 'new/created.md', content: 'C1' },
      ],
    });

    expect(result.ok).toBe(true);
    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('V2');
    await expect(readFile(join(root, 'new', 'created.md'), 'utf-8')).resolves.toBe('C1');
    expect(existsSync(txDirOf(root, 'tx-e2e'))).toBe(false);
  });
});

// ── prepareCommit ─────────────────────────────────────────────────

describe('prepareCommit', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-tx-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('持久化 before/after 镜像与 prepared 清单，complete 前目标未变', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'old.md'), 'V1');

    const prepared = await prepareCommit(root, {
      txId: 'tx-mirror',
      writes: [
        { relPath: 'doc/old.md', content: 'V2' },
        { relPath: 'doc/new.md', content: 'C1' },
      ],
    });
    expect(prepared.ok).toBe(true);

    const txDir = txDirOf(root, 'tx-mirror');
    const manifest = JSON.parse(await readFile(join(txDir, 'manifest.json'), 'utf-8')) as {
      state: string;
      writes: Array<{ relPath: string; beforeFile: string | null }>;
    };
    expect(manifest.state).toBe('prepared');
    expect(manifest.writes).toHaveLength(2);
    expect(manifest.writes[0]).toMatchObject({ relPath: 'doc/old.md', beforeFile: 'before-0.bin' });
    expect(manifest.writes[1]).toMatchObject({ relPath: 'doc/new.md', beforeFile: null });
    await expect(readFile(join(txDir, 'before', 'before-0.bin'), 'utf-8')).resolves.toBe('V1');
    await expect(readFile(join(txDir, 'after', 'after-0.bin'), 'utf-8')).resolves.toBe('V2');

    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('V1');

    const done = await completeCommit(root, 'tx-mirror');
    expect(done.ok).toBe(true);
    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('V2');
    await expect(readFile(join(root, 'doc', 'new.md'), 'utf-8')).resolves.toBe('C1');
    expect(existsSync(txDir)).toBe(false);
  });

  it('非法事务 ID / 空写入 / 重复目标被拒绝且不留现场', async () => {
    const badId = await prepareCommit(root, {
      txId: 'bad id',
      writes: [{ relPath: 'a.md', content: 'A' }],
    });
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error.code).toBe('pathRejected');

    const empty = await prepareCommit(root, { txId: 'tx-empty', writes: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('pathRejected');

    const dup = await prepareCommit(root, {
      txId: 'tx-dup',
      writes: [
        { relPath: 'a/b.md', content: '1' },
        { relPath: 'a\\b.md', content: '2' },
      ],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.message).toContain('重复目标');

    expect(existsSync(join(root, '.kb'))).toBe(false);
  });

  it('穿越目标被拒绝且不落盘', async () => {
    const result = await prepareCommit(root, {
      txId: 'tx-escape',
      writes: [{ relPath: '../evil.md', content: 'X' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('pathRejected');
    expect(existsSync(join(root, '..', 'evil.md'))).toBe(false);
    expect(existsSync(txDirOf(root, 'tx-escape'))).toBe(false);
  });

  it('目标父目录为指向库外的 junction → 拒绝且不落任何镜像', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kb-tx-outside-'));
    try {
      const outsideReal = await realpath(outside);
      await symlink(outsideReal, join(root, 'link'), 'junction');

      const result = await runAtomicCommit(root, {
        txId: 'tx-junction',
        writes: [{ relPath: 'link/escaped.md', content: 'X' }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('pathRejected');
      expect(existsSync(txDirOf(root, 'tx-junction'))).toBe(false);
      await expect(readdir(outside)).resolves.toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('库根不可访问 → ioError', async () => {
    const result = await runAtomicCommit(join(root, 'no-such-dir'), {
      txId: 'tx-x',
      writes: [{ relPath: 'a.md', content: 'A' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ioError');
  });
});

// ── completeCommit 失败注入 ───────────────────────────────────────

describe('completeCommit 失败注入', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-tx-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rename 中途失败 → 进程内回滚已应用写入，保持完整旧版', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'old.md'), 'V1');

    const prepared = await prepareCommit(root, {
      txId: 'tx-rollback',
      writes: [
        { relPath: 'doc/old.md', content: 'V2' },
        { relPath: 'doc/new.md', content: 'C1' },
      ],
    });
    expect(prepared.ok).toBe(true);

    // 故障注入：用目录占位第二个写入目标，rename 文件到目录必败
    await mkdir(join(root, 'doc', 'new.md'));

    const done = await completeCommit(root, 'tx-rollback');
    expect(done.ok).toBe(false);
    if (!done.ok) {
      expect(done.error.code).toBe('ioError');
      expect(done.error.message).toContain('已回滚');
    }

    // 第一个写入已应用（V2），失败后被回滚还原为旧版 V1
    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('V1');
    expect(existsSync(txDirOf(root, 'tx-rollback'))).toBe(false);
  });

  it('complete 遇到已 committed 清单 → 幂等补清理', async () => {
    const prepared = await prepareCommit(root, {
      txId: 'tx-committed',
      writes: [{ relPath: 'a.md', content: 'A' }],
    });
    expect(prepared.ok).toBe(true);

    // 模拟「完成标记已写、清理未做」的崩溃间隙
    const manifestPath = join(txDirOf(root, 'tx-committed'), 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { state: string };
    manifest.state = 'committed';
    await writeFile(manifestPath, JSON.stringify(manifest));

    const done = await completeCommit(root, 'tx-committed');
    expect(done.ok).toBe(true);
    expect(existsSync(txDirOf(root, 'tx-committed'))).toBe(false);
  });

  it('未知事务 → txNotFound', async () => {
    const done = await completeCommit(root, 'tx-nope');
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.error.code).toBe('txNotFound');
  });
});

// ── recoverTransactions ───────────────────────────────────────────

describe('recoverTransactions', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-tx-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('无事务目录 → 空报告', async () => {
    await expect(recoverTransactions(root)).resolves.toEqual({
      cleaned: 0,
      rolledForward: 0,
      rolledBack: 0,
      failures: [],
    });
  });

  it('manifest 缺失 → 意向未持久化，清理且目标未触碰', async () => {
    await craftTx(root, 'tx5', null, [['after/after-0.bin', 'C1']]);

    const report = await recoverTransactions(root);
    expect(report.cleaned).toBe(1);
    expect(report.failures).toHaveLength(0);
    expect(existsSync(txDirOf(root, 'tx5'))).toBe(false);
    expect(existsSync(join(root, 'doc'))).toBe(false);
  });

  it('manifest 损坏 → 保留现场并报告，不静默清空', async () => {
    await craftTx(root, 'tx6', null, []);
    await writeFile(join(txDirOf(root, 'tx6'), 'manifest.json'), '{not json');

    const report = await recoverTransactions(root);
    expect(report.failures).toHaveLength(1);
    expect(existsSync(txDirOf(root, 'tx6'))).toBe(true);
  });

  it('manifest txId 与目录名不符 → 保留现场并报告', async () => {
    await craftTx(
      root,
      'tx7',
      { txId: 'other-tx', state: 'prepared', writes: [] },
      [],
    );

    const report = await recoverTransactions(root);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('tx7');
    expect(existsSync(txDirOf(root, 'tx7'))).toBe(true);
  });

  it('committed 清单 → 仅清理', async () => {
    await craftTx(root, 'tx8', { txId: 'tx8', state: 'committed', writes: [] }, []);

    const report = await recoverTransactions(root);
    expect(report.cleaned).toBe(1);
    expect(existsSync(txDirOf(root, 'tx8'))).toBe(false);
  });

  it('prepared 且 after 镜像完整 → roll-forward 到完整新版', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'old.md'), 'V1');
    await craftTx(
      root,
      'tx1',
      {
        txId: 'tx1',
        state: 'prepared',
        writes: [
          { relPath: 'doc/old.md', beforeFile: 'before-0.bin', afterFile: 'after-0.bin', afterHash: sha256('C1') },
          { relPath: 'doc/new.md', beforeFile: null, afterFile: 'after-1.bin', afterHash: sha256('C2') },
        ],
      },
      [
        ['before/before-0.bin', 'V1'],
        ['after/after-0.bin', 'C1'],
        ['after/after-1.bin', 'C2'],
      ],
    );

    const report = await recoverTransactions(root);
    expect(report.rolledForward).toBe(1);
    expect(report.failures).toHaveLength(0);
    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('C1');
    await expect(readFile(join(root, 'doc', 'new.md'), 'utf-8')).resolves.toBe('C2');
    expect(existsSync(txDirOf(root, 'tx1'))).toBe(false);
  });

  it('prepared 且 rename 已发生（after 缺失、目标 hash 匹配）→ roll-forward', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'old.md'), 'V2');
    await craftTx(
      root,
      'tx3',
      {
        txId: 'tx3',
        state: 'prepared',
        writes: [
          { relPath: 'doc/old.md', beforeFile: 'before-0.bin', afterFile: 'after-0.bin', afterHash: sha256('V2') },
        ],
      },
      [['before/before-0.bin', 'V1']],
    );

    const report = await recoverTransactions(root);
    expect(report.rolledForward).toBe(1);
    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('V2');
    expect(existsSync(txDirOf(root, 'tx3'))).toBe(false);
  });

  it('prepared 覆盖目标且内容与预期 hash 不符 → 回滚还原旧版', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'old.md'), 'WRONG');
    await craftTx(
      root,
      'tx2',
      {
        txId: 'tx2',
        state: 'prepared',
        writes: [
          { relPath: 'doc/old.md', beforeFile: 'before-0.bin', afterFile: 'after-0.bin', afterHash: sha256('V2') },
        ],
      },
      [['before/before-0.bin', 'V1']],
    );

    const report = await recoverTransactions(root);
    expect(report.rolledBack).toBe(1);
    expect(report.failures).toHaveLength(0);
    await expect(readFile(join(root, 'doc', 'old.md'), 'utf-8')).resolves.toBe('V1');
    expect(existsSync(txDirOf(root, 'tx2'))).toBe(false);
  });

  it('prepared 新建目标且状态不符 → 回滚删除目标', async () => {
    await mkdir(join(root, 'doc'), { recursive: true });
    await writeFile(join(root, 'doc', 'new.md'), 'PARTIAL');
    await craftTx(
      root,
      'tx4',
      {
        txId: 'tx4',
        state: 'prepared',
        writes: [
          { relPath: 'doc/new.md', beforeFile: null, afterFile: 'after-0.bin', afterHash: sha256('C1') },
        ],
      },
      [],
    );

    const report = await recoverTransactions(root);
    expect(report.rolledBack).toBe(1);
    expect(existsSync(join(root, 'doc', 'new.md'))).toBe(false);
    expect(existsSync(txDirOf(root, 'tx4'))).toBe(false);
  });

  it('混合现场 → 各计数正确且损坏现场保留', async () => {
    // committed → cleaned
    await craftTx(root, 'mix-a', { txId: 'mix-a', state: 'committed', writes: [] }, []);
    // prepared 完整 → rolledForward
    await mkdir(join(root, 'doc'), { recursive: true });
    await craftTx(
      root,
      'mix-b',
      {
        txId: 'mix-b',
        state: 'prepared',
        writes: [
          { relPath: 'doc/new.md', beforeFile: null, afterFile: 'after-0.bin', afterHash: sha256('C1') },
        ],
      },
      [['after/after-0.bin', 'C1']],
    );
    // 损坏 → failures 保留
    await craftTx(root, 'mix-c', null, []);
    await writeFile(join(txDirOf(root, 'mix-c'), 'manifest.json'), 'garbage');

    const report = await recoverTransactions(root);
    expect(report.cleaned).toBe(1);
    expect(report.rolledForward).toBe(1);
    expect(report.rolledBack).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(existsSync(txDirOf(root, 'mix-c'))).toBe(true);
    await expect(readFile(join(root, 'doc', 'new.md'), 'utf-8')).resolves.toBe('C1');
  });
});

// ── writeFileAtomic ───────────────────────────────────────────────

describe('writeFileAtomic', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-tx-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('写入并覆盖既有内容，无临时文件残留', async () => {
    const p = join(root, 'f.txt');
    await writeFileAtomic(p, 'first');
    await expect(readFile(p, 'utf-8')).resolves.toBe('first');

    await writeFileAtomic(p, Buffer.from('second'));
    await expect(readFile(p, 'utf-8')).resolves.toBe('second');

    await expect(readdir(root)).resolves.toEqual(['f.txt']);
  });

  it('父目录缺失时抛错', async () => {
    await expect(writeFileAtomic(join(root, 'missing', 'f.txt'), 'x')).rejects.toThrow();
    await expect(readdir(root)).resolves.toHaveLength(0);
  });
});
