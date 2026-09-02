// @vitest-environment jsdom
/**
 * TokenView 外部刷新按钮测试。
 *
 * 验证：
 * - TokenView 有"刷新外部日志"按钮
 * - 点击按钮触发 scanExternalLogs action
 * - Issue #5 验收标准：距上次扫描超过 1 分钟才触发即时扫描
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ─── Mock stores ──────────────────────────────────────────

const mockScanExternalLogs = vi.fn(async () => ({
  recordsInserted: 3,
  filesScanned: 2,
  filesSkipped: 1,
  durationMs: 50,
}));

/** 可变的 mock state，允许各测试用例动态修改 lastScanAt */
const mockState: { scanLoading: boolean; scanExternalLogs: typeof mockScanExternalLogs; lastScanAt: number | null } = {
  scanLoading: false,
  scanExternalLogs: mockScanExternalLogs,
  lastScanAt: null,
};

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: vi.fn(() => ({ currentProjectId: 'test-project-id' })),
}));

vi.mock('@renderer/stores/token', () => {
  const actual = vi.importActual('@renderer/stores/token');
  return {
    __esModule: true,
    ...(typeof actual === 'object' ? actual : {}),
    useTokenStore: vi.fn((selector: (state: typeof mockState) => unknown) => selector(mockState)),
  };
});

// ─── Mock panels to simplify rendering ─────────────────────

vi.mock('@renderer/components/token/TokenOverviewPanel', () => ({
  TokenOverviewPanel: () => null,
}));
vi.mock('@renderer/components/token/TokenTrendsPanel', () => ({
  TokenTrendsPanel: () => null,
}));
vi.mock('@renderer/components/token/TokenEnginePanel', () => ({
  TokenEnginePanel: () => null,
}));
vi.mock('@renderer/components/token/TokenModelPanel', () => ({
  TokenModelPanel: () => null,
}));
vi.mock('@renderer/components/token/TokenSessionPanel', () => ({
  TokenSessionPanel: () => null,
}));

// ─── Mock utils ───────────────────────────────────────────

vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// ─── Import component ─────────────────────────────────────

import { TokenView } from '@renderer/components/views/TokenView';

// ─── Tests ────────────────────────────────────────────────

describe('TokenView — 刷新外部日志', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置为默认状态：从未扫描
    mockState.scanLoading = false;
    mockState.scanExternalLogs = mockScanExternalLogs;
    mockState.lastScanAt = null;
  });

  it('显示刷新外部日志按钮', () => {
    render(<TokenView />);

    const btn = screen.getByRole('button', { name: /刷新外部日志/ });
    expect(btn).toBeDefined();
  });

  it('从未扫描过（lastScanAt=null）→ 挂载即触发扫描', async () => {
    render(<TokenView />);

    await waitFor(() => {
      expect(mockScanExternalLogs).toHaveBeenCalledTimes(1);
    });
  });

  it('距上次扫描超过 1 分钟 → 挂载触发扫描', async () => {
    mockState.lastScanAt = Date.now() - 2 * 60 * 1000; // 2 分钟前

    render(<TokenView />);

    await waitFor(() => {
      expect(mockScanExternalLogs).toHaveBeenCalledTimes(1);
    });
  });

  it('距上次扫描不足 1 分钟 → 挂载不触发扫描', async () => {
    mockState.lastScanAt = Date.now() - 30 * 1000; // 30 秒前

    render(<TokenView />);

    // 等待一下确保 useEffect 已执行但未触发扫描
    await new Promise((r) => setTimeout(r, 50));
    expect(mockScanExternalLogs).not.toHaveBeenCalled();
  });

  it('点击刷新按钮始终触发 scanExternalLogs（无论 lastScanAt）', async () => {
    mockState.lastScanAt = Date.now() - 10 * 1000; // 10 秒前（不足 1 分钟）

    render(<TokenView />);

    // useEffect 不触发扫描（距上次不足 1 分钟）
    await new Promise((r) => setTimeout(r, 50));
    expect(mockScanExternalLogs).not.toHaveBeenCalled();

    // 但手动点击刷新按钮仍然触发
    const btn = screen.getByRole('button', { name: /刷新外部日志/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockScanExternalLogs).toHaveBeenCalledTimes(1);
    });
  });
});
