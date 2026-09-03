/**
 * GUI 卡顿修复回归测试 — scanOnce 异步流式 + 防重入。
 *
 * 背景（2026-09 性能修复）：Token 视图首开触发 scanExternalLogs 时，
 * 旧实现全同步跑在 Electron 主进程：readFileSync 全量读 + 每条记录
 * COUNT(*)×2 + 无事务逐条 INSERT，305MB 日志下阻塞事件循环 18s+，
 * 主进程 IPC/tRPC 全冻结 → GUI 卡顿十几秒。
 *
 * 本文件锁定修复后的行为契约：
 * 1. scanOnce 是非阻塞的 —— 长扫描期间事件循环持续流转
 * 2. 增量偏移正确 —— 只解析新字节，含多字节 UTF-8 字符的文件
 * 3. 防重入 —— 并发调用复用同一 Promise，不叠加扫描
 * 4. 尾部不完整行跳过 —— 只统计到已落盘的完整行
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import {
  createMemoryDatabase,
  closeDatabase,
  getScanState,
} from '../../src/main/token-monitor/token-monitor-db';

vi.mock('../../src/main/token-monitor/log-scanner-paths', async (importOriginal) => {
  // 只 mock getAllScanDirs / getFileStat / 同步枚举；流式枚举与行边界
  // 偏移用真实实现（回归测试的目的就是验证它们）
  const actual = await importOriginal<typeof import('../../src/main/token-monitor/log-scanner-paths')>();
  return {
    ...actual,
    getAllScanDirs: vi.fn(() => [] as { engine: 'claude-code' | 'codex'; dir: string }[]),
    discoverJsonlFiles: vi.fn(() => [] as string[]),
    getFileStat: vi.fn(() => null),
  };
});

import { ScanScheduler } from '../../src/main/token-monitor/scan-scheduler';
import { parseClaudeJsonlFileStream } from '../../src/main/token-monitor/claude-log-parser';
import {
  getAllScanDirs,
  getFileStat,
} from '../../src/main/token-monitor/log-scanner-paths';

const mockedGetAllScanDirs = vi.mocked(getAllScanDirs);
const mockedGetFileStat = vi.mocked(getFileStat);

const testDir = join(tmpdir(), `sv-scan-async-${Date.now()}`);

function writeJsonlFile(filePath: string, lines: string[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, lines.join('\n') + '\n');
}

function makeAssistantJsonl(messageId: string, tokens: number = 1000): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-async-test',
    message: {
      role: 'assistant',
      id: messageId,
      model: 'claude-sonnet-4',
      usage: { input_tokens: tokens, output_tokens: 500 },
    },
  });
}

describe('scanOnce — 事件循环不阻塞', () => {
  let db: Database.Database;
  let scheduler: ScanScheduler;
  const jsonlFile = join(testDir, 'sessions', 'sess-async.jsonl');

  beforeEach(() => {
    mkdirSync(join(testDir, 'sessions'), { recursive: true });
    db = createMemoryDatabase();
    scheduler = new ScanScheduler(db);
    vi.clearAllMocks();

    mockedGetAllScanDirs.mockReturnValue([
      { engine: 'claude-code', dir: join(testDir, 'sessions') },
    ]);
    mockedGetFileStat.mockImplementation((filePath: string) => {
      try {
        const { statSync } = require('node:fs') as typeof import('node:fs');
        return statSync(filePath);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('扫描大量文件期间事件循环持续流转（最长阻塞 < 500ms）', async () => {
    // 生成足够大的文件让扫描耗时 > 1s，期间用高频定时器采样事件循环阻塞
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sess-async-test',
          message: {
            role: 'assistant',
            id: `msg-${i}`,
            model: 'claude-sonnet-4',
            content: [{ type: 'text', text: 'x'.repeat(2000) }],
            usage: { input_tokens: 1000, output_tokens: 300 },
          },
        }),
      );
    }
    writeJsonlFile(jsonlFile, lines);

    const SAMPLE_MS = 5;
    let longestBlockMs = 0;
    let last = Date.now();
    let ticks = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      const blocked = now - last - SAMPLE_MS;
      if (blocked > longestBlockMs) longestBlockMs = blocked;
      last = now;
      ticks++;
    }, SAMPLE_MS);

    try {
      const result = await scheduler.scanOnce();
      expect(result.recordsInserted).toBe(3000);

      // 事件循环必须在扫描期间流转（采样器活着 = 没有被饿死）
      expect(ticks).toBeGreaterThan(0);
      // 500ms 是用户感知卡顿的公认门槛（Electron IPC 响应阈值远低于此）
      expect(longestBlockMs).toBeLessThan(500);
    } finally {
      clearInterval(timer);
    }
  });

  it('并发调用 scanOnce 复用同一次扫描（防重入）', async () => {
    writeJsonlFile(jsonlFile, [makeAssistantJsonl('msg-1'), makeAssistantJsonl('msg-2')]);

    const p1 = scheduler.scanOnce();
    const p2 = scheduler.scanOnce();
    // 同一轮事件循环内的并发调用拿到同一个 Promise
    expect(p2).toBe(p1);

    const [r1, r2] = await Promise.all([p1, p2]);
    // 每条记录只插入一次（并发调用没有叠加扫描）
    expect(r1.recordsInserted).toBe(2);
    expect(r2).toBe(r1);
    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM token_usage').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(2);
  });

  it('增量扫描：文件追加新行后只解析新增部分', async () => {
    writeJsonlFile(jsonlFile, [makeAssistantJsonl('msg-1')]);
    await scheduler.scanOnce();

    const stateAfterFirst = getScanState(db, jsonlFile)!;
    // writeJsonlFile 以 \n 结尾 → 全部是完整行，偏移推进到行边界
    expect(stateAfterFirst.byteOffset).toBe(
      require('node:fs').statSync(jsonlFile).size,
    );

    // 追加新行（文件增长）
    appendFileSync(jsonlFile, makeAssistantJsonl('msg-appended') + '\n');

    const result2 = await scheduler.scanOnce();
    // 只插入新追加的 1 条
    expect(result2.recordsInserted).toBe(1);

    const rows = db
      .prepare('SELECT message_id FROM token_usage ORDER BY id')
      .all() as Array<{ message_id: string }>;
    expect(rows.map((r) => r.message_id)).toEqual(['msg-1', 'msg-appended']);
  });

  it('尾部半行不写完不丢失：偏移停在行边界，写完后再扫描补齐', async () => {
    const fullLine = makeAssistantJsonl('msg-writing');
    const halfLine = fullLine.slice(0, 40);

    // 完整行 + 一条写了一半的行（无换行符 —— writer 正在写入）
    writeFileSync(jsonlFile, makeAssistantJsonl('msg-done') + '\n' + halfLine);
    await scheduler.scanOnce();

    // 偏移必须停在最后一个 \n 之后，把半行留给下次
    const state = getScanState(db, jsonlFile)!;
    const sizeBefore = require('node:fs').statSync(jsonlFile).size;
    expect(state.byteOffset).toBeLessThan(sizeBefore);

    // 半行写完（补上剩余字节 + 换行符）
    appendFileSync(jsonlFile, fullLine.slice(40) + '\n');
    await scheduler.scanOnce();

    // 写完的行被完整解析 —— 不丢记录
    const rows = db
      .prepare('SELECT message_id FROM token_usage ORDER BY id')
      .all() as Array<{ message_id: string }>;
    expect(rows.map((r) => r.message_id)).toEqual(['msg-done', 'msg-writing']);
  });
});

describe('parseClaudeJsonlFileStream — 流式增量正确性', () => {
  const multibyteFile = join(testDir, 'mb', 'sess-mb.jsonl');

  beforeEach(() => {
    mkdirSync(join(testDir, 'mb'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('多字节 UTF-8 内容从字节偏移续读不丢失记录', async () => {
    // 行内含中文/emoji，字节偏移落在多字节字符中间也不能产生错乱数据
    const line1 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-mb',
      message: {
        role: 'assistant',
        id: 'msg-mb-1',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      cwd: '/proj/中文目录/验证环境',
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-mb',
      message: {
        role: 'assistant',
        id: 'msg-mb-2',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 200, output_tokens: 60 },
      },
      cwd: '/proj/emoji-🚀-dir',
    });
    const line3 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-mb',
      message: {
        role: 'assistant',
        id: 'msg-mb-3',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 300, output_tokens: 70 },
      },
    });
    writeFileSync(multibyteFile, line1 + '\n' + line2 + '\n' + line3 + '\n');

    // 全量流式解析
    const all = await parseClaudeJsonlFileStream(multibyteFile, 0);
    expect(all.map((r) => r.messageId)).toEqual(['msg-mb-1', 'msg-mb-2', 'msg-mb-3']);
    expect(all[0].cwd).toBe('/proj/中文目录/验证环境');
    expect(all[1].cwd).toBe('/proj/emoji-🚀-dir');

    // 从第一行末尾的换行符偏移续读（合法边界）→ 只解析后两行
    const offsetAfterLine1 = Buffer.byteLength(line1 + '\n', 'utf8');
    const rest = await parseClaudeJsonlFileStream(multibyteFile, offsetAfterLine1);
    expect(rest.map((r) => r.messageId)).toEqual(['msg-mb-2', 'msg-mb-3']);

    // 落在多字节字符中间的"脏"偏移 → 不崩溃，从下一个可解析行恢复
    // （scanner 保存的偏移量总是行边界，这里只验证鲁棒性）
    const dirtyOffset = offsetAfterLine1 + 3;
    const dirty = await parseClaudeJsonlFileStream(multibyteFile, dirtyOffset);
    // msg-mb-2 行首被截断 → 该行 JSON 解析失败被跳过，msg-mb-3 完整恢复
    expect(dirty.some((r) => r.messageId === 'msg-mb-3')).toBe(true);
  });

  it('尾部不完整行（无换行结尾）不产生记录', async () => {
    const full = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-mb',
      message: {
        role: 'assistant',
        id: 'msg-tail',
        model: 'claude-sonnet-4',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    // 只写半行（模拟 writer 正在写入时扫描）
    writeFileSync(multibyteFile, full.slice(0, Math.floor(full.length / 2)));

    const records = await parseClaudeJsonlFileStream(multibyteFile, 0);
    expect(records).toEqual([]);
  });
});
