/**
 * Scan Scheduler 模块测试。
 *
 * 测试缝：ScanScheduler 类公开 API。
 * 验证：
 * - 5 分钟定时器设置
 * - 增量扫描（mtime 未变跳过，mtime 变化续读）
 * - 文件截断时重置 byte_offset
 * - 去重：解析的记录通过 recordUsage INSERT OR IGNORE
 * - 手动触发扫描立即执行
 * - lastScanAt 时间戳更新
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import {
  createMemoryDatabase,
  closeDatabase,
  getScanState,
  getSummary,
} from '../../src/main/token-monitor/token-monitor-db';

// ─── Mock path scanner functions ───────────────────────────

vi.mock('../../src/main/token-monitor/log-scanner-paths', () => ({
  getAllScanDirs: vi.fn(() => []),
  discoverJsonlFiles: vi.fn(() => []),
  // doScan 走异步流式枚举 + 行边界偏移 —— mock 保持真实行为
  discoverJsonlFilesAsync: vi.fn(async (dirPath: string) => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const files: string[] = [];
    const walk = (d: string): void => {
      try {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(full);
        }
      } catch {
        /* 静默降级 */
      }
    };
    walk(dirPath);
    return files;
  }),
  lastCompleteLineOffset: vi.fn(async (filePath: string) => {
    const { statSync, openSync, readSync, closeSync } = require('node:fs') as typeof import('node:fs');
    try {
      const size = statSync(filePath).size;
      const fd = openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(size);
        readSync(fd, buf, 0, size, 0);
        const idx = buf.lastIndexOf(0x0a);
        return idx >= 0 ? idx + 1 : 0;
      } finally {
        closeSync(fd);
      }
    } catch {
      return 0;
    }
  }),
  getFileStat: vi.fn(() => null),
  resolveClaudeLogDir: vi.fn(() => '/mock/claude'),
  resolveCodexLogDir: vi.fn(() => '/mock/codex'),
}));

// ─── Import after mocks ────────────────────────────────────

import { ScanScheduler } from '../../src/main/token-monitor/scan-scheduler';
import {
  getAllScanDirs,
  discoverJsonlFiles,
  getFileStat,
} from '../../src/main/token-monitor/log-scanner-paths';

const mockedGetAllScanDirs = vi.mocked(getAllScanDirs);
const mockedDiscoverJsonlFiles = vi.mocked(discoverJsonlFiles);
const mockedGetFileStat = vi.mocked(getFileStat);

// ─── Helpers ───────────────────────────────────────────────

const testDir = join(tmpdir(), `sv-scan-sched-${Date.now()}`);

function writeJsonlFile(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  // 真实 claude-code / codex 日志每行以 \n 结尾；
  // 扫描器偏移停在行边界，无尾换行 = writer 未写完的半行，不推进偏移
  writeFileSync(filePath, lines.join('\n') + '\n');
}

function makeAssistantJsonl(messageId: string, tokens: number = 1000): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-scan-test',
    message: {
      role: 'assistant',
      id: messageId,
      model: 'claude-sonnet-4',
      usage: { input_tokens: tokens, output_tokens: 500, cache_read_input_tokens: 100 },
    },
  });
}

// ─── Tests ─────────────────────────────────────────────────

describe('ScanScheduler — 增量扫描', () => {
  let db: Database.Database;
  let scheduler: ScanScheduler;

  const jsonlFile1 = join(testDir, 'sessions', 'sess-1.jsonl');
  const jsonlFile2 = join(testDir, 'sessions', 'sess-2.jsonl');

  beforeEach(() => {
    mkdirSync(join(testDir, 'sessions'), { recursive: true });
    db = createMemoryDatabase();
    scheduler = new ScanScheduler(db, { intervalMs: 60_000 });
    vi.clearAllMocks();

    // Default: scans find the jsonl files
    mockedGetAllScanDirs.mockReturnValue([
      { engine: 'claude-code', dir: join(testDir, 'sessions') },
    ]);
    mockedDiscoverJsonlFiles.mockImplementation((dir: string) => {
      if (dir === join(testDir, 'sessions')) {
        return [jsonlFile1, jsonlFile2];
      }
      return [];
    });
    mockedGetFileStat.mockImplementation((filePath: string) => {
      // When stat fails for nonexistent files
      if (filePath === jsonlFile1 || filePath === jsonlFile2) {
        try {
          const { statSync } = require('node:fs') as typeof import('node:fs');
          return statSync(filePath);
        } catch {
          return null;
        }
      }
      return null;
    });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('首次扫描：所有文件从头解析', async () => {
    // Create test files
    writeJsonlFile(jsonlFile1, [makeAssistantJsonl('msg-1'), makeAssistantJsonl('msg-2')]);
    writeJsonlFile(jsonlFile2, [makeAssistantJsonl('msg-3', 2000)]);

    const result = await scheduler.scanOnce();

    expect(result.recordsInserted).toBe(3);
    expect(result.filesScanned).toBe(2);

    // Verify scan_state was updated
    const state1 = getScanState(db, jsonlFile1);
    expect(state1).not.toBeNull();
    expect(state1!.byteOffset).toBeGreaterThan(0);

    const state2 = getScanState(db, jsonlFile2);
    expect(state2).not.toBeNull();
    expect(state2!.byteOffset).toBeGreaterThan(0);
  });

  it('mtime 未变化时跳过文件', async () => {
    // Create and first scan
    writeJsonlFile(jsonlFile1, [makeAssistantJsonl('msg-1')]);
    await scheduler.scanOnce();

    // Second scan — files unchanged
    const result2 = await scheduler.scanOnce();
    expect(result2.filesSkipped).toBe(1);
    expect(result2.recordsInserted).toBe(0);
  });

  it('文件截断时重置 byte_offset', async () => {
    // Create and first scan (large file)
    writeJsonlFile(jsonlFile1, [
      makeAssistantJsonl('msg-1'),
      makeAssistantJsonl('msg-2'),
      makeAssistantJsonl('msg-3'),
    ]);
    await scheduler.scanOnce();

    const stateBefore = getScanState(db, jsonlFile1)!;
    expect(stateBefore.byteOffset).toBeGreaterThan(0);

    // Truncate file (simulating log rotation)
    writeJsonlFile(jsonlFile1, [makeAssistantJsonl('msg-new')]);

    const result = await scheduler.scanOnce();
    expect(result.recordsInserted).toBeGreaterThan(0);

    const stateAfter = getScanState(db, jsonlFile1)!;
    expect(stateAfter.byteOffset).toBeLessThan(stateBefore.byteOffset);
  });

  it('去重：同 (engine, session_id, message_id) 重复记录仅写入一次', async () => {
    writeJsonlFile(jsonlFile1, [makeAssistantJsonl('msg-dup')]);

    // First scan
    const result1 = await scheduler.scanOnce();
    expect(result1.recordsInserted).toBe(1);

    // Simulate file growing with same message (should be deduped via INSERT OR IGNORE)
    // We mock the file content to produce the same messageId
    mockedGetFileStat.mockReturnValue({ mtimeMs: Date.now() + 1000, size: 99999 });

    // Second scan with same content (same messageId)
    await scheduler.scanOnce();
    // The file will be rescanned but same messageId → INSERT OR IGNORE → 0 new
    // Note: the actual dedup happens at DB level, not scheduler level

    // Verify total in DB is still 1
    const summary = getSummary(db);
    expect(summary.totalTokens).toBe(1600); // 1000 + 500 + 100 = 1600 tokens, 1 message
  });

  it('lastScanAt 在扫描后更新', async () => {
    writeJsonlFile(jsonlFile1, [makeAssistantJsonl('msg-1')]);

    const before = scheduler.getLastScanAt();
    expect(before).toBeNull();

    await scheduler.scanOnce();

    const after = scheduler.getLastScanAt();
    expect(after).not.toBeNull();
    expect(after!).toBeLessThanOrEqual(Date.now());
    expect(after!).toBeGreaterThan(Date.now() - 5000);
  });

  it('手动触发扫描 → scanOnce 立即执行', async () => {
    writeJsonlFile(jsonlFile1, [makeAssistantJsonl('msg-manual')]);

    const result = await scheduler.scanOnce();

    expect(result.recordsInserted).toBe(1);
    expect(getScanState(db, jsonlFile1)).not.toBeNull();
  });

  it('空目录不产生错误', async () => {
    mockedGetAllScanDirs.mockReturnValue([]);

    const result = await scheduler.scanOnce();

    expect(result.recordsInserted).toBe(0);
    expect(result.filesScanned).toBe(0);
  });

  it('扫描错误不影响系统（静默降级）', async () => {
    // Make discoverJsonlFiles throw
    mockedDiscoverJsonlFiles.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    // Should not throw
    const result = await scheduler.scanOnce();
    expect(result.recordsInserted).toBe(0);
  });
});

describe('ScanScheduler — 定时器管理', () => {
  let db: Database.Database;
  let scheduler: ScanScheduler;

  beforeEach(() => {
    db = createMemoryDatabase();
    scheduler = new ScanScheduler(db, { intervalMs: 100 }); // short interval for testing
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler.stop();
    closeDatabase(db);
    vi.useRealTimers();
  });

  it('start() 启动定时器，stop() 停止定时器', () => {
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('5 分钟默认间隔', () => {
    // Create a new scheduler with default interval
    const sched = new ScanScheduler(db);
    expect(sched.getIntervalMs()).toBe(5 * 60 * 1000);
  });
});
