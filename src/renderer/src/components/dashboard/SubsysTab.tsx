/**
 * SubsysTab — 子系统标签页：ECharts 热力图 + 子系统详细数据表。
 *
 * Issue 04: 热力图颜色根据状态和强度动态混合（参考原型 blendColors / parseColor）。
 * 热力图标签颜色自适应（深色背景用浅色文字，浅色背景用深色文字）。
 */

import { useMemo, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

/** 颜色解析：将 CSS 颜色字符串解析为 { r, g, b } */
function parseColor(str: string): { r: number; g: number; b: number } {
  if (typeof document === 'undefined') return { r: 128, g: 128, b: 128 };
  const div = document.createElement('div');
  div.style.color = str;
  document.body.appendChild(div);
  const computed = getComputedStyle(div).color;
  document.body.removeChild(div);
  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return { r: parseInt(match[1], 10), g: parseInt(match[2], 10), b: parseInt(match[3], 10) };
  }
  return { r: 128, g: 128, b: 128 };
}

/** 将两个颜色按 ratio 混合（ratio=0 → color1，ratio=1 → color2） */
function blendColors(color1: string, color2: string, ratio: number): string {
  try {
    const c1 = parseColor(color1);
    const c2 = parseColor(color2);
    const r = Math.round(c1.r * (1 - ratio) + c2.r * ratio);
    const g = Math.round(c1.g * (1 - ratio) + c2.g * ratio);
    const b = Math.round(c1.b * (1 - ratio) + c2.b * ratio);
    return `rgb(${r},${g},${b})`;
  } catch {
    return color2;
  }
}

/** 状态标签 */
const STATUS_LABELS = ['Pass', 'Fail', 'Error'];

export function SubsysTab() {
  const subsysHeatmap = useDashboardStore((s) => s.subsysHeatmap);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const option = useMemo<EChartsOption>(() => {
    if (!subsysHeatmap || subsysHeatmap.length === 0) return {};

    const theme = getEChartsTheme();
    const subsysNames = subsysHeatmap.map((s) => s.subsys);
    const statusColors = [theme.statusPass, theme.statusFail, theme.statusError];

    // 按列（status）计算各自的最大值，用于渐变强度
    const maxByCol = [
      Math.max(...subsysHeatmap.map((s) => s.pass), 1),
      Math.max(...subsysHeatmap.map((s) => s.fail), 1),
      Math.max(...subsysHeatmap.map((s) => s.error), 1),
    ];

    // 构建热力图数据
    const data: { value: [number, number, number]; itemStyle: { color: string; borderColor: string; borderWidth: number }; label: { color: string } }[] = [];

    subsysHeatmap.forEach((s, i) => {
      const cols = [s.pass, s.fail, s.error];
      cols.forEach((val, col) => {
        const max = maxByCol[col];
        const intensity = max > 0 ? val / max : 0;
        const baseColor = statusColors[col];
        const blended = blendColors(theme.cardColor, baseColor, intensity);
        // 标签颜色自适应：高强度用浅色文字，低强度用深色文字
        const labelColor = intensity > 0.5 ? '#ffffff' : theme.textColor;

        data.push({
          value: [col, i, val],
          itemStyle: {
            color: blended,
            borderColor: theme.borderColor,
            borderWidth: 1,
          },
          label: { color: labelColor },
        });
      });
    });

    return {
      ...theme.toDefaults(),
      tooltip: {
        position: 'top',
        ...theme.toDefaults().tooltip,
        formatter: (params: { data: [number, number, number] }) => {
          const subsysIdx = params.data[1];
          const statusIdx = params.data[0];
          const val = params.data[2];
          const subsys = subsysNames[subsysIdx] ?? '';
          const status = STATUS_LABELS[statusIdx] ?? '';
          return `${subsys}<br/>${status}: ${val}`;
        },
      },
      grid: { left: 100, right: 30, top: 20, bottom: 30, containLabel: true },
      xAxis: {
        type: 'category',
        data: STATUS_LABELS,
        splitArea: { show: false },
      },
      yAxis: {
        type: 'category',
        data: subsysNames,
        splitArea: { show: false },
      },
      series: [
        {
          type: 'heatmap',
          data,
          label: {
            show: true,
            fontSize: 10,
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowColor: 'rgba(0,0,0,0.3)',
            },
          },
        },
      ],
    };
  }, [subsysHeatmap]);

  if (!subsysHeatmap || subsysHeatmap.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* ─── ECharts 热力图 ────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          子系统 Pass/Fail/Error 分布热力图
        </div>
        <ReactECharts
          option={option}
          style={{ height: `${Math.max(200, subsysHeatmap.length * 40 + 60)}px`, width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>

      {/* ─── 子系统详细数据表 ───────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          子系统详细数据
        </div>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                子系统
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                总数
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                通过
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                失败
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                错误
              </th>
              <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                通过率
              </th>
            </tr>
          </thead>
          <tbody>
            {subsysHeatmap.map((s) => (
              <tr key={s.subsys} className="hover:bg-accent">
                <td className="border-b border-border px-2.5 py-1 text-foreground">
                  {s.subsys}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                  {s.total}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-pass-foreground">
                  {s.pass}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                  {s.fail}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                  {s.error}
                </td>
                <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                  {s.passRate}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
