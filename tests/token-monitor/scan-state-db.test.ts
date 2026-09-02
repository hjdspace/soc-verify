/**
 * scan_state 表 DB 操作测试。
 *
 * 验证 scan_state 表的增量扫描支持：
 * - 表结构正确创建
 * - getScanState / upsertScanState / getAllScanStates 正确工作
 * - UPSERT 语义（重复 file_path 更新而非插入）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

import {
  createMemoryDatabase,
  closeDatabase,
  getScanState,
  upsertScanState,
  getAllScanStates,
  type ScanStateEntry,
} from '../../src/main/token-monitor/token-monitor-db';

// ─── Helpers ───────────────────────────────────────────────

function makeEntry(overrides: Partial<ScanStateEntry> = {}): ScanStateEntry {
  return {
    filePath: '/home/user/.claude/projects/session-1.jsonl',
    lastMtime: 1700000000000,
    byteOffset: 1024,
    scannedAt: Date.now(),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────

describe('scan_state — 表结构', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('scan_state 表包含所有必需字段', () => {
    const columns = db.prepare("PRAGMA table_info('scan_state')").all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('file_path');
    expect(colNames).toContain('last_mtime');
    expect(colNames).toContain('byte_offset');
    expect(colNames).toContain('scanned_at');
  });

  it('file_path 是主键（唯一约束）', () => {
    const entry = makeEntry({ filePath: '/file/a.jsonl' });
    upsertScanState(db, entry);
    upsertScanState(db, { ...entry, byteOffset: 9999 });

    const count = db.prepare('SELECT COUNT(*) as cnt FROM scan_state').get() as { cnt: number };
    expect(count.cnt).toBe(1);

    const row = db.prepare('SELECT byte_offset FROM scan_state WHERE file_path = ?').get('/file/a.jsonl') as { byte_offset: number };
    expect(row.byte_offset).toBe(9999); // Updated, not inserted
  });
});

describe('scan_state — getScanState', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('不存在的文件返回 null', () => {
    const result = getScanState(db, '/nonexistent.jsonl');
    expect(result).toBeNull();
  });

  it('存在的文件返回正确记录', () => {
    const entry = makeEntry({
      filePath: '/logs/session.jsonl',
      lastMtime: 1700000000000,
      byteOffset: 2048,
      scannedAt: 1700000005000,
    });
    upsertScanState(db, entry);

    const result = getScanState(db, '/logs/session.jsonl');
    expect(result).not.toBeNull();
    expect(result!.filePath).toBe('/logs/session.jsonl');
    expect(result!.lastMtime).toBe(1700000000000);
    expect(result!.byteOffset).toBe(2048);
    expect(result!.scannedAt).toBe(1700000005000);
  });
});

describe('scan_state — upsertScanState', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('首次插入新记录', () => {
    upsertScanState(db, makeEntry());

    const result = getScanState(db, '/home/user/.claude/projects/session-1.jsonl');
    expect(result).not.toBeNull();
    expect(result!.byteOffset).toBe(1024);
  });

  it('重复 file_path 更新已有记录', () => {
    upsertScanState(db, makeEntry({ byteOffset: 1024 }));
    upsertScanState(db, makeEntry({ byteOffset: 4096, lastMtime: 1700000100000 }));

    const result = getScanState(db, '/home/user/.claude/projects/session-1.jsonl');
    expect(result).not.toBeNull();
    expect(result!.byteOffset).toBe(4096);
    expect(result!.lastMtime).toBe(1700000100000);

    // Only one row
    const count = db.prepare('SELECT COUNT(*) as cnt FROM scan_state').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });
});

describe('scan_state — getAllScanStates', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMemoryDatabase();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('空数据库返回空 Map', () => {
    const result = getAllScanStates(db);
    expect(result.size).toBe(0);
  });

  it('返回所有记录', () => {
    upsertScanState(db, makeEntry({ filePath: '/file/a.jsonl' }));
    upsertScanState(db, makeEntry({ filePath: '/file/b.jsonl', byteOffset: 2048 }));
    upsertScanState(db, makeEntry({ filePath: '/file/c.jsonl', byteOffset: 3072 }));

    const result = getAllScanStates(db);
    expect(result.size).toBe(3);
    expect(result.get('/file/a.jsonl')!.byteOffset).toBe(1024);
    expect(result.get('/file/b.jsonl')!.byteOffset).toBe(2048);
    expect(result.get('/file/c.jsonl')!.byteOffset).toBe(3072);
  });
});
