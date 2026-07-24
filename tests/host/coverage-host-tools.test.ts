/**
 * AI Host Tools + cov:// URI scheme 测试（ADR 0009 / GitHub Issue #6 Slice 5）。
 *
 * 覆盖：
 * - CoverageManager.getCoverageSummary: 摘要 + worstModules（按 deficit 排序）
 * - CoverageManager.getCoverageDetail: 模块下钻
 * - get_coverage Host Tool: 返回摘要格式（非整个树）
 * - get_coverage_detail Host Tool: 返回模块详情
 * - cov:// URI: 摘要 / 模块详情 / 未覆盖项
 */

import { describe, it, expect, vi } from 'vitest';
import { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { CoverageReportGenerator } from '../../src/main/coverage/coverage-report-generator';
import { HostToolsRegistry } from '../../src/main/host/host-tools';
import { HostUriRouter } from '../../src/main/host/host-uris';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoverageData, CoverageNode, EdaToolConfig, UncoveredItem } from '@shared/types';
import { triplet, NA_TRIPLET, DEFAULT_COVERAGE_TARGETS } from '@shared/types';

// ─── 层级 mock 数据（3 层，含低于 target 的模块） ────────────────

function makeMetrics(opts: {
  line?: [number, number];
  branch?: [number, number];
  toggle?: [number, number];
  condition?: [number, number];
  fsmState?: [number, number];
  fsmTransition?: [number, number];
  functional?: [number, number];
  assertion?: [number, number];
}): CoverageNode['metrics'] {
  const t = (v?: [number, number]) => (v ? triplet(v[0], v[1]) : { ...NA_TRIPLET });
  return {
    line: t(opts.line),
    branch: t(opts.branch),
    toggle: t(opts.toggle),
    condition: t(opts.condition),
    fsm_state: t(opts.fsmState),
    fsm_transition: t(opts.fsmTransition),
    functional: t(opts.functional),
    assertion: t(opts.assertion),
  };
}

/**
 * 构造 3 层 mock CoverageData：
 *   top (line=90% < 95 target)
 *   ├── cpu_core (line=80% < 95, deficit=15)
 *   │   ├── u_alu (line=70% < 95, deficit=25 — 最差)
 *   │   └── u_reg (branch=60% < 90, deficit=30 — 最差 branch)
 *   └── memory_ctrl (toggle=75% < 85, deficit=10)
 */
function makeMockData(sessionId: string): CoverageData {
  const root: CoverageNode = {
    name: 'top',
    path: 'top',
    depth: 0,
    metrics: makeMetrics({
      line: [900, 1000],       // 90% < 95 → deficit 5
      branch: [880, 1000],     // 88% < 90 → deficit 2
      toggle: [840, 1000],     // 84% < 85 → deficit 1
      condition: [850, 1000],  // 85% = 85 → 无 deficit
      fsmState: [50, 50],      // 100% = 100 → 无 deficit
      fsmTransition: [90, 100],
      functional: [950, 1000], // 95% < 100 → deficit 5
      assertion: [910, 1000],
    }),
    children: [
      {
        name: 'cpu_core',
        path: 'top/cpu_core',
        depth: 1,
        metrics: makeMetrics({
          line: [800, 1000],       // 80% < 95 → deficit 15
          branch: [820, 1000],     // 82% < 90 → deficit 8
          toggle: [830, 1000],
          condition: [850, 1000],
          fsmState: [50, 50],
          fsmTransition: [90, 100],
          functional: [900, 1000],
          assertion: [880, 1000],
        }),
        children: [
          {
            name: 'u_alu',
            path: 'top/cpu_core/u_alu',
            depth: 2,
            metrics: makeMetrics({
              line: [700, 1000],   // 70% < 95 → deficit 25（最差）
              branch: [750, 1000],
              toggle: [800, 1000],
              condition: [820, 1000],
              functional: [880, 1000],
              assertion: [900, 1000],
            }),
            children: [],
          },
          {
            name: 'u_reg',
            path: 'top/cpu_core/u_reg',
            depth: 2,
            metrics: makeMetrics({
              line: [850, 1000],   // 85% < 95 → deficit 10
              branch: [600, 1000], // 60% < 90 → deficit 30（最差 branch）
              toggle: [820, 1000],
              condition: [840, 1000],
              functional: [890, 1000],
              assertion: [910, 1000],
            }),
            children: [],
          },
        ],
      },
      {
        name: 'memory_ctrl',
        path: 'top/memory_ctrl',
        depth: 1,
        metrics: makeMetrics({
          line: [920, 1000],
          branch: [880, 1000],
          toggle: [750, 1000],   // 75% < 85 → deficit 10
          condition: [860, 1000],
          functional: [930, 1000],
          assertion: [900, 1000],
        }),
        children: [],
      },
    ],
  };

  const uncovered: Partial<Record<string, UncoveredItem[]>> = {
    line: [
      { module: 'top/cpu_core/u_alu', file: 'alu.sv', line: 42, description: 'uncovered line in ALU' },
      { module: 'top/cpu_core/u_reg', file: 'reg.sv', line: 10, description: 'uncovered line in regfile' },
    ],
    branch: [
      { module: 'top/cpu_core/u_reg', file: 'reg.sv', line: 55, description: 'uncovered branch in regfile' },
    ],
  };

  return {
    sessionId,
    source: { covMergeDir: '/mock/cov_merge', edaTool: 'imc', reportGeneratedAt: Date.now() },
    root,
    targets: { ...DEFAULT_COVERAGE_TARGETS },
    uncovered,
  };
}

// ─── Mock 适配器 + 工具 ─────────────────────────────────────────

function createMockAdapter(data: CoverageData) {
  return {
    hasParser: () => true,
    parse: vi.fn(async (_sessionId: string, _reportDir: string) => data),
  };
}

function createMockReportGenerator(projectRoot: string): CoverageReportGenerator {
  return new CoverageReportGenerator({
    projectRoot,
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
}

const MOCK_EDA_CONFIG: EdaToolConfig = {
  tool: 'imc',
  covMergeDir: '/mock/cov_merge',
  summaryCommand: 'echo summary',
  detailCommand: 'echo detail',
  metricsCommand: 'echo metrics',
};

/** 创建带已导入 mock 数据的 CoverageManager（临时目录）。 */
async function setupManager(): Promise<{ mgr: CoverageManager; sessionId: string; cleanup: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cov-host-'));
  const adapter = createMockAdapter(makeMockData('pre-import'));
  const mgr = new CoverageManager({
    projectRoot: tmpDir,
    coverageAdapter: adapter as never,
    reportGenerator: createMockReportGenerator(tmpDir),
  });
  const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);
  return {
    mgr,
    sessionId,
    cleanup: () => rmSync(tmpDir, { recursive: true }),
  };
}

// ─── 测试 ────────────────────────────────────────────────────────

describe('CoverageManager.getCoverageSummary (ADR 0009 摘要优先)', () => {
  it('返回摘要 + worstModules（按最差 metric deficit 降序）', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageSummary(sessionId, 5);

      expect(result.sessionId).toBe(sessionId);
      // 摘要包含 8 个 metric + overall
      expect(result.summary.line).toBeCloseTo(90, 0);
      expect(result.summary.overall).toBeGreaterThan(0);

      // worstModules 按 deficit 降序
      expect(result.worstModules.length).toBe(5);
      // u_reg 的 branch deficit=30 是最大的
      expect(result.worstModules[0].name).toBe('u_reg');
      expect(result.worstModules[0].deficit).toBe(30);
      // u_alu 的 line deficit=25 是第二
      expect(result.worstModules[1].name).toBe('u_alu');
      expect(result.worstModules[1].deficit).toBe(25);

      // targets 包含默认值
      expect(result.targets.line).toBe(95);
      expect(result.targets.branch).toBe(90);
    } finally {
      cleanup();
    }
  });

  it('worstN 参数控制返回数量', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageSummary(sessionId, 2);
      expect(result.worstModules).toHaveLength(2);
      expect(result.worstModules[0].name).toBe('u_reg');
      expect(result.worstModules[1].name).toBe('u_alu');
    } finally {
      cleanup();
    }
  });

  it('worstN 缺省为 5', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageSummary(sessionId);
      // mock 树有 5 个节点（top, cpu_core, u_alu, u_reg, memory_ctrl）
      expect(result.worstModules).toHaveLength(5);
    } finally {
      cleanup();
    }
  });

  it('sessionId 缺省时使用最近 session', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageSummary();
      expect(result.sessionId).toBe(sessionId);
    } finally {
      cleanup();
    }
  });
});

describe('CoverageManager.getCoverageDetail (ADR 0009 按需下钻)', () => {
  it('返回指定模块及其直接子节点', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageDetail('top/cpu_core', sessionId);

      expect(result.sessionId).toBe(sessionId);
      expect(result.module).not.toBeNull();
      expect(result.module!.name).toBe('cpu_core');
      expect(result.module!.path).toBe('top/cpu_core');
      // 直接子节点：u_alu + u_reg
      expect(result.children).toHaveLength(2);
      expect(result.children.map((c) => c.name).sort()).toEqual(['u_alu', 'u_reg']);
      // targets 返回
      expect(result.targets.line).toBe(95);
    } finally {
      cleanup();
    }
  });

  it('返回叶子模块（无子节点）', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageDetail('top/cpu_core/u_alu', sessionId);
      expect(result.module).not.toBeNull();
      expect(result.module!.name).toBe('u_alu');
      expect(result.children).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('不存在的 module path 返回 null module', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageDetail('top/nonexistent', sessionId);
      expect(result.module).toBeNull();
      expect(result.children).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('根节点路径返回 root + 直接子节点', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const result = await mgr.getCoverageDetail('top', sessionId);
      expect(result.module!.name).toBe('top');
      expect(result.children).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

describe('get_coverage Host Tool (ADR 0009 摘要优先)', () => {
  it('注入 CoverageManager 后返回摘要格式（非整个树）', async () => {
    const { mgr, cleanup } = await setupManager();
    try {
      const hostTools = new HostToolsRegistry();
      hostTools.setCoverageManager(mgr);

      const result = await hostTools.handleToolCall({
        type: 'host_tool_call',
        id: '1',
        toolCallId: 'tc1',
        toolName: 'get_coverage',
        arguments: {},
      });

      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);

      // 摘要格式包含 summary + worstModules + targets，不包含 root
      expect(parsed.summary).toBeDefined();
      expect(parsed.summary.line).toBeCloseTo(90, 0);
      expect(parsed.worstModules).toBeDefined();
      expect(Array.isArray(parsed.worstModules)).toBe(true);
      expect(parsed.targets).toBeDefined();
      expect(parsed.targets.line).toBe(95);
      // 不应返回整个树
      expect(parsed.root).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('worstN 参数传递到 CoverageManager', async () => {
    const { mgr, cleanup } = await setupManager();
    try {
      const hostTools = new HostToolsRegistry();
      hostTools.setCoverageManager(mgr);

      const result = await hostTools.handleToolCall({
        type: 'host_tool_call',
        id: '1',
        toolCallId: 'tc1',
        toolName: 'get_coverage',
        arguments: { worstN: 2 },
      });

      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.worstModules).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('CoverageManager 为 null 时回退到旧行为（返回错误，无 adapter）', async () => {
    const hostTools = new HostToolsRegistry();
    // 不注入 coverageManager，也不注入 coverageAdapter
    const result = await hostTools.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'get_coverage',
      arguments: {},
    });

    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toContain('No coverage-parser plugin');
  });

  it('注入 CoverageManager 后 get_coverage_detail 工具自动注册', async () => {
    const { mgr, cleanup } = await setupManager();
    try {
      const hostTools = new HostToolsRegistry();
      // 默认 8 个工具，无 get_coverage_detail
      expect(hostTools.hasTool('get_coverage_detail')).toBe(false);

      hostTools.setCoverageManager(mgr);
      // 注入后注册 get_coverage_detail + get_coverage_uncovered + get_coverage_grade + get_coverage_csv
      expect(hostTools.hasTool('get_coverage_detail')).toBe(true);
      expect(hostTools.hasTool('get_coverage_uncovered')).toBe(true);
      expect(hostTools.hasTool('get_coverage_grade')).toBe(true);
      expect(hostTools.hasTool('get_coverage_csv')).toBe(true);
      // 共 12 个工具（8 默认 + 4 覆盖率分析）
      expect(hostTools.getToolNames()).toHaveLength(12);
    } finally {
      cleanup();
    }
  });
});

describe('get_coverage_detail Host Tool (ADR 0009 按需下钻)', () => {
  it('返回指定模块及其直接子节点', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const hostTools = new HostToolsRegistry();
      hostTools.setCoverageManager(mgr);

      const result = await hostTools.handleToolCall({
        type: 'host_tool_call',
        id: '1',
        toolCallId: 'tc1',
        toolName: 'get_coverage_detail',
        arguments: { module: 'top/cpu_core' },
      });

      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);

      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.module).not.toBeNull();
      expect(parsed.module.name).toBe('cpu_core');
      expect(parsed.children).toHaveLength(2);
      expect(parsed.targets.line).toBe(95);
    } finally {
      cleanup();
    }
  });

  it('不存在的模块返回 null module', async () => {
    const { mgr, cleanup } = await setupManager();
    try {
      const hostTools = new HostToolsRegistry();
      hostTools.setCoverageManager(mgr);

      const result = await hostTools.handleToolCall({
        type: 'host_tool_call',
        id: '1',
        toolCallId: 'tc1',
        toolName: 'get_coverage_detail',
        arguments: { module: 'top/nonexistent' },
      });

      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.module).toBeNull();
      expect(parsed.children).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('未注入 CoverageManager 时返回错误', async () => {
    // 先注入再取消注入，模拟 CoverageManager 不可用
    const { mgr, cleanup } = await setupManager();
    try {
      const hostTools = new HostToolsRegistry();
      hostTools.setCoverageManager(mgr);
      hostTools.setCoverageManager(null); // 取消注入

      // get_coverage_detail 应已注销
      expect(hostTools.hasTool('get_coverage_detail')).toBe(false);

      // 直接调用会返回 "not registered"
      const result = await hostTools.handleToolCall({
        type: 'host_tool_call',
        id: '1',
        toolCallId: 'tc1',
        toolName: 'get_coverage_detail',
        arguments: { module: 'top/cpu_core' },
      });

      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).toContain('not registered');
    } finally {
      cleanup();
    }
  });
});

describe('cov:// URI scheme (ADR 0009 分层 URI)', () => {
  it('cov://<sessionId> 返回摘要', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const router = new HostUriRouter();
      router.setCoverageManager(mgr);

      const result = await router.handleUriRequest({
        type: 'host_uri_request',
        id: '1',
        operation: 'read',
        url: `cov://${sessionId}`,
      });

      expect(result.isError).toBeFalsy();
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.content!);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.summary).toBeDefined();
      expect(parsed.summary.line).toBeCloseTo(90, 0);
      expect(parsed.worstModules).toBeDefined();
      expect(parsed.targets).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('cov://<sessionId>/<module> 返回模块详情', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const router = new HostUriRouter();
      router.setCoverageManager(mgr);

      const result = await router.handleUriRequest({
        type: 'host_uri_request',
        id: '1',
        operation: 'read',
        url: `cov://${sessionId}/top/cpu_core`,
      });

      expect(result.isError).toBeFalsy();
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.content!);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.module).not.toBeNull();
      expect(parsed.module.name).toBe('cpu_core');
      expect(parsed.children).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('cov://<sessionId>/<module>/uncovered 返回未覆盖项', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const router = new HostUriRouter();
      router.setCoverageManager(mgr);

      const result = await router.handleUriRequest({
        type: 'host_uri_request',
        id: '1',
        operation: 'read',
        url: `cov://${sessionId}/top/cpu_core/u_alu/uncovered`,
      });

      expect(result.isError).toBeFalsy();
      expect(result.contentType).toBe('application/json');
      const parsed = JSON.parse(result.content!);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.module).toBe('top/cpu_core/u_alu');
      expect(parsed.uncovered).toBeDefined();
      expect(Array.isArray(parsed.uncovered)).toBe(true);
      // mock 数据中 u_alu 有一条 line 未覆盖项
      const lineItems = parsed.uncovered.filter((i: { metric: string }) => i.metric === 'line');
      expect(lineItems).toHaveLength(1);
      expect(lineItems[0].description).toContain('ALU');
    } finally {
      cleanup();
    }
  });

  it('cov://<sessionId>/<module>/uncovered 返回多 metric 未覆盖项', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const router = new HostUriRouter();
      router.setCoverageManager(mgr);

      // u_reg 有 line 和 branch 两种未覆盖项
      const result = await router.handleUriRequest({
        type: 'host_uri_request',
        id: '1',
        operation: 'read',
        url: `cov://${sessionId}/top/cpu_core/u_reg/uncovered`,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content!);
      expect(parsed.uncovered).toHaveLength(2);
      const metrics = parsed.uncovered.map((i: { metric: string }) => i.metric).sort();
      expect(metrics).toEqual(['branch', 'line']);
    } finally {
      cleanup();
    }
  });

  it('cov:// write 被拒绝（read-only）', async () => {
    const { mgr, cleanup } = await setupManager();
    try {
      const router = new HostUriRouter();
      router.setCoverageManager(mgr);

      const result = await router.handleUriRequest({
        type: 'host_uri_request',
        id: '1',
        operation: 'write',
        url: 'cov://session_1',
        content: 'data',
      });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('read-only');
    } finally {
      cleanup();
    }
  });

  it('CoverageManager 未注入时返回空 JSON（向后兼容）', async () => {
    const router = new HostUriRouter();
    const result = await router.handleUriRequest({
      type: 'host_uri_request',
      id: '1',
      operation: 'read',
      url: 'cov://session_1',
    });

    expect(result.isError).toBeFalsy();
    expect(result.contentType).toBe('application/json');
    expect(result.content).toBe('{}');
  });

  it('深层模块路径 cov://<sessionId>/top/cpu_core/u_alu 返回叶子模块', async () => {
    const { mgr, sessionId, cleanup } = await setupManager();
    try {
      const router = new HostUriRouter();
      router.setCoverageManager(mgr);

      const result = await router.handleUriRequest({
        type: 'host_uri_request',
        id: '1',
        operation: 'read',
        url: `cov://${sessionId}/top/cpu_core/u_alu`,
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content!);
      expect(parsed.module.name).toBe('u_alu');
      expect(parsed.children).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
