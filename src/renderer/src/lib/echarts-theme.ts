/**
 * ECharts 主题构建器 — 从 CSS 变量动态构建 ECharts theme 对象。
 *
 * ADR 0019: 通过 getComputedStyle 读取应用 CSS 变量（--background / --foreground /
 * --primary / --status-pass / --status-fail / --status-error / --chart-1~4 等），
 * 动态构建 ECharts theme 对象。MutationObserver 监听 data-theme 属性变化，
 * 主题切换时重新构建 theme 并通知所有注册的监听器刷新图表。
 */

import type { EChartsOption } from 'echarts';

/** 从 document.documentElement 读取 CSS 变量的值。 */
function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** CSS 变量名 → 别名映射（oklch/hsl 值直接传给 ECharts） */
const VARS = {
  background: '--background',
  foreground: '--foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  border: '--border',
  card: '--card',
  cardForeground: '--card-foreground',
  statusPass: '--status-pass',
  statusFail: '--status-fail',
  statusError: '--status-error',
  statusRunning: '--status-running',
  chart1: '--chart-1',
  chart2: '--chart-2',
  chart3: '--chart-3',
  chart4: '--chart-4',
  chartOmp: '--chart-omp',
  chartClaude: '--chart-claude',
  chartCodex: '--chart-codex',
} as const;

/** ECharts theme 对象（可注入 option 的默认值） */
export type DashboardEChartsTheme = {
  backgroundColor: string;
  textColor: string;
  borderColor: string;
  mutedColor: string;
  cardColor: string;
  cardForegroundColor: string;
  colors: string[];
  statusPass: string;
  statusFail: string;
  statusError: string;
  statusRunning: string;
  /** Token Monitor 引擎语义色 */
  chartOmp: string;
  chartClaude: string;
  chartCodex: string;
  /** 生成 ECharts option 的默认值（merge 到用户 option 中） */
  toDefaults: () => Partial<EChartsOption>;
};

/** 构建当前 CSS 变量对应的 ECharts theme 对象。 */
export function buildEChartsTheme(): DashboardEChartsTheme {
  const background = cssVar(VARS.background) || '#ffffff';
  const foreground = cssVar(VARS.foreground) || '#333333';
  const border = cssVar(VARS.border) || '#cccccc';
  const mutedForeground = cssVar(VARS.mutedForeground) || '#999999';
  const card = cssVar(VARS.card) || background;
  const cardForeground = cssVar(VARS.cardForeground) || foreground;
  const chartColors = [
    cssVar(VARS.chart1) || '#5470c6',
    cssVar(VARS.chart2) || '#91cc75',
    cssVar(VARS.chart3) || '#fac858',
    cssVar(VARS.chart4) || '#ee6666',
  ];
  const statusPass = cssVar(VARS.statusPass) || '#91cc75';
  const statusFail = cssVar(VARS.statusFail) || '#ee6666';
  const statusError = cssVar(VARS.statusError) || '#ee6666';
  const statusRunning = cssVar(VARS.statusRunning) || '#73c0de';
  const chartOmp = cssVar(VARS.chartOmp) || chartColors[2] || '#fac858';
  const chartClaude = cssVar(VARS.chartClaude) || chartColors[3] || '#ee6666';
  const chartCodex = cssVar(VARS.chartCodex) || chartColors[1] || '#91cc75';

  return {
    backgroundColor: 'transparent',
    textColor: foreground,
    borderColor: border,
    mutedColor: mutedForeground,
    cardColor: card,
    cardForegroundColor: cardForeground,
    colors: chartColors,
    statusPass,
    statusFail,
    statusError,
    statusRunning,
    chartOmp,
    chartClaude,
    chartCodex,
    toDefaults: () => ({
      backgroundColor: 'transparent',
      textStyle: { color: foreground },
      color: chartColors,
      title: { textStyle: { color: foreground } },
      legend: { textStyle: { color: mutedForeground } },
      tooltip: {
        backgroundColor: background,
        borderColor: border,
        textStyle: { color: foreground },
      },
      xAxis: {
        axisLine: { lineStyle: { color: border } },
        axisLabel: { color: mutedForeground },
        splitLine: { lineStyle: { color: border, opacity: 0.3 } },
      },
      yAxis: {
        axisLine: { lineStyle: { color: border } },
        axisLabel: { color: mutedForeground },
        splitLine: { lineStyle: { color: border, opacity: 0.3 } },
      },
    }),
  };
}

// ─── 主题变化监听 ───────────────────────────────────────────

type ThemeListener = (theme: DashboardEChartsTheme) => void;

let currentTheme: DashboardEChartsTheme | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<ThemeListener>();

/** 获取当前缓存的 theme（首次调用时构建）。 */
export function getEChartsTheme(): DashboardEChartsTheme {
  if (!currentTheme) {
    currentTheme = buildEChartsTheme();
  }
  return currentTheme;
}

/** 注册主题变化监听器，返回取消注册函数。 */
export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 手动触发主题重建（测试或外部触发时使用）。 */
export function rebuildTheme(): DashboardEChartsTheme {
  currentTheme = buildEChartsTheme();
  for (const listener of listeners) {
    listener(currentTheme);
  }
  return currentTheme;
}

/** 启动 MutationObserver 监听 data-theme 属性变化。 */
export function startThemeObserver(): void {
  if (observer || typeof document === 'undefined') return;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
        rebuildTheme();
        break;
      }
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

/** 停止 MutationObserver。 */
export function stopThemeObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

/** 重置所有状态（测试用）。 */
export function resetThemeState(): void {
  stopThemeObserver();
  currentTheme = null;
  listeners.clear();
}
