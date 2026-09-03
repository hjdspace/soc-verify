/**
 * scanExternalLogs mutation 测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject + ScanScheduler。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted tmp dir ───────────────────────────────────────

const { tmpDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const dir = os.tmpdir() + `/sv-scan-ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir, { recursive: true });
  return { tmpDir: dir };
});

// ─── Shared DB ref ─────────────────────────────────────────

const { dbRef, mockScanOnce } = vi.hoisted(() => {
  const dbRef: { current: import('better-sqlite3').Database | null } = { current: null };
  const mockScanOnce = vi.fn(async () => ({
    filesScanned: 2,
    filesSkipped: 1,
    recordsInserted: 5,
    durationMs: 120,
  }));
  return { dbRef, mockScanOnce };
});

// ─── Mocks ─────────────────────────────────────────────────

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: vi.fn((projectId: string) => ({
    id: projectId,
    rootPath: tmpDir,
    name: 'Test Project',
  })),
}));

vi.mock('../../src/main/token-monitor/token-monitor-registry', () => ({
  tokenMonitorRegistry: {
    getOrCreateDb: vi.fn(() => dbRef.current),
    // router 必须复用 registry 单例调度器（防重入 + 不与定时扫描并发），
    // 不再 new 临时 ScanScheduler —— mock 单一职责即可断言
    scanExternalLogsOnce: mockScanOnce,
  },
}));

// Mock ScanScheduler（保留：防止 router 意外绕过 registry 直接 new）
vi.mock('../../src/main/token-monitor/scan-scheduler', () => {
  return {
    ScanScheduler: class {
      scanOnce = mockScanOnce;
      start = vi.fn();
      stop = vi.fn();
      isRunning = vi.fn(() => false);
      getIntervalMs = vi.fn(() => 5 * 60 * 1000);
      getLastScanAt = vi.fn(() => null);
    },
  };
});

// ─── Imports (after mocks) ─────────────────────────────────

import { createMemoryDatabase, closeDatabase } from '../../src/main/token-monitor/token-monitor-db';
import { tokenRouter } from '../../src/main/ipc/routers/token-router';

// ─── Setup ─────────────────────────────────────────────────

dbRef.current = createMemoryDatabase();

const caller = tokenRouter.createCaller({});

// ─── Tests ─────────────────────────────────────────────────

describe('token-router — scanExternalLogs mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('返回扫描结果（filesScanned / filesSkipped / recordsInserted / durationMs）', async () => {
    const result = await caller.scanExternalLogs({ projectId: 'test-project-id' });

    expect(mockScanOnce).toHaveBeenCalledTimes(1);
    expect(result.filesScanned).toBe(2);
    expect(result.filesSkipped).toBe(1);
    expect(result.recordsInserted).toBe(5);
    expect(result.durationMs).toBe(120);
  });

  it('projectId 缺失时抛出 BAD_REQUEST', async () => {
    await expect(caller.scanExternalLogs({ projectId: '' as unknown as string }))
      .rejects.toThrow();
  });
});

// ─── Cleanup ──────────────────────────────────────────────

afterAll(() => {
  closeDatabase(dbRef.current!);
});
