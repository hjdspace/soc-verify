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
function rawCssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 将 CSS 变量值转换为 ECharts/zrender 可解析的格式（rgb/rgba/hex）。
 *
 * zrender 的颜色解析器（tool/color.js parse()）不支持 oklch() 格式——
 * parse() 对 oklch 走到 default 分支返回 undefined，导致 lift()
 * 计算失败，emphasis/hover 状态下图形变透明（柱子消失）。
 *
 * 注意：不能依赖 DOM probe（style.color + getComputedStyle）——
 * Chromium 111+ 对 oklch 颜色的 computed value 会原样返回 `oklch(...)`
 * 字符串而非 rgb()，probe 转换无效。因此 oklch 必须在 JS 中
 * 显式转换为 sRGB（OKLab → 线性 sRGB → gamma 编码）。
 */
const _probeEl: { el: HTMLDivElement | null } = { el: null };

/** oklch(l c h [/ a]) → rgb()/rgba() 字符串；不匹配返回 null。 */
function parseOklch(raw: string): string | null {
  const m = raw.match(
    /^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+(?:deg)?)\s*(?:\/\s*([\d.]+%?|[\d.]+)\s*)?\)$/i,
  );
  if (!m) return null;

  // 解析各分量（支持 % 语法：L% = /100，C% = ×0.4，H 单位 deg 可省略，α% = /100）
  const l = (m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]));
  const c = (m[2].endsWith('%') ? (parseFloat(m[2]) / 100) * 0.4 : parseFloat(m[2]));
  const hDeg = parseFloat(m[3]);
  const alpha = m[4] !== undefined ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
  if (![l, c, hDeg, alpha].every(Number.isFinite)) return null;

  // OKLab → 线性 sRGB（CSS Color 4 规范矩阵）
  const hr = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  const linR = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const linG = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const linB = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;

  // 线性 sRGB → gamma 编码（sRGB transfer function），截断到 [0,255]
  const encode = (x: number): number => {
    const v = Math.min(1, Math.max(0, x));
    const g = v >= 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v;
    return Math.round(g * 255);
  };
  const r = encode(linR);
  const g = encode(linG);
  const bl = encode(linB);
  const aOut = Math.min(1, Math.max(0, alpha));

  return aOut >= 1 ? `rgb(${r}, ${g}, ${bl})` : `rgba(${r}, ${g}, ${bl}, ${aOut})`;
}

function toEChartsColor(raw: string): string {
  if (!raw) return '';
  // 已经是 rgb/rgba/hex 格式 — 直接返回
  if (/^(rgb|rgba|#|hsl|hsla)/i.test(raw)) return raw;
  // oklch / oklab / color() / lab() / lch() 等需要转换
  const oklch = parseOklch(raw);
  if (oklch) return oklch;
  if (typeof document === 'undefined') return raw;
  // 兜底：DOM probe（对老格式仍有效，但 Chromium 111+ 对 oklch 无效）
  if (!_probeEl.el) {
    _probeEl.el = document.createElement('div');
    _probeEl.el.style.display = 'none';
    document.documentElement.appendChild(_probeEl.el);
  }
  _probeEl.el.style.color = raw;
  const computed = getComputedStyle(_probeEl.el).color;
  // probe 返回值若仍是 oklch（未转换），走 JS 转换
  return (computed && !/^oklch/i.test(computed) ? computed : null) || parseOklch(computed) || raw;
}

/** 读取 CSS 变量并转换为 ECharts 可解析的颜色格式。 */
function cssVar(name: string): string {
  return toEChartsColor(rawCssVar(name));
}

/** CSS 变量名 → 别名映射（值转换为 rgb 传给 ECharts） */
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
