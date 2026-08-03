/**
 * TVStatsCards — 统计卡片区域
 *
 * 展示总数、已确认、待确认、已忽略四个卡片，每个卡片用不同颜色区分。
 */

import { CheckCircle2, Clock, XCircle, ListChecks } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { ViolationStatistics } from '@renderer/stores/timing-violation';

type StatsCardsProps = {
  statistics: ViolationStatistics | null;
  loading: boolean;
};

type CardConfig = {
  label: string;
  value: number;
  icon: typeof ListChecks;
  iconClass: string;
  valueClass: string;
  bgClass: string;
};

export function TVStatsCards({ statistics, loading }: StatsCardsProps) {
  const cards: CardConfig[] = [
    {
      label: '总数',
      value: statistics?.total ?? 0,
      icon: ListChecks,
      iconClass: 'text-blue-500',
      valueClass: 'text-blue-600 dark:text-blue-400',
      bgClass: 'bg-blue-500/5 border-blue-500/20',
    },
    {
      label: '已确认',
      value: statistics?.confirmed ?? 0,
      icon: CheckCircle2,
      iconClass: 'text-green-500',
      valueClass: 'text-green-600 dark:text-green-400',
      bgClass: 'bg-green-500/5 border-green-500/20',
    },
    {
      label: '待确认',
      value: statistics?.pending ?? 0,
      icon: Clock,
      iconClass: 'text-amber-500',
      valueClass: 'text-amber-600 dark:text-amber-400',
      bgClass: 'bg-amber-500/5 border-amber-500/20',
    },
    {
      label: '已忽略',
      value: statistics?.ignored ?? 0,
      icon: XCircle,
      iconClass: 'text-gray-500',
      valueClass: 'text-gray-600 dark:text-gray-400',
      bgClass: 'bg-gray-500/5 border-gray-500/20',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2',
              card.bgClass,
            )}
          >
            <Icon className={cn('h-5 w-5 shrink-0', card.iconClass)} />
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {card.label}
              </div>
              <div className={cn('text-xl font-bold tabular-nums', loading && 'animate-pulse', card.valueClass)}>
                {loading ? '—' : card.value.toLocaleString()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
