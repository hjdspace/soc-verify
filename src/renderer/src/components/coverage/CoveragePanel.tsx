import { useEffect, useState } from 'react';
import { Loader2, BarChart3, TrendingUp, FileDown, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { CoverageSummary, CoverageType } from '@shared/types';

const COVERAGE_TYPES: Array<{ key: CoverageType; label: string; color: string }> = [
  { key: 'line', label: '行覆盖率', color: 'bg-blue-500' },
  { key: 'toggle', label: '翻转覆盖率', color: 'bg-green-500' },
  { key: 'functional', label: '功能覆盖率', color: 'bg-purple-500' },
  { key: 'assertion', label: '断言覆盖率', color: 'bg-orange-500' },
];

export function CoveragePanel() {
  const overview = useCoverageStore((s) => s.overview);
  const subsysCoverage = useCoverageStore((s) => s.subsysCoverage);
  const loading = useCoverageStore((s) => s.loading);
  const loadOverview = useCoverageStore((s) => s.loadOverview);
  const loadBySubsys = useCoverageStore((s) => s.loadBySubsys);
  const loadCachedRuns = useCoverageStore((s) => s.loadCachedRuns);
  const cachedRuns = useCoverageStore((s) => s.cachedRuns);
  const currentRunId = useCoverageStore((s) => s.currentRunId);
  const setRunId = useCoverageStore((s) => s.setRunId);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.currentProjectId),
  );
  const [trend, setTrend] = useState<Array<{ runId: string; timestamp: number; summary: CoverageSummary }> | null>(null);
  const [uncovered, setUncovered] = useState<Array<{ file: string; line?: number; signal?: string; description: string }> | null>(null);
  const [uncoveredType, setUncoveredType] = useState<CoverageType>('line');
  const [showUncovered, setShowUncovered] = useState(false);
  const [exportPath, setExportPath] = useState('');
  const [expandedSubsys, setExpandedSubsys] = useState<string | null>(null);

  useEffect(() => {
    if (currentProjectId) {
      loadOverview(currentProjectId);
      loadBySubsys(currentProjectId);
      loadCachedRuns(currentProjectId);
    }
  }, [currentProjectId, loadOverview, loadBySubsys, loadCachedRuns]);

  // Load trend
  useEffect(() => {
    if (!currentProjectId) return;
    trpc.coverage.getTrend.query({ projectId: currentProjectId, limit: 10 })
      .then((data) => setTrend(data as Array<{ runId: string; timestamp: number; summary: CoverageSummary }>))
      .catch(() => setTrend(null));
  }, [currentProjectId]);

  // Load uncovered
  useEffect(() => {
    if (!currentProjectId || !currentRunId) return;
    trpc.coverage.getUncovered.query({ projectId: currentProjectId, runId: currentRunId, type: uncoveredType })
      .then((data) => setUncovered(data as Array<{ file: string; line?: number; signal?: string; description: string }>))
      .catch(() => setUncovered(null));
  }, [currentProjectId, currentRunId, uncoveredType]);

  const handleExport = async () => {
    if (!currentProjectId || !currentRunId || !exportPath.trim()) return;
    const path = exportPath.trim().includes('.') ? exportPath.trim() : `${exportPath.trim()}/coverage-report.html`;
    try {
      await trpc.coverage.exportReport.mutate({ projectId: currentProjectId, runId: currentRunId, format: 'html', outputPath: path });
      setExportPath('');
    } catch {
      // Error handled by toast in store
    }
  };

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">加载覆盖率数据...</span>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8">
        <BarChart3 className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">无法加载覆盖率数据</p>
        <p className="text-[10px] text-muted-foreground/70">请确保已加载 coverage-parser 插件</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      {/* Run selector */}
      {cachedRuns.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">运行:</span>
          <select
            value={currentRunId ?? ''}
            onChange={(e) => {
              setRunId(e.target.value || null);
              if (currentProjectId) {
                loadOverview(currentProjectId, e.target.value || undefined);
                loadBySubsys(currentProjectId, e.target.value || undefined);
              }
            }}
            className="rounded border border-border bg-background px-2 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">最新</option>
            {cachedRuns.map((r) => (
              <option key={r} value={r}>{r.slice(-8)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Overview cards */}
      <div className="mb-4">
        <div className="mb-2 text-xs font-semibold">覆盖率概览</div>
        <div className="grid grid-cols-2 gap-2">
          {COVERAGE_TYPES.map((ct) => (
            <CoverageCard key={ct.key} label={ct.label} value={overview[ct.key]} color={ct.color} />
          ))}
        </div>
      </div>

      {/* Overall bar */}
      <div className="mb-4">
        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
          <span>总体覆盖率</span>
          <span className="font-mono font-semibold">{overview.overall.toFixed(1)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${overview.overall}%` }} />
        </div>
      </div>

      {/* Trend chart */}
      {trend && trend.length > 1 && (
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">覆盖率趋势</span>
          </div>
          <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
            <TrendChart trend={trend} />
          </div>
        </div>
      )}

      {/* By subsystem */}
      {subsysCoverage.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold">按子系统分布</div>
          <div className="space-y-1.5">
            {subsysCoverage.map((s) => (
              <div key={s.subsys} className="rounded border border-border/50">
                <button
                  onClick={() => setExpandedSubsys(expandedSubsys === s.subsys ? null : s.subsys)}
                  className="flex w-full items-center justify-between px-2 py-1.5"
                >
                  <div className="flex items-center gap-1">
                    {expandedSubsys === s.subsys ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
                    <span className="text-xs font-medium">{s.subsys}</span>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">{s.summary.overall.toFixed(1)}%</span>
                </button>
                <div className="px-2 pb-1.5">
                  <div className="flex gap-1">
                    {COVERAGE_TYPES.map((ct) => (
                      <div key={ct.key} className="flex-1" title={`${ct.label}: ${s.summary[ct.key].toFixed(1)}%`}>
                        <div className="h-1 overflow-hidden rounded-full bg-muted">
                          <div className={cn('h-full rounded-full', ct.color)} style={{ width: `${s.summary[ct.key]}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {expandedSubsys === s.subsys && (
                    <div className="mt-1.5 grid grid-cols-4 gap-1 text-[10px]">
                      {COVERAGE_TYPES.map((ct) => (
                        <div key={ct.key}>
                          <span className="text-muted-foreground">{ct.label}</span>
                          <div className="font-mono">{s.summary[ct.key].toFixed(1)}%</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Uncovered items */}
      {currentRunId && (
        <div className="mb-4">
          <button
            onClick={() => setShowUncovered(!showUncovered)}
            className="mb-2 flex items-center gap-1.5"
          >
            <AlertCircle className="h-3.5 w-3.5 text-orange-500" />
            <span className="text-xs font-semibold">未覆盖项</span>
            {showUncovered ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {showUncovered && (
            <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
              <div className="mb-2 flex gap-1">
                {COVERAGE_TYPES.map((ct) => (
                  <button
                    key={ct.key}
                    onClick={() => setUncoveredType(ct.key)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[10px] transition-colors',
                      uncoveredType === ct.key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {ct.label}
                  </button>
                ))}
              </div>
              {uncovered === null ? (
                <p className="text-[10px] text-muted-foreground">加载中...</p>
              ) : uncovered.length === 0 ? (
                <p className="text-[10px] text-green-500">全部覆盖！</p>
              ) : (
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {uncovered.slice(0, 50).map((item, i) => (
                    <div key={i} className="truncate font-mono text-[10px] text-muted-foreground">
                      {item.file}{item.line != null ? `:${item.line}` : ''} {item.signal ? `[${item.signal}]` : ''} {item.description}
                    </div>
                  ))}
                  {uncovered.length > 50 && (
                    <div className="text-[10px] text-muted-foreground/70">...还有 {uncovered.length - 50} 项</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Export report */}
      {currentRunId && (
        <div className="rounded-md border border-border/50 bg-secondary/20 p-2">
          <div className="mb-1 text-[10px] font-semibold text-muted-foreground">导出报告</div>
          <div className="flex gap-1">
            <input
              type="text"
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
              placeholder={currentProject ? `${currentProject.rootPath}/coverage-report.html` : '输出路径'}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={handleExport}
              disabled={!exportPath.trim()}
              className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
            >
              <FileDown className="h-3 w-3" />
              导出
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded border border-border/50 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1.5">
        <div className={cn('h-2 w-2 rounded-full', color)} />
        <span className="text-sm font-mono font-semibold">{value.toFixed(1)}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function TrendChart({ trend }: { trend: Array<{ runId: string; timestamp: number; summary: CoverageSummary }> }) {
  const maxVal = 100;
  const width = 100; // percentage based
  const height = 60;

  if (trend.length < 2) return null;

  const points = trend.map((t, i) => ({
    x: (i / (trend.length - 1)) * width,
    y: height - (t.summary.overall / maxVal) * height,
    val: t.summary.overall,
    ts: t.timestamp,
  }));

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: `${height}px` }} preserveAspectRatio="none">
        {/* Grid lines */}
        {[0, 25, 50, 75, 100].map((v) => (
          <line key={v} x1="0" y1={height - (v / 100) * height} x2={width} y2={height - (v / 100) * height} stroke="currentColor" strokeWidth="0.2" className="text-muted-foreground/20" />
        ))}
        {/* Trend line */}
        <path d={pathD} fill="none" stroke="currentColor" strokeWidth="1" className="text-primary" />
        {/* Points */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="0.8" fill="currentColor" className="text-primary" />
        ))}
      </svg>
      <div className="flex justify-between text-[8px] text-muted-foreground">
        <span>{trend[0] ? new Date(trend[0].timestamp).toLocaleDateString() : ''}</span>
        <span>{trend[trend.length - 1] ? new Date(trend[trend.length - 1].timestamp).toLocaleDateString() : ''}</span>
      </div>
      <div className="absolute right-0 top-0 text-[10px] font-mono text-primary">
        {trend[trend.length - 1]?.summary.overall.toFixed(1)}%
      </div>
    </div>
  );
}
