/**
 * Token 视图 — Token Monitor 主视图。
 *
 * Issue #1: 概览面板（KPI 卡片 + 时间范围选择器）。
 * Issue #2: 添加趋势图面板 + 引擎分解面板。
 * Issue #3: 添加模型分解面板。
 * Issue #4: 添加会话列表面板。
 * Issue #5: 添加外部日志刷新按钮 + 视图打开自动扫描。
 */

import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { TokenOverviewPanel } from '@renderer/components/token/TokenOverviewPanel';
import { TokenTrendsPanel } from '@renderer/components/token/TokenTrendsPanel';
import { TokenEnginePanel } from '@renderer/components/token/TokenEnginePanel';
import { TokenModelPanel } from '@renderer/components/token/TokenModelPanel';
import { TokenSessionPanel } from '@renderer/components/token/TokenSessionPanel';
import { cn } from '@renderer/lib/utils';
import { useTokenStore } from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';

type TokenTab = 'overview' | 'trends' | 'engine' | 'model' | 'sessions';

const TABS: Array<{ id: TokenTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'trends', label: '趋势图' },
  { id: 'engine', label: '引擎分解' },
  { id: 'model', label: '模型分解' },
  { id: 'sessions', label: '会话列表' },
];

export function TokenView() {
  const [activeTab, setActiveTab] = useState<TokenTab>('overview');
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const scanLoading = useTokenStore((s) => s.scanLoading);
  const scanExternalLogs = useTokenStore((s) => s.scanExternalLogs);
  const lastScanAt = useTokenStore((s) => s.lastScanAt);

  // 视图打开时自动扫描外部日志（仅一次）
  // Issue #5 验收标准：距上次扫描超过 1 分钟才触发即时扫描
  useEffect(() => {
    if (currentProjectId) {
      const now = Date.now();
      const ONE_MINUTE_MS = 60 * 1000;
      if (lastScanAt === null || now - lastScanAt > ONE_MINUTE_MS) {
        void scanExternalLogs(currentProjectId);
      }
    }
    // 仅在组件首次挂载时执行 — currentProjectId 不变时不重复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    if (currentProjectId && !scanLoading) {
      void scanExternalLogs(currentProjectId);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {/* ─── 标签页 + 刷新按钮 ─────────────────────────────── */}
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

        {/* 靠右的刷新按钮 */}
        <div className="ml-auto" />
        <button
          type="button"
          data-testid="token-scan-external-logs"
          onClick={handleRefresh}
          disabled={scanLoading || !currentProjectId}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            scanLoading && 'cursor-wait opacity-60',
          )}
          title="扫描 claude-code / codex 外部日志"
        >
          <RefreshCw className={cn('h-3 w-3', scanLoading && 'animate-spin')} />
          刷新外部日志
        </button>
      </div>

      {/* ─── 面板内容 ────────────────────────────────────── */}
      {activeTab === 'overview' && <TokenOverviewPanel />}
      {activeTab === 'trends' && <TokenTrendsPanel />}
      {activeTab === 'engine' && <TokenEnginePanel />}
      {activeTab === 'model' && <TokenModelPanel />}
      {activeTab === 'sessions' && <TokenSessionPanel />}
    </div>
  );
}
