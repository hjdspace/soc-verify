import { describe, it, expect } from 'vitest';
import {
  COVERAGE_METRICS,
  DEFAULT_COVERAGE_TARGETS,
  NA_TRIPLET,
  triplet,
  summarizeCoverage,
  detectGaps,
  calculateDelta,
} from '@shared/types';
import type { CoverageNode, CoverageMetric } from '@shared/types';

// ─── 辅助构造函数 ──────────────────────────────────────────────

function makeNode(
  name: string,
  path: string,
  depth: number,
  metrics: Partial<Record<CoverageMetric, ReturnType<typeof triplet>>> = {},
  children: CoverageNode[] = [],
): CoverageNode {
  return {
    name,
    path,
    depth,
    metrics: {
      line: NA_TRIPLET,
      branch: NA_TRIPLET,
      toggle: NA_TRIPLET,
      condition: NA_TRIPLET,
      fsm_state: NA_TRIPLET,
      fsm_transition: NA_TRIPLET,
      functional: NA_TRIPLET,
      assertion: NA_TRIPLET,
      ...metrics,
    },
    children,
  };
}

// ─── DEFAULT_COVERAGE_TARGETS ──────────────────────────────────

describe('DEFAULT_COVERAGE_TARGETS', () => {
  it('defines targets for exactly 7 metrics (assertion excluded)', () => {
    const keys = Object.keys(DEFAULT_COVERAGE_TARGETS);
    expect(keys).toHaveLength(7);
    expect(keys).not.toContain('assertion');
    expect(DEFAULT_COVERAGE_TARGETS.line).toBe(95);
    expect(DEFAULT_COVERAGE_TARGETS.branch).toBe(90);
    expect(DEFAULT_COVERAGE_TARGETS.toggle).toBe(85);
    expect(DEFAULT_COVERAGE_TARGETS.condition).toBe(85);
    expect(DEFAULT_COVERAGE_TARGETS.fsm_state).toBe(100);
    expect(DEFAULT_COVERAGE_TARGETS.fsm_transition).toBe(90);
    expect(DEFAULT_COVERAGE_TARGETS.functional).toBe(100);
  });
});

// ─── triplet() ─────────────────────────────────────────────────

describe('triplet', () => {
  it('computes percentage from covered/total', () => {
    const t = triplet(75, 100);
    expect(t.covered).toBe(75);
    expect(t.total).toBe(100);
    expect(t.percentage).toBe(75);
  });

  it('returns 100% when total is 0 (empty视为已覆盖)', () => {
    const t = triplet(0, 0);
    expect(t.percentage).toBe(100);
  });

  it('handles partial coverage', () => {
    const t = triplet(1, 3);
    expect(t.percentage).toBeCloseTo(33.33, 1);
  });
});

// ─── summarizeCoverage() ───────────────────────────────────────

describe('summarizeCoverage', () => {
  it('returns 0 for N/A metrics', () => {
    const node = makeNode('root', 'root', 0);
    const summary = summarizeCoverage(node);
    expect(summary.line).toBe(0);
    expect(summary.branch).toBe(0);
    expect(summary.overall).toBe(0);
  });

  it('derives all 8 metric percentages from root node', () => {
    const node = makeNode('root', 'root', 0, {
      line: triplet(90, 100),
      branch: triplet(80, 100),
      toggle: triplet(70, 100),
      condition: triplet(60, 100),
      fsm_state: triplet(50, 50),
      fsm_transition: triplet(45, 50),
      functional: triplet(100, 100),
      assertion: triplet(0, 100),
    });
    const summary = summarizeCoverage(node);
    expect(summary.line).toBe(90);
    expect(summary.branch).toBe(80);
    expect(summary.toggle).toBe(70);
    expect(summary.condition).toBe(60);
    expect(summary.fsm_state).toBe(100);
    expect(summary.fsm_transition).toBe(90);
    expect(summary.functional).toBe(100);
    expect(summary.assertion).toBe(0);
    // overall = 平均值
    const expected = (90 + 80 + 70 + 60 + 100 + 90 + 100 + 0) / 8;
    expect(summary.overall).toBeCloseTo(expected, 1);
  });
});

// ─── detectGaps() ──────────────────────────────────────────────

describe('detectGaps', () => {
  it('returns empty array when all metrics meet or exceed targets', () => {
    const node = makeNode('root', 'root', 0, {
      line: triplet(100, 100), // 100% >= 95 target
      branch: triplet(90, 100), // 90% >= 90 target
    });
    const gaps = detectGaps(node, DEFAULT_COVERAGE_TARGETS);
    // N/A metrics are skipped; line and branch meet targets
    expect(gaps).toHaveLength(0);
  });

  it('detects a gap when metric is below target', () => {
    const node = makeNode('root', 'root', 0, {
      line: triplet(80, 100), // 80% < 95 target → gap, deficit=15
    });
    const gaps = detectGaps(node, DEFAULT_COVERAGE_TARGETS);
    const lineGap = gaps.find((g) => g.metric === 'line');
    expect(lineGap).toBeDefined();
    expect(lineGap!.nodePath).toBe('root');
    expect(lineGap!.nodeName).toBe('root');
    expect(lineGap!.target).toBe(95);
    expect(lineGap!.actual).toBe(80);
    expect(lineGap!.deficit).toBe(15);
  });

  it('walks the entire tree recursively', () => {
    const child = makeNode('child', 'root/child', 1, {
      line: triplet(70, 100), // 70% < 95 → gap
    });
    const root = makeNode('root', 'root', 0, {
      line: triplet(80, 100), // 80% < 95 → gap
    }, [child]);
    const gaps = detectGaps(root, DEFAULT_COVERAGE_TARGETS);
    expect(gaps).toHaveLength(2);
    const paths = gaps.map((g) => g.nodePath).sort();
    expect(paths).toEqual(['root', 'root/child']);
  });

  it('skips N/A metrics (percentage=null)', () => {
    const node = makeNode('root', 'root', 0); // all N/A
    const gaps = detectGaps(node, DEFAULT_COVERAGE_TARGETS);
    expect(gaps).toHaveLength(0);
  });

  it('skips metrics without a target (e.g. assertion)', () => {
    const node = makeNode('root', 'root', 0, {
      assertion: triplet(50, 100), // 50% but no assertion target
    });
    const gaps = detectGaps(node, DEFAULT_COVERAGE_TARGETS);
    expect(gaps.find((g) => g.metric === 'assertion')).toBeUndefined();
  });

  it('respects custom targets that override defaults', () => {
    const node = makeNode('root', 'root', 0, {
      line: triplet(90, 100), // 90% — meets default 95? No, 90 < 95 → gap by default
    });
    // 用更低的自定义 target：line=85 → 90% 达标，无 gap
    const gaps = detectGaps(node, { line: 85 });
    expect(gaps.find((g) => g.metric === 'line')).toBeUndefined();
  });

  it('computes deficit as target - actual', () => {
    const node = makeNode('root', 'root', 0, {
      branch: triplet(75, 100), // 75% < 90 → deficit = 15
    });
    const gaps = detectGaps(node, DEFAULT_COVERAGE_TARGETS);
    const branchGap = gaps.find((g) => g.metric === 'branch');
    expect(branchGap!.deficit).toBe(15);
  });
});

// ─── calculateDelta() ──────────────────────────────────────────

describe('calculateDelta', () => {
  it('returns one delta entry per metric (8 total)', () => {
    const before = { overall: 0, line: 0, branch: 0, toggle: 0, condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0 };
    const after = { ...before, line: 50 };
    const deltas = calculateDelta(before, after);
    expect(deltas).toHaveLength(8);
    expect(COVERAGE_METRICS.length).toBe(8);
  });

  it('computes delta = after - before for each metric', () => {
    const before = { overall: 0, line: 80, branch: 70, toggle: 60, condition: 50, fsm_state: 90, fsm_transition: 80, functional: 100, assertion: 40 };
    const after = { overall: 0, line: 90, branch: 75, toggle: 65, condition: 55, fsm_state: 95, fsm_transition: 85, functional: 100, assertion: 50 };
    const deltas = calculateDelta(before, after);
    const lineDelta = deltas.find((d) => d.metric === 'line');
    expect(lineDelta!.before).toBe(80);
    expect(lineDelta!.after).toBe(90);
    expect(lineDelta!.delta).toBe(10);

    const assertionDelta = deltas.find((d) => d.metric === 'assertion');
    expect(assertionDelta!.delta).toBe(10);
  });

  it('reports negative delta when coverage regresses', () => {
    const before = { overall: 0, line: 90, branch: 0, toggle: 0, condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0 };
    const after = { overall: 0, line: 85, branch: 0, toggle: 0, condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0 };
    const deltas = calculateDelta(before, after);
    const lineDelta = deltas.find((d) => d.metric === 'line');
    expect(lineDelta!.delta).toBe(-5);
  });

  it('reports zero delta when coverage is unchanged', () => {
    const before = { overall: 0, line: 75, branch: 0, toggle: 0, condition: 0, fsm_state: 0, fsm_transition: 0, functional: 0, assertion: 0 };
    const after = { ...before };
    const deltas = calculateDelta(before, after);
    expect(deltas.find((d) => d.metric === 'line')!.delta).toBe(0);
  });
});
