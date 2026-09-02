/**
 * Token 视图 — Token Monitor 主视图。
 *
 * Issue #1: 概览面板（KPI 卡片 + 时间范围选择器）。
 * Issue #2: 添加趋势图面板 + 引擎分解面板。
 * 后续 issue 逐个添加模型分解 / 会话列表等面板。
 */

import { useState } from 'react';
import { TokenOverviewPanel } from '@renderer/components/token/TokenOverviewPanel';
import { TokenTrendsPanel } from '@renderer/components/token/TokenTrendsPanel';
import { TokenEnginePanel } from '@renderer/components/token/TokenEnginePanel';
import { cn } from '@renderer/lib/utils';

type TokenTab = 'overview' | 'trends' | 'engine';

const TABS: Array<{ id: TokenTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'trends', label: '趋势图' },
  { id: 'engine', label: '引擎分解' },
];

export function TokenView() {
  const [activeTab, setActiveTab] = useState<TokenTab>('overview');

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {/* ─── 标签页 ──────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-border px-4 pt-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`token-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'border-b-2 px-3 py-1.5 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── 面板内容 ────────────────────────────────────── */}
      {activeTab === 'overview' && <TokenOverviewPanel />}
      {activeTab === 'trends' && <TokenTrendsPanel />}
      {activeTab === 'engine' && <TokenEnginePanel />}
    </div>
  );
}
