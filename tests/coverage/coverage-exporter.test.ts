/**
 * coverage-exporter 单元测试（Slice 7 / Issue #9）。
 *
 * 覆盖三类纯函数：
 *   - generateHtmlReport：HTML 结构、8 metric 卡片、树表格行、未覆盖项、内联 CSS、颜色 class
 *   - generateJsonExport：JSON 可解析、含 root 树、8 metric、gaps/delta（传入时）
 *   - resolveExportScope：current / compare 范围选择校验逻辑
 *
 * 另外覆盖 delta HTML 报告与 compare JSON 导出，确保对比范围输出正确。
 */
import { describe, it, expect } from 'vitest';
import type { CoverageData, CoverageNode, CoverageMetric, UncoveredItem } from '@shared/types';
import { triplet, NA_TRIPLET, DEFAULT_COVERAGE_TARGETS, COVERAGE_METRICS } from '@shared/types';
import {
  generateHtmlReport,
  generateJsonExport,
  generateDeltaHtmlReport,
  generateCompareJsonExport,
  resolveExportScope,
} from '../../src/main/coverage/coverage-exporter';

// ─── 层级 mock 数据 ────────────────────────────────────────────────

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

function makeMockData(sessionId: string, withUncovered = false): CoverageData {
  const root: CoverageNode = {
    name: 'top',
    path: 'top',
    depth: 0,
    metrics: makeMetrics({
      line: [902, 1000], // 90.2% → 低于 line 目标 95 → warn (95-5=90, 90.2>=90) → 实际 90.2>=95? 否; >=90? 是 → warn
      branch: [850, 1000], // 85% → branch 目标 90 → 85>=90? 否; >=85? 是 → warn
      toggle: [821, 1000], // 82.1% → toggle 目标 85 → 82.1>=85? 否; >=80? 是 → fail(<85-5=80? 82.1>=80 → warn)
      condition: [800, 1000], // 80% → condition 目标 85 → 80>=85? 否; >=80? 是 → warn
      fsmState: [50, 50], // 100% → pass
      fsmTransition: [90, 100], // 90% → 目标 90 → pass
      functional: [880, 1000], // 88% → functional 目标 100 → 88>=100? 否; >=95? 否 → fail
      assertion: [817, 1000], // 81.7% → 无目标 → 81.7>=90? 否; >=80? 是 → warn
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
      {
        name: 'memory_ctrl',
        path: 'top/memory_ctrl',
        depth: 1,
        metrics: makeMetrics({
          line: [880, 1000],
          branch: [830, 1000],
          toggle: [790, 1000],
          condition: [780, 1000],
          functional: [860, 1000],
          assertion: [830, 1000],
        }),
        children: [],
      },
    ],
  };

  const data: CoverageData = {
    sessionId,
    source: { covMergeDir: '/mock/cov_merge', edaTool: 'imc', reportGeneratedAt: 1700000000000 },
    root,
    targets: { ...DEFAULT_COVERAGE_TARGETS },
  };

  if (withUncovered) {
    const items: UncoveredItem[] = [
      { module: 'memory_ctrl', file: 'mem.sv', line: 42, description: '未命中分支' },
      { module: 'cpu_core', signal: 'state[1:0]', description: 'FSM 状态未覆盖' },
    ];
    data.uncovered = { line: [items[0]], fsm_state: [items[1]] };
  }

  return data;
}

// ─── generateHtmlReport ───────────────────────────────────────────

describe('generateHtmlReport', () => {
  it('生成包含 <html> 标签的独立 HTML 文档', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('CSS 内联在 <style> 标签中，不依赖外部资源', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    expect(html).toContain('<style>');
    expect(html).toContain('</style>');
    // 不应引用外部 stylesheet
    expect(html).not.toMatch(/<link[^>]*stylesheet/i);
  });

  it('包含 8 个 metric 概览卡片', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    // 每个卡片都有一个 ov-card div（overall 卡使用 ov-overall，不计入）
    const cardCount = (html.match(/class="ov-card"/g) ?? []).length;
    expect(cardCount).toBe(COVERAGE_METRICS.length);
    // overall 卡片也存在（8 项均值）
    expect(html).toContain('ov-overall');
  });

  it('包含树表格行（root + 2 个子节点 = 3 行）', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    const row_count = (tbodyMatch![1].match(/<tr\b/g) ?? []).length;
    expect(row_count).toBe(3); // top + cpu_core + memory_ctrl
    expect(html).toContain('top');
    expect(html).toContain('cpu_core');
    expect(html).toContain('memory_ctrl');
  });

  it('未覆盖项区域存在，传入 uncovered 时渲染具体项', () => {
    const html = generateHtmlReport(makeMockData('s1', true));
    expect(html).toContain('未覆盖项');
    expect(html).toContain('memory_ctrl');
    expect(html).toContain('mem.sv');
    expect(html).toContain('state[1:0]');
  });

  it('未传入 uncovered 时显示空状态', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    expect(html).toContain('未覆盖项');
    // 空状态文案
    expect(html).toMatch(/暂无未覆盖项数据|全部覆盖/);
  });

  it('颜色 class 正确：pass/warn/fail/na 均按 classify 逻辑生成', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    // fsm_state 100% → pass
    expect(html).toContain('pass');
    // functional 88% < 100 目标 → fail
    expect(html).toContain('fail');
    // line 90.2% → warn（90.2 >= 95-5=90）
    expect(html).toContain('warn');
    // N/A 情况：memory_ctrl 的 fsm_state/toggle 缺失 → na
    expect(html).toContain('na');
  });

  it('自定义 title 出现在 <title> 和 <h1> 中', () => {
    const html = generateHtmlReport(makeMockData('s1'), { title: '我的报告' });
    expect(html).toContain('<title>我的报告</title>');
    expect(html).toContain('<h1>我的报告</h1>');
  });

  it('包含展开/折叠用的内联脚本', () => {
    const html = generateHtmlReport(makeMockData('s1'));
    expect(html).toContain('<script>');
    expect(html).toContain('function toggle');
    expect(html).toContain('expandAll');
    expect(html).toContain('collapseAll');
  });

  it('HTML 转义模块名中的特殊字符，防止结构破坏', () => {
    const data = makeMockData('s1');
    data.root.children[0].name = '<script>x</script>';
    data.root.children[0].path = 'top/<script>';
    const html = generateHtmlReport(data);
    expect(html).not.toContain('<script>x</script></td>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ─── generateJsonExport ───────────────────────────────────────────

describe('generateJsonExport', () => {
  it('生成可解析的 JSON 字符串', () => {
    const str = generateJsonExport(makeMockData('s1'));
    expect(() => JSON.parse(str)).not.toThrow();
  });

  it('包含 root 覆盖率树（带 name/path/depth/metrics/children）', () => {
    const str = generateJsonExport(makeMockData('s1'));
    const obj = JSON.parse(str) as { root: CoverageNode };
    expect(obj.root.name).toBe('top');
    expect(obj.root.path).toBe('top');
    expect(obj.root.depth).toBe(0);
    expect(obj.root.children).toHaveLength(2);
  });

  it('包含全部 8 个 metric 的 triplet', () => {
    const str = generateJsonExport(makeMockData('s1'));
    const obj = JSON.parse(str) as { root: CoverageNode };
    for (const m of COVERAGE_METRICS) {
      expect(obj.root.metrics[m]).toBeDefined();
      expect(obj.root.metrics[m]).toHaveProperty('percentage');
      expect(obj.root.metrics[m]).toHaveProperty('covered');
      expect(obj.root.metrics[m]).toHaveProperty('total');
    }
  });

  it('包含 targets（默认 + session 级合并）', () => {
    const str = generateJsonExport(makeMockData('s1'));
    const obj = JSON.parse(str) as { targets: Partial<Record<CoverageMetric, number>> };
    expect(obj.targets.line).toBe(DEFAULT_COVERAGE_TARGETS.line);
    expect(obj.targets.fsm_state).toBe(DEFAULT_COVERAGE_TARGETS.fsm_state);
  });

  it('默认计算并包含 gaps（未传入 extras 时自动 detectGaps）', () => {
    const str = generateJsonExport(makeMockData('s1'));
    const obj = JSON.parse(str) as { gaps: Array<{ metric: CoverageMetric }> };
    expect(Array.isArray(obj.gaps)).toBe(true);
    expect(obj.gaps.length).toBeGreaterThan(0);
    // functional 88% < 100 目标 → 应有 functional gap
    const hasFunctionalGap = obj.gaps.some((g) => g.metric === 'functional');
    expect(hasFunctionalGap).toBe(true);
  });

  it('传入 extras.gaps 时使用传入值', () => {
    const data = makeMockData('s1');
    const customGaps = [
      { nodePath: 'top', nodeName: 'top', metric: 'line' as CoverageMetric, target: 95, actual: 90.2, deficit: 4.8 },
    ];
    const str = generateJsonExport(data, { gaps: customGaps });
    const obj = JSON.parse(str) as { gaps: Array<{ nodePath: string }> };
    expect(obj.gaps).toHaveLength(1);
    expect(obj.gaps[0].nodePath).toBe('top');
  });

  it('传入 extras.delta 时包含 delta 数组', () => {
    const data = makeMockData('s1');
    const delta = [
      { metric: 'line' as CoverageMetric, before: 80, after: 90.2, delta: 10.2 },
    ];
    const str = generateJsonExport(data, { delta });
    const obj = JSON.parse(str) as { delta: Array<{ metric: CoverageMetric; delta: number }> };
    expect(obj.delta).toHaveLength(1);
    expect(obj.delta[0].delta).toBe(10.2);
  });

  it('未传入 delta 时 delta 为空数组', () => {
    const str = generateJsonExport(makeMockData('s1'));
    const obj = JSON.parse(str) as { delta: unknown[] };
    expect(Array.isArray(obj.delta)).toBe(true);
    expect(obj.delta).toHaveLength(0);
  });

  it('包含 sessionId 与 source 元信息', () => {
    const str = generateJsonExport(makeMockData('s1'));
    const obj = JSON.parse(str) as { sessionId: string; source: { edaTool: string } };
    expect(obj.sessionId).toBe('s1');
    expect(obj.source.edaTool).toBe('imc');
  });
});

// ─── resolveExportScope ───────────────────────────────────────────

describe('resolveExportScope', () => {
  it('scope=current 时 sessionId 可缺省', () => {
    const result = resolveExportScope({ scope: 'current' });
    expect(result.scope).toBe('current');
    expect(result.sessionId).toBeUndefined();
    expect(result.compareSessionId).toBeUndefined();
  });

  it('scope=current 时也可携带 sessionId', () => {
    const result = resolveExportScope({ scope: 'current', sessionId: 's1' });
    expect(result.scope).toBe('current');
    expect(result.sessionId).toBe('s1');
    expect(result.compareSessionId).toBeUndefined();
  });

  it('scope=compare 时 sessionId 与 compareSessionId 均必填', () => {
    expect(() => resolveExportScope({ scope: 'compare' })).toThrow();
    expect(() => resolveExportScope({ scope: 'compare', sessionId: 's1' })).toThrow();
    expect(() => resolveExportScope({ scope: 'compare', compareSessionId: 's2' })).toThrow();
  });

  it('scope=compare 时 sessionId 与 compareSessionId 不能相同', () => {
    expect(() =>
      resolveExportScope({ scope: 'compare', sessionId: 's1', compareSessionId: 's1' }),
    ).toThrow();
  });

  it('scope=compare 参数合法时返回归一化结果', () => {
    const result = resolveExportScope({
      scope: 'compare',
      sessionId: 's1',
      compareSessionId: 's2',
    });
    expect(result).toEqual({ scope: 'compare', sessionId: 's1', compareSessionId: 's2' });
  });
});

// ─── generateDeltaHtmlReport ──────────────────────────────────────

describe('generateDeltaHtmlReport', () => {
  it('生成包含 before/after session 的对比 HTML', () => {
    const before = makeMockData('s1');
    const after = makeMockData('s2');
    // 改 after 的 line 覆盖率以制造 delta
    after.root.metrics.line = triplet(950, 1000);
    const delta = [
      { metric: 'line' as CoverageMetric, before: 90.2, after: 95, delta: 4.8 },
    ];
    const html = generateDeltaHtmlReport(before, after, delta);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('s1');
    expect(html).toContain('s2');
    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).toContain('Delta');
  });

  it('delta 表格包含 8 个 metric 行 + overall 行', () => {
    const before = makeMockData('s1');
    const after = makeMockData('s2');
    const delta = COVERAGE_METRICS.map((m) => ({
      metric: m,
      before: 80,
      after: 85,
      delta: 5,
    }));
    const html = generateDeltaHtmlReport(before, after, delta);
    // delta-table 内的行数 = 8 metric + 1 overall
    const tbodyMatch = html.match(/<table class="delta-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    const rowCount = (tbodyMatch![1].match(/<tr\b/g) ?? []).length;
    expect(rowCount).toBe(COVERAGE_METRICS.length + 1);
  });

  it('正 delta 使用 delta-up class，负 delta 使用 delta-down class', () => {
    const before = makeMockData('s1');
    const after = makeMockData('s2');
    const delta = [
      { metric: 'line' as CoverageMetric, before: 80, after: 90, delta: 10 },
      { metric: 'branch' as CoverageMetric, before: 90, after: 85, delta: -5 },
    ];
    const html = generateDeltaHtmlReport(before, after, delta);
    expect(html).toContain('delta-up');
    expect(html).toContain('delta-down');
  });
});

// ─── generateCompareJsonExport ────────────────────────────────────

describe('generateCompareJsonExport', () => {
  it('生成可解析的 compare JSON，含 before/after/delta', () => {
    const before = makeMockData('s1');
    const after = makeMockData('s2');
    const delta = [{ metric: 'line' as CoverageMetric, before: 90.2, after: 95, delta: 4.8 }];
    const str = generateCompareJsonExport(before, after, delta);
    expect(() => JSON.parse(str)).not.toThrow();
    const obj = JSON.parse(str) as {
      scope: string;
      before: { sessionId: string; root: CoverageNode };
      after: { sessionId: string; root: CoverageNode };
      delta: Array<{ metric: CoverageMetric }>;
    };
    expect(obj.scope).toBe('compare');
    expect(obj.before.sessionId).toBe('s1');
    expect(obj.after.sessionId).toBe('s2');
    expect(obj.before.root.name).toBe('top');
    expect(obj.after.root.name).toBe('top');
    expect(obj.delta).toHaveLength(1);
  });

  it('before/after 各自包含独立的 gaps（自动 detectGaps）', () => {
    const before = makeMockData('s1');
    const after = makeMockData('s2');
    const delta: never[] = [];
    const str = generateCompareJsonExport(before, after, delta);
    const obj = JSON.parse(str) as {
      before: { gaps: unknown[] };
      after: { gaps: unknown[] };
    };
    expect(Array.isArray(obj.before.gaps)).toBe(true);
    expect(Array.isArray(obj.after.gaps)).toBe(true);
  });
});
