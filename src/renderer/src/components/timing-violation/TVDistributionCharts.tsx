/**
 * TVDistributionCharts — 分布图表组件
 *
 * 使用 Recharts 实现可视化展示：
 * - 按子系统分布的违例数量柱状图
 * - 按 Corner 分布的违例数量柱状图
 * - 按用例分布的违例数量图（Top N）
 * - 状态分布饼图（已确认/待确认/已忽略）
 *
 * 图表支持点击交互（点击柱/饼图扇区触发筛选）。
 */

import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { cn } from '@renderer/lib/utils';
import type { ViolationStatistics } from '@renderer/stores/timing-violation';

const STATUS_COLORS: Record<string, string> = {
  confirmed: '#22c55e',
  pending: '#f59e0b',
  ignored: '#94a3b8',
};

const BAR_COLOR = '#3b82f6';
const BAR_COLOR_2 = '#8b5cf6';

type ChartsProps = {
  statistics: ViolationStatistics | null;
  loading: boolean;
  onSubsysClick?: (subsys: string) => void;
  onCornerClick?: (corner: string) => void;
  onCaseClick?: (caseName: string) => void;
  onStatusClick?: (status: 'confirmed' | 'pending' | 'ignored') => void;
};

export function TVDistributionCharts({
  statistics,
  loading,
  onSubsysClick,
  onCornerClick,
  onCaseClick,
  onStatusClick,
}: ChartsProps) {
  // 按子系统分布数据
  const subsysData = useMemo(() => {
    if (!statistics?.bySubsys) return [];
    return Object.entries(statistics.bySubsys)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [statistics]);

  // 按 Corner 分布数据
  const cornerData = useMemo(() => {
    if (!statistics?.byCorner) return [];
    return Object.entries(statistics.byCorner)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [statistics]);

  // 按用例分布数据（Top 10）
  const caseData = useMemo(() => {
    if (!statistics?.byCase) return [];
    return Object.entries(statistics.byCase)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [statistics]);

  // 状态分布数据
  const statusData = useMemo(() => {
    if (!statistics) return [];
    return [
      { name: '已确认', value: statistics.confirmed, key: 'confirmed' as const },
      { name: '待确认', value: statistics.pending, key: 'pending' as const },
      { name: '已忽略', value: statistics.ignored, key: 'ignored' as const },
    ].filter((d) => d.value > 0);
  }, [statistics]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        加载图表中...
      </div>
    );
  }

  if (!statistics || statistics.total === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-3 px-3 py-2 lg:grid-cols-2">
      {/* 按子系统分布 */}
      {subsysData.length > 0 && (
        <ChartCard title="按子系统分布">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={subsysData} layout="vertical" margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <YAxis
                type="category"
                dataKey="name"
                width={80}
                tick={{ fontSize: 11 }}
                className="text-muted-foreground"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--background, #1e1e2e)',
                  border: '1px solid var(--border, #3c3c4a)',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
              />
              <Bar
                dataKey="count"
                fill={BAR_COLOR}
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                onClick={(data: { name?: string }) => {
                  if (data?.name && onSubsysClick) onSubsysClick(data.name);
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* 按 Corner 分布 */}
      {cornerData.length > 0 && (
        <ChartCard title="按 Corner 分布">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={cornerData} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={50} className="text-muted-foreground" />
              <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--background, #1e1e2e)',
                  border: '1px solid var(--border, #3c3c4a)',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
              />
              <Bar
                dataKey="count"
                fill={BAR_COLOR_2}
                radius={[4, 4, 0, 0]}
                cursor="pointer"
                onClick={(data: { name?: string }) => {
                  if (data?.name && onCornerClick) onCornerClick(data.name);
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* 按用例分布 Top 10 */}
      {caseData.length > 0 && (
        <ChartCard title="按用例分布 (Top 10)">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={caseData} layout="vertical" margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis type="number" tick={{ fontSize: 11 }} className="text-muted-foreground" />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tick={{ fontSize: 10 }}
                className="text-muted-foreground"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--background, #1e1e2e)',
                  border: '1px solid var(--border, #3c3c4a)',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
              />
              <Bar
                dataKey="count"
                fill={BAR_COLOR}
                radius={[0, 4, 4, 0]}
                cursor="pointer"
                onClick={(data: { name?: string }) => {
                  if (data?.name && onCaseClick) onCaseClick(data.name);
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* 状态分布饼图 */}
      {statusData.length > 0 && (
        <ChartCard title="状态分布">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={statusData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={70}
                label={({ name, value }) => `${name}: ${value}`}
                labelLine={false}
                onClick={(data: { key?: 'confirmed' | 'pending' | 'ignored' }) => {
                  if (data?.key && onStatusClick) onStatusClick(data.key);
                }}
              >
                {statusData.map((entry) => (
                  <Cell
                    key={entry.key}
                    fill={STATUS_COLORS[entry.key]}
                    cursor="pointer"
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--background, #1e1e2e)',
                  border: '1px solid var(--border, #3c3c4a)',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
    </div>
  );
}

// ─── 内部组件 ─────────────────────────────────────────────────

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={cn(
      'rounded-lg border border-border bg-background/50 p-3',
    )}>
      <h4 className="mb-2 text-xs font-semibold text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}
