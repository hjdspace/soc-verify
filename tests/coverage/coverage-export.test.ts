/**
 * 覆盖率导出集成测试（Slice 7 / Issue #9）。
 *
 * 端到端验证导出流水线：CoverageManager（mock 适配器）→ coverage-exporter 生成内容
 * → node:fs/promises writeFile 写盘 → 读回校验。
 *
 * 这条链路正是 coverage-router.exportReport procedure 内部编排的逻辑，
 * 此处用真实的 CoverageManager + 真实文件 IO 完成端到端覆盖，避免在测试中
 * 引入 electron BrowserWindow / credential-manager 等重 mock。
 *
 * 覆盖范围：
 *   - scope=current：导出 HTML / JSON 文件
 *   - scope=compare：导出对比 HTML / JSON 文件
 *   - resolveExportScope 范围校验
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoverageData, CoverageNode, EdaToolConfig } from '@shared/types';
import { triplet, NA_TRIPLET, DEFAULT_COVERAGE_TARGETS, summarizeCoverage, calculateDelta } from '@shared/types';
import { CoverageManager } from '../../src/main/coverage/coverage-manager';
import { CoverageReportGenerator } from '../../src/main/coverage/coverage-report-generator';
import {
  generateHtmlReport,
  generateJsonExport,
  generateDeltaHtmlReport,
  generateCompareJsonExport,
  resolveExportScope,
} from '../../src/main/coverage/coverage-exporter';

// ─── mock 数据 ────────────────────────────────────────────────────

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

/** 生成 mock CoverageData；可通过 linePct 调整 line 覆盖率以制造 delta。 */
function makeMockData(sessionId: string, linePct: [number, number] = [902, 1000]): CoverageData {
  const root: CoverageNode = {
    name: 'top',
    path: 'top',
    depth: 0,
    metrics: makeMetrics({
      line: linePct,
      branch: [850, 1000],
      toggle: [821, 1000],
      condition: [800, 1000],
      fsmState: [50, 50],
      fsmTransition: [90, 100],
      functional: [880, 1000],
      assertion: [817, 1000],
    }),
    children: [
      {
        name: 'cpu_core',
        path: 'top/cpu_core',
        depth: 1,
        metrics: makeMetrics({
          line: [920, 1000],
          branch: [870, 1000],
          toggle: [850, 1000],
          condition: [820, 1000],
          fsmState: [50, 50],
          fsmTransition: [90, 100],
          functional: [900, 1000],
          assertion: [800, 1000],
        }),
        children: [],
      },
    ],
  };
  return {
    sessionId,
    source: { covMergeDir: '/mock/cov_merge', edaTool: 'imc', reportGeneratedAt: 1700000000000 },
    root,
    targets: { ...DEFAULT_COVERAGE_TARGETS },
  };
}

function createMockAdapter(data: CoverageData) {
  return {
    hasParser: () => true,
    parse: async () => data,
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

// ─── 测试夹具：复刻 router.exportReport 的编排逻辑 ──────────────────

/**
 * 模拟 coverage-router.exportReport mutation 的核心编排：
 *   1. CoverageManager.getTree 取 CoverageData
 *   2. coverage-exporter 生成内容
 *   3. fs/promises writeFile 写盘
 * 这样集成测试与 router 行为一致，且不依赖 electron 运行时。
 */
async function exportCurrent(
  mgr: CoverageManager,
  sessionId: string | undefined,
  format: 'html' | 'json',
  outputPath: string,
): Promise<void> {
  const data = await mgr.getTree(sessionId);
  const content = format === 'html' ? generateHtmlReport(data) : generateJsonExport(data);
  await writeFile(outputPath, content, 'utf-8');
}

async function exportCompare(
  mgr: CoverageManager,
  sessionIdBefore: string,
  sessionIdAfter: string,
  format: 'html' | 'json',
  outputPath: string,
): Promise<void> {
  const before = await mgr.getTree(sessionIdBefore);
  const after = await mgr.getTree(sessionIdAfter);
  const deltas = calculateDelta(summarizeCoverage(before.root), summarizeCoverage(after.root));
  const content = format === 'html'
    ? generateDeltaHtmlReport(before, after, deltas)
    : generateCompareJsonExport(before, after, deltas);
  await writeFile(outputPath, content, 'utf-8');
}

// ─── 测试用例 ─────────────────────────────────────────────────────

describe('覆盖率导出集成测试', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cov-export-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('端到端导出当前 session 的 HTML 文件，内容可读且包含关键结构', async () => {
    const adapter = createMockAdapter(makeMockData('pre-import'));
    const mgr = new CoverageManager({
      projectRoot: tmpDir,
      coverageAdapter: adapter as never,
      reportGenerator: createMockReportGenerator(tmpDir),
    });
    const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    const outPath = join(tmpDir, 'report.html');
    await exportCurrent(mgr, sessionId, 'html', outPath);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toMatch(/^<!DOCTYPE html>/);
    expect(content).toContain('<html');
    expect(content).toContain(sessionId);
    expect(content).toContain('<style>');
    // 树表格包含 root 模块
    expect(content).toContain('top');
    expect(content).toContain('cpu_core');
  });

  it('端到端导出当前 session 的 JSON 文件，JSON 可解析且含 root 树', async () => {
    const adapter = createMockAdapter(makeMockData('pre-import'));
    const mgr = new CoverageManager({
      projectRoot: tmpDir,
      coverageAdapter: adapter as never,
      reportGenerator: createMockReportGenerator(tmpDir),
    });
    const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    const outPath = join(tmpDir, 'report.json');
    await exportCurrent(mgr, sessionId, 'json', outPath);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf-8');
    const obj = JSON.parse(content) as { sessionId: string; root: CoverageNode; gaps: unknown[] };
    expect(obj.sessionId).toBe(sessionId);
    expect(obj.root.name).toBe('top');
    expect(obj.root.children).toHaveLength(1);
    expect(Array.isArray(obj.gaps)).toBe(true);
  });

  it('exportCurrent 在 sessionId 缺省时回退到最近 session 并成功导出', async () => {
    const adapter = createMockAdapter(makeMockData('pre-import'));
    const mgr = new CoverageManager({
      projectRoot: tmpDir,
      coverageAdapter: adapter as never,
      reportGenerator: createMockReportGenerator(tmpDir),
    });
    await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    const outPath = join(tmpDir, 'fallback.html');
    await exportCurrent(mgr, undefined, 'html', outPath);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf-8')).toContain('<html');
  });

  it('端到端导出对比 HTML：两个 session 之间生成 delta 对比报告', async () => {
    // 先导入 before（line 90.2%）
    const beforeAdapter = createMockAdapter(makeMockData('before', [902, 1000]));
    const mgr = new CoverageManager({
      projectRoot: tmpDir,
      coverageAdapter: beforeAdapter as never,
      reportGenerator: createMockReportGenerator(tmpDir),
    });
    const { sessionId: beforeId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    // 再导入 after（line 95%），通过替换 adapter 返回不同数据
    const afterData = makeMockData('after', [950, 1000]);
    mgr.setAdapter(createMockAdapter(afterData) as never);
    const { sessionId: afterId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    expect(beforeId).not.toBe(afterId);

    const outPath = join(tmpDir, 'compare.html');
    await exportCompare(mgr, beforeId, afterId, 'html', outPath);

    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf-8');
    expect(content).toMatch(/^<!DOCTYPE html>/);
    expect(content).toContain(beforeId);
    expect(content).toContain(afterId);
    expect(content).toContain('Before');
    expect(content).toContain('After');
    expect(content).toContain('delta-table');
  });

  it('端到端导出对比 JSON：含 before/after/delta 结构', async () => {
    const beforeAdapter = createMockAdapter(makeMockData('before', [902, 1000]));
    const mgr = new CoverageManager({
      projectRoot: tmpDir,
      coverageAdapter: beforeAdapter as never,
      reportGenerator: createMockReportGenerator(tmpDir),
    });
    const { sessionId: beforeId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    const afterData = makeMockData('after', [950, 1000]);
    mgr.setAdapter(createMockAdapter(afterData) as never);
    const { sessionId: afterId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    const outPath = join(tmpDir, 'compare.json');
    await exportCompare(mgr, beforeId, afterId, 'json', outPath);

    expect(existsSync(outPath)).toBe(true);
    const obj = JSON.parse(readFileSync(outPath, 'utf-8')) as {
      scope: string;
      before: { sessionId: string };
      after: { sessionId: string };
      delta: Array<{ metric: string; delta: number }>;
    };
    expect(obj.scope).toBe('compare');
    expect(obj.before.sessionId).toBe(beforeId);
    expect(obj.after.sessionId).toBe(afterId);
    expect(obj.delta.length).toBeGreaterThan(0);
    // line 应有正 delta（95 - 90.2 = 4.8）
    const lineDelta = obj.delta.find((d) => d.metric === 'line');
    expect(lineDelta).toBeDefined();
    expect(lineDelta!.delta).toBeGreaterThan(0);
  });

  it('resolveExportScope 集成：compare 缺少 compareSessionId 时抛错', () => {
    expect(() =>
      resolveExportScope({ scope: 'compare', sessionId: 's1' }),
    ).toThrow();
  });

  it('导出的 HTML 文件可被重复读取且字节稳定（幂等）', async () => {
    const adapter = createMockAdapter(makeMockData('stable'));
    const mgr = new CoverageManager({
      projectRoot: tmpDir,
      coverageAdapter: adapter as never,
      reportGenerator: createMockReportGenerator(tmpDir),
    });
    const { sessionId } = await mgr.importCoverage('/mock/cov_merge', MOCK_EDA_CONFIG);

    const out1 = join(tmpDir, 'a.html');
    const out2 = join(tmpDir, 'b.html');
    await exportCurrent(mgr, sessionId, 'html', out1);
    await exportCurrent(mgr, sessionId, 'html', out2);

    // 两份 HTML 主体结构一致（footer 含时间戳会不同，故比较前缀稳定性）
    const c1 = readFileSync(out1, 'utf-8');
    const c2 = readFileSync(out2, 'utf-8');
    expect(c1.slice(0, 500)).toBe(c2.slice(0, 500));
    expect(c1).toContain('<html');
  });
});
