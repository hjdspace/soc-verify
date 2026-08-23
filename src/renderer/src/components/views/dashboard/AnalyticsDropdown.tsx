/**
 * AnalyticsDropdown — 总览视图「分析面板」下拉菜单。
 *
 * 重构后的 DashboardView 以 Mission Control 仪表盘形式展示总览，
 * 原 DashboardPanel 的 8 个分析标签页（趋势/子系统/失败/回归/耗时/不稳定/阶段/调试难度）
 * 需要入口。点击菜单项后以 workspace Tab 打开 DashboardPanel 并自动切到对应标签页。
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { BarChart3, ChevronDown, TrendingUp, Grid3x3, AlertOctagon, Repeat, Clock, Zap, Filter, GitBranch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';
import type { DashboardTab } from '@renderer/stores/dashboard';

type AnalyticsEntry = {
  tab: DashboardTab;
  label: string;
  icon: LucideIcon;
};

/** 8 个分析面板入口（不含概览，概览已在总览视图中展示） */
const ANALYTICS_ENTRIES: AnalyticsEntry[] = [
  { tab: 'trend', label: '趋势', icon: TrendingUp },
  { tab: 'subsys', label: '子系统', icon: Grid3x3 },
  { tab: 'failures', label: '失败', icon: AlertOctagon },
  { tab: 'regression', label: '回归进度', icon: Repeat },
  { tab: 'duration', label: '耗时分布', icon: Clock },
  { tab: 'unstable', label: '不稳定', icon: Zap },
  { tab: 'phase', label: '阶段', icon: Filter },
  { tab: 'debug', label: '调试难度', icon: GitBranch },
];

export function AnalyticsDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openDestination = useWorkbenchStore((s) => s.open);

  const handleSelect = useCallback((tab: DashboardTab) => {
    openDestination({ type: 'dashboard-tab', tab });
    setOpen(false);
  }, [openDestination]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium transition-colors hover:bg-card',
          open ? 'border-primary/40 text-primary bg-card' : 'text-muted-foreground hover:text-foreground',
        )}
        data-testid="analytics-dropdown-trigger"
      >
        <BarChart3 className="size-3" />
        分析面板
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
          data-testid="analytics-dropdown-menu"
        >
          {ANALYTICS_ENTRIES.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              onClick={() => handleSelect(entry.tab)}
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              data-testid={`analytics-item-${entry.tab}`}
            >
              <entry.icon className="size-3.5 shrink-0 opacity-60" strokeWidth={1.8} />
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
