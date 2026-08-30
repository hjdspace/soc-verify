// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  InsightCards,
  chartIndexFromPointer,
  smooth,
  SMOOTH_PER_SEGMENT,
  type InsightCompareCard,
  type InsightPage,
} from '@renderer/components/ui/InsightCards';
import { useThemeStore } from '@renderer/stores/theme';

/**
 * 洞察轮播（issues #9，参考 beautiful-ui InsightCards）：
 * 断言外部行为——分页取模循环（末页→首页、首页反向→末页）、异常卡 metric 切换
 * （数据/阈值线/头部文案联动）、占比分段条点选驱动大数字、自建 scrub
 * （pointer x → index → 游标/tooltip/锚点钳制）、追问 pill 回调、
 * theme store 明暗档（data-shade）。recharts 在 jsdom 下 ResponsiveContainer
 * 量不到尺寸（ResizeObserver 为 setup 中的 noop polyfill），以透传 stub 替换，
 * 把 data/stroke/参考线落到 DOM 供断言；Catmull-Rom 与指针换算做纯函数单测。
 */

// recharts 在 jsdom 量不到尺寸（ResizeObserver 为 setup 中的 noop polyfill），
// 用共享透传 stub 替换：props 落成 data-* 属性、data/children 透传，断言在 DOM 边界进行
vi.mock('recharts', async () => {
  const { rechartsStubFactory } = await import('./recharts-stub');
  return rechartsStubFactory();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── 纯函数 ─────────────────────────────────────────────────────

describe('smooth（Catmull-Rom 重采样，参考实现原样搬移）', () => {
  it('每段插值 9 点：长度 = (n-1)*9+1，端点保留', () => {
    const dense = smooth([0, 10, 0]);
    expect(dense).toHaveLength(2 * SMOOTH_PER_SEGMENT + 1);
    expect(dense[0]).toBe(0);
    expect(dense.at(-1)).toBe(0);
    // 峰值附近不超过原序列范围
    expect(Math.max(...dense)).toBeLessThanOrEqual(10);
    expect(Math.min(...dense)).toBeGreaterThanOrEqual(0);
  });

  it('少于 3 点原样返回（副本）', () => {
    expect(smooth([5, 7])).toEqual([5, 7]);
    expect(smooth([5])).toEqual([5]);
  });
});

describe('chartIndexFromPointer（pointer x → 数据 index）', () => {
  const rect = { left: 100, width: 200 };

  it('包围盒内进度取整映射到 index', () => {
    expect(chartIndexFromPointer(100, rect, 9)).toBe(0);
    expect(chartIndexFromPointer(200, rect, 9)).toBe(4);
    // 进度 1 → 末位 index = pointCount-1
    expect(chartIndexFromPointer(300, rect, 9)).toBe(8);
  });

  it('越界钳回数据范围', () => {
    expect(chartIndexFromPointer(50, rect, 9)).toBe(0);
    expect(chartIndexFromPointer(500, rect, 9)).toBe(8);
  });

  it('零宽/单点退化为 0（不产生 NaN）', () => {
    expect(chartIndexFromPointer(150, { left: 0, width: 0 }, 9)).toBe(0);
    expect(chartIndexFromPointer(150, rect, 1)).toBe(0);
  });
});

// ─── 组件 fixtures（演示数据只存在于测试） ────────────────────────

// card 收窄为 compare 变体——稠密化数据断言直接读 .series（InsightCardData 联合类型无此字段）
const comparePage: InsightPage & { card: InsightCompareCard } = {
  key: 'compare',
  prose: <>对比页叙述</>,
  pill: '对比页追问',
  card: {
    kind: 'compare',
    caption: '通过 / 失败趋势',
    badge: '趋势',
    labels: ['d1', 'd2', 'd3', 'd4'],
    series: [
      { name: '通过', values: [1, 2, 3, 4], colorVar: '--status-pass', tone: 'pass', format: (v) => `${Math.round(v)} 次`, sub: '通过率 80%', subTone: 'pass' },
      { name: '失败', values: [2, 1, 4, 3], colorVar: '--status-fail', tone: 'fail', format: (v) => `${Math.round(v)} 次` },
    ],
  },
};

const anomalyPage: InsightPage = {
  key: 'anomaly',
  prose: <>异常页叙述</>,
  pill: '异常页追问',
  card: {
    kind: 'anomaly',
    title: <>不稳定用例 Top 3</>,
    metrics: [
      {
        key: 'rate',
        label: '失败率',
        values: [66.7, 50, 33.3],
        labels: ['caseA', 'caseB', 'caseC'],
        headerLabel: '失败率 ≥ 50% 阈值',
        threshold: 50,
        format: (v) => `${v}%`,
      },
      {
        key: 'count',
        label: '失败次数',
        values: [4, 3, 1],
        labels: ['caseA', 'caseB', 'caseC'],
        headerLabel: '共 3 个不稳定用例',
        format: (v) => `${Math.round(v)} 次`,
      },
    ],
    footer: { value: '3 个', note: '通过且失败过的用例' },
  },
};

const allocationPage: InsightPage = {
  key: 'allocation',
  prose: <>占比页叙述</>,
  pill: '占比页追问',
  card: {
    kind: 'allocation',
    title: <>失败子系统占比</>,
    segments: [
      { key: 'a', label: 'ALU', pct: 60, value: '6 次', color: 'var(--chart-1)', detail: 'ALU 占 60%。' },
      { key: 'b', label: 'DMA', pct: 30, value: '3 次', color: 'var(--chart-2)' },
      { key: 'c', label: 'UART', pct: 10, value: '1 次', color: 'var(--chart-3)' },
    ],
  },
};

const THREE_PAGES = [comparePage, anomalyPage, allocationPage];

function stubStageRect(left = 0, width = 100): HTMLElement {
  const stage = screen.getByTestId('ins-stage');
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    left,
    width,
    top: 0,
    right: left + width,
    bottom: 166,
    height: 166,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return stage;
}

// ─── 轮播分页 ───────────────────────────────────────────────────

describe('InsightCards 分页', () => {
  it('默认首页；下一页顺序推进，末页 → 首页取模循环', () => {
    render(<InsightCards pages={THREE_PAGES} testId="insight" />);
    expect(screen.getByTestId('ins-card-compare')).toBeInTheDocument();
    expect(screen.getByText('对比页叙述')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-card-anomaly')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-card-allocation')).toBeInTheDocument();
    // 末页再下一页 → 回到首页
    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-card-compare')).toBeInTheDocument();
  });

  it('上一页反向推进，首页 → 末页取模循环', () => {
    render(<InsightCards pages={THREE_PAGES} testId="insight" />);
    fireEvent.click(screen.getByTestId('ins-prev'));
    expect(screen.getByTestId('ins-card-allocation')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ins-prev'));
    expect(screen.getByTestId('ins-card-anomaly')).toBeInTheDocument();
  });

  it('页头计数与每页 pill/追问文案随页切换', () => {
    const onAskPill = vi.fn();
    render(<InsightCards pages={THREE_PAGES} testId="insight" onAskPill={onAskPill} />);
    expect(screen.getByText('3')).toBeInTheDocument();

    expect(screen.getByTestId('ins-pill').textContent).toBe('对比页追问');
    fireEvent.click(screen.getByTestId('ins-pill'));
    expect(onAskPill).toHaveBeenCalledWith('对比页追问');

    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-pill').textContent).toBe('异常页追问');
  });

  it('无 onAskPill 时 pill 渲染为非交互文本', () => {
    render(<InsightCards pages={[allocationPage]} testId="insight" />);
    const pill = screen.getByTestId('ins-pill');
    expect(pill.tagName).toBe('SPAN');
    expect(pill).toHaveAttribute('data-static', 'true');
  });

  it('空 pages 渲染 null', () => {
    const { container } = render(<InsightCards pages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('单页仍正常渲染且翻页不越界', () => {
    render(<InsightCards pages={[allocationPage]} testId="insight" />);
    expect(screen.getByText('1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ins-next'));
    expect(screen.getByTestId('ins-card-allocation')).toBeInTheDocument();
  });
});

// ─── 异常卡 metric 切换 ─────────────────────────────────────────

describe('InsightCards 异常卡 metric 切换', () => {
  it('默认失败率档：阈值参考线在场、头部显示阈值文案、aria-pressed 反映档位', () => {
    render(<InsightCards pages={[anomalyPage]} testId="insight" />);
    expect(screen.getByTestId('ins-metric-rate')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mock-refline')).toHaveAttribute('data-y', '50');
    expect(screen.getByTestId('ins-stage').previousElementSibling?.textContent).toContain('失败率 ≥ 50% 阈值');
  });

  it('切到失败次数档：柱状数据换档、参考线消失、头部摘要联动、悬停态清空', () => {
    render(<InsightCards pages={[anomalyPage]} testId="insight" />);
    fireEvent.click(screen.getByTestId('ins-metric-count'));

    expect(screen.getByTestId('ins-metric-count')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ins-metric-rate')).toHaveAttribute('aria-pressed', 'false');
    const chart = JSON.parse(
      screen.getByTestId('mock-bar-chart').getAttribute('data-chart-json') ?? '[]',
    ) as { value: number }[];
    expect(chart.map((d) => d.value)).toEqual([4, 3, 1]);
    expect(screen.queryByTestId('mock-refline')).toBeNull();
    expect(screen.getByTestId('ins-stage').previousElementSibling?.textContent).toContain('共 3 个不稳定用例');
  });

  it('柱状 scrub：pointer 移动显示竖线游标 + tooltip，离开清除（与参考实现一致）', () => {
    render(<InsightCards pages={[anomalyPage]} testId="insight" />);
    const stage = stubStageRect(0, 100);

    expect(screen.queryByTestId('ins-cursor')).toBeNull();
    // clientX 50 → 进度 0.5 → index round(0.5*2)=1
    fireEvent.pointerMove(stage, { clientX: 50 });
    expect(parseFloat(screen.getByTestId('ins-cursor').style.left)).toBeCloseTo(50, 5);
    expect(screen.getByTestId('ins-tooltip').textContent).toContain('50%');
    // 头部切换为悬停类目与格式化值
    expect(screen.getByTestId('ins-stage').previousElementSibling?.textContent).toContain('caseB · 50%');

    fireEvent.pointerLeave(stage);
    expect(screen.queryByTestId('ins-cursor')).toBeNull();
    expect(screen.queryByTestId('ins-tooltip')).toBeNull();
  });
});

// ─── 占比分段条 ─────────────────────────────────────────────────

describe('InsightCards 占比分段条', () => {
  it('默认选中首段展示其大数字；点选分段按钮切换大数字与 aria-pressed', () => {
    render(<InsightCards pages={[allocationPage]} testId="insight" />);
    expect(screen.getByTestId('ins-hero').textContent).toBe('6 次');
    expect(screen.getByTestId('ins-seg-a')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('ins-seg-b'));
    expect(screen.getByTestId('ins-hero').textContent).toBe('3 次');
    expect(screen.getByTestId('ins-seg-b')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ins-seg-a')).toHaveAttribute('aria-pressed', 'false');
    // 详情框跟随选中段
    expect(screen.getByTestId('ins-detail').textContent).toContain('DMA');
  });

  it('图例按钮同样点选驱动大数字', () => {
    render(<InsightCards pages={[allocationPage]} testId="insight" />);
    fireEvent.click(screen.getByTestId('ins-legend-c'));
    expect(screen.getByTestId('ins-hero').textContent).toBe('1 次');
  });

  it('分段宽度按 pct 注入 inline style（分段色为语义变量）', () => {
    render(<InsightCards pages={[allocationPage]} testId="insight" />);
    const seg = screen.getByTestId('ins-seg-a');
    expect(seg.style.width).toBe('60%');
    expect(seg.style.background).toBe('var(--chart-1)');
  });
});

// ─── 自建 scrub ─────────────────────────────────────────────────

describe('InsightCards 自建 scrub（游标 + tooltip）', () => {
  it('pointer 移动换算 index：游标定位、tooltip 展示稠密点格式化值、头部切日期', () => {
    render(<InsightCards pages={[comparePage]} testId="insight" />);
    const stage = stubStageRect(0, 100);
    // 稠密点数 (4-1)*9+1=28；clientX 50 → 进度 0.5 → index 14
    const dense = smooth([1, 2, 3, 4]);
    const idx = 14;

    fireEvent.pointerMove(stage, { clientX: 50 });

    const cursor = screen.getByTestId('ins-cursor');
    expect(parseFloat(cursor.style.left)).toBeCloseTo((idx / (dense.length - 1)) * 100, 5);
    const tooltip = screen.getByTestId('ins-tooltip');
    expect(tooltip.textContent).toContain(`${Math.round(dense[idx])} 次`);
    // tooltip 双系列两行
    expect(tooltip.textContent).toContain(`${Math.round(smooth([2, 1, 4, 3])[idx])} 次`);
    // 头部 caption 切换为悬停点原始标签（dense index 14 → 原始 index 1）
    expect(screen.getByText('d2')).toBeInTheDocument();
  });

  it('锚点水平位置钳制在 28–72%，贴边不溢出', () => {
    render(<InsightCards pages={[comparePage]} testId="insight" />);
    const stage = stubStageRect(0, 100);
    fireEvent.pointerMove(stage, { clientX: 0 });
    const anchor = screen.getByTestId('ins-tooltip').parentElement;
    expect(anchor).not.toBeNull();
    if (anchor) expect(parseFloat(anchor.style.left)).toBe(28);

    fireEvent.pointerMove(stage, { clientX: 100 });
    if (anchor) expect(parseFloat(anchor.style.left)).toBe(72);
  });

  it('pointer 离开清除游标与 tooltip', () => {
    render(<InsightCards pages={[comparePage]} testId="insight" />);
    const stage = stubStageRect(0, 100);
    fireEvent.pointerMove(stage, { clientX: 50 });
    expect(screen.getByTestId('ins-cursor')).toBeInTheDocument();
    fireEvent.pointerLeave(stage);
    expect(screen.queryByTestId('ins-cursor')).toBeNull();
    expect(screen.queryByTestId('ins-tooltip')).toBeNull();
  });
});

// ─── 主题档位 ───────────────────────────────────────────────────

describe('InsightCards 明暗档（theme store）', () => {
  beforeEach(() => {
    // 走真实 setTheme：同步 dataset.theme（applyTheme）+ store，供明暗对照
    act(() => {
      useThemeStore.getState().setTheme('bench'); // dark
    });
  });

  it('data-shade 随 theme store 切换（store 驱动，非 MutationObserver）', () => {
    const { rerender } = render(<InsightCards pages={[allocationPage]} testId="insight" />);
    expect(screen.getByTestId('insight')).toHaveAttribute('data-shade', 'dark');

    act(() => {
      useThemeStore.getState().setTheme('daylight'); // light
    });
    rerender(<InsightCards pages={[allocationPage]} testId="insight" />);
    expect(screen.getByTestId('insight')).toHaveAttribute('data-shade', 'light');
  });

  it('折线 stroke 按 :root 计算值解析，主题切换后重读（明暗两档取值对照）', () => {
    // jsdom 不解析 CSS 自定义属性——按 data-theme 返回可区分的计算值，
    // 验证「shade 变化 → 重渲染 → 重读计算色」链路（SVG 属性不能 var()）
    const PALETTES: Record<string, Record<string, string>> = {
      bench: { '--status-pass': 'rgb(20 200 120)', '--status-fail': 'rgb(230 80 80)' },
      daylight: { '--status-pass': 'rgb(10 140 70)', '--status-fail': 'rgb(180 40 40)' },
    };
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((elt) => {
      const palette = PALETTES[document.documentElement.dataset.theme ?? ''];
      if (!palette) return realGetComputedStyle(elt);
      return {
        getPropertyValue: (name: string) => palette[name] ?? '',
      } as CSSStyleDeclaration;
    });

    render(<InsightCards pages={[comparePage]} testId="insight" />);
    const strokeOf = () => screen.getAllByTestId('mock-line').map((el) => el.getAttribute('data-stroke'));
    expect(strokeOf()).toEqual(['rgb(20 200 120)', 'rgb(230 80 80)']);

    act(() => {
      useThemeStore.getState().setTheme('daylight');
    });
    expect(strokeOf()).toEqual(['rgb(10 140 70)', 'rgb(180 40 40)']);
  });

  it('折线图接收稠密化双系列数据（smooth 每段 9 点，dataKey a/b）', () => {
    render(<InsightCards pages={[comparePage]} testId="insight" />);
    const chart = screen.getByTestId('mock-line-chart');
    const data = JSON.parse(chart.getAttribute('data-chart-json') ?? '[]') as { a: number; b: number }[];
    // (4-1)*9+1 = 28 个稠密点，双系列各占一列
    expect(data).toHaveLength((comparePage.card.series[0].values.length - 1) * SMOOTH_PER_SEGMENT + 1);
    expect(data[0]).toEqual({ i: 0, a: 1, b: 2 });
    const dataKeys = screen.getAllByTestId('mock-line').map((el) => el.getAttribute('data-datakey'));
    expect(dataKeys).toEqual(['a', 'b']);
  });
});
