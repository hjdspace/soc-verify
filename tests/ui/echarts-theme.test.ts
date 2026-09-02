// @vitest-environment jsdom
/**
 * echarts-theme 回归测试 — oklch → sRGB 转换。
 *
 * 背景：项目 CSS 变量为 oklch() 格式，zrender 不支持解析 oklch，
 * 会导致 hover/emphasis 时 lift() 失败、图形变透明（柱子消失）。
 * theme 构建时必须把所有颜色转换为 rgb()/rgba()/hex。
 */
import { describe, expect, it } from 'vitest';
import { buildEChartsTheme, rebuildTheme } from '@renderer/lib/echarts-theme';

describe('buildEChartsTheme oklch 转换', () => {
  it('oklch CSS 变量应转换为 rgb 格式（不含 oklch 字样）', () => {
    document.documentElement.style.setProperty('--chart-claude', 'oklch(0.705 0.15 54.6)');
    document.documentElement.style.setProperty('--chart-omp', 'oklch(0.65 0.18 290)');
    document.documentElement.style.setProperty('--chart-codex', 'oklch(0.72 0.12 220)');
    try {
      const theme = rebuildTheme();
      for (const color of [theme.chartClaude, theme.chartOmp, theme.chartCodex]) {
        expect(color).toMatch(/^(rgb|rgba)\(/);
        expect(color).not.toContain('oklch');
      }
    } finally {
      document.documentElement.style.removeProperty('--chart-claude');
      document.documentElement.style.removeProperty('--chart-omp');
      document.documentElement.style.removeProperty('--chart-codex');
      rebuildTheme();
    }
  });

  it('带 alpha 的 oklch 应转换为 rgba 格式', () => {
    document.documentElement.style.setProperty('--chart-1', 'oklch(0.6 0.2 140 / 0.5)');
    try {
      const theme = rebuildTheme();
      expect(theme.colors[0]).toMatch(/^rgba\(/);
      expect(theme.colors[0]).not.toContain('oklch');
    } finally {
      document.documentElement.style.removeProperty('--chart-1');
      rebuildTheme();
    }
  });

  it('无 CSS 变量时回退到默认 hex 色', () => {
    const theme = buildEChartsTheme();
    expect(theme.colors.length).toBeGreaterThan(0);
    for (const color of theme.colors) {
      expect(color).not.toContain('oklch');
    }
  });
});
