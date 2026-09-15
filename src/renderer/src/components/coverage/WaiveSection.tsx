/**
 * WaiveSection — CoveragePanel 的「Waive」Tab（docs/coverage_auto_waive.md）。
 *
 * 功能：
 * - detail 已解析后一键生成 .vRefine（可重复生成，每次产生新 runId）
 * - 生成进度面板（coverage:waive-progress 实时步骤）
 * - 生成历史列表（最新在前）：rule 数 / 三类信号计数 / 耗时 / 警告
 * - 历史展开：查看中间产物明细（信号列表 + per-file 统计 + 耗时）
 * - 打开产物目录（系统文件管理器）
 *
 * 前置条件提示：detail 未解析时引导先点「解析 detail 覆盖率」。
 */

import { useEffect } from 'react';
import {
  Loader2, FileText, FolderOpen, Trash2, ChevronDown, ChevronRight,
  ShieldCheck, AlertTriangle, Clock, FileCheck2,
} from 'lucide-react';
import {
  useCoverageCoreStore,
  useCoverageWaiveStore,
} from '@renderer/stores/coverage';
import { cn } from '@renderer/lib/utils';

const KIND_LABELS: Record<string, string> = {
  const_assign: 'assign 固定值',
  input_tie: 'input tie',
  output_floating: 'output 悬空',
};

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function WaiveSection({
  currentProjectId,
  currentSessionId,
}: {
  currentProjectId: string | null;
  currentSessionId: string | null;
}) {
  const detailMetricsParsed = useCoverageCoreStore((s) => s.detailMetricsParsed);

  const generating = useCoverageWaiveStore((s) => s.generating);
  const progress = useCoverageWaiveStore((s) => s.progress);
  const step = useCoverageWaiveStore((s) => s.step);
  const stepLog = useCoverageWaiveStore((s) => s.stepLog);
  const showProgress = useCoverageWaiveStore((s) => s.showProgress);
  const history = useCoverageWaiveStore((s) => s.history);
  const historyLoading = useCoverageWaiveStore((s) => s.historyLoading);
  const expandedRunId = useCoverageWaiveStore((s) => s.expandedRunId);
  const expandedAnalysis = useCoverageWaiveStore((s) => s.expandedAnalysis);
  const analysisLoading = useCoverageWaiveStore((s) => s.analysisLoading);
  const generateWaive = useCoverageWaiveStore((s) => s.generateWaive);
  const loadHistory = useCoverageWaiveStore((s) => s.loadHistory);
  const deleteHistoryEntry = useCoverageWaiveStore((s) => s.deleteHistoryEntry);
  const toggleExpand = useCoverageWaiveStore((s) => s.toggleExpand);
  const openWaiveDir = useCoverageWaiveStore((s) => s.openWaiveDir);
  const registerProgressListener = useCoverageWaiveStore((s) => s.registerProgressListener);
  const clearProgress = useCoverageWaiveStore((s) => s.clearProgress);

  // 注册 coverage:waive-progress IPC 监听（幂等）+ 加载历史
  useEffect(() => {
    registerProgressListener();
  }, [registerProgressListener]);
  useEffect(() => {
    if (currentProjectId) loadHistory(currentProjectId);
  }, [currentProjectId, loadHistory]);

  const handleGenerate = async () => {
    if (!currentProjectId || !currentSessionId) return;
    await generateWaive(currentProjectId, currentSessionId);
  };

  // 前置条件：detail.txt 未解析
  if (!detailMetricsParsed) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8" data-testid="waive-need-detail">
        <AlertTriangle className="h-6 w-6 text-yellow-500/70" />
        <p className="text-xs text-muted-foreground">需要先解析 detail 覆盖率</p>
        <p className="text-[10px] text-muted-foreground/70">
          点击工具栏「解析 detail 覆盖率」生成 instance 级明细（waive 自动生成的基础数据）
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 说明 + 生成按钮 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-[10px] leading-relaxed text-muted-foreground">
          静态分析 RTL 源码，识别结构性不可覆盖信号（assign 固定值 / input tie 常量 / output 悬空），
          生成 Cadence 兼容的 <span className="font-mono">.vRefine</span> 排除文件。
          产物与中间明细（信号列表 / 分析日志）写入
          <span className="font-mono"> .socverify/coverage/waive/&lt;runId&gt;/</span>，可重复生成。
        </div>
        <button
          onClick={handleGenerate}
          disabled={!currentProjectId || !currentSessionId || generating}
          className="flex shrink-0 items-center gap-1 rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
          data-testid="waive-generate-button"
          title="RTL 静态分析 → 生成 .vRefine 排除文件"
        >
          {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
          {generating ? '生成中...' : '生成 waive 文件'}
        </button>
      </div>

      {/* 生成进度面板 */}
      {showProgress && (
        <div className="rounded border border-primary/40 bg-primary/5 p-2" data-testid="waive-progress-panel">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span className="flex-1">{step}</span>
            <span className="text-[10px] text-muted-foreground">{progress}%</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
              data-testid="waive-progress-bar"
            />
          </div>
          {stepLog.length > 0 && (
            <div className="mt-1.5 max-h-28 space-y-0.5 overflow-auto font-mono text-[10px] text-muted-foreground">
              {stepLog.map((l, i) => (
                <div key={i}>
                  <span className="text-muted-foreground/60">[{new Date(l.timestamp).toLocaleTimeString()}]</span>{' '}
                  {l.message}
                  {l.durationMs !== undefined && l.durationMs > 0 ? ` (${l.durationMs}ms)` : ''}
                </div>
              ))}
            </div>
          )}
          {!generating && (
            <button
              onClick={clearProgress}
              className="mt-1.5 flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-secondary"
            >
              关闭
            </button>
          )}
        </div>
      )}

      {/* 历史记录列表 */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs font-medium">生成历史</span>
          <span className="text-[10px] text-muted-foreground">{history.length} 条</span>
          {currentProjectId && (
            <button
              onClick={() => openWaiveDir(currentProjectId)}
              className="flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[10px] hover:bg-secondary"
              title="打开 .socverify/coverage/waive 目录"
              data-testid="waive-open-dir"
            >
              <FolderOpen className="h-3 w-3" />
              打开目录
            </button>
          )}
        </div>
        {historyLoading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
          </div>
        ) : history.length === 0 ? (
          <div className="py-4 text-center text-[10px] text-muted-foreground">
            暂无生成记录——点击上方「生成 waive 文件」开始
          </div>
        ) : (
          <div className="overflow-hidden rounded border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-secondary/50 text-[10px] text-muted-foreground">
                  <th className="px-2 py-1 text-left">Run</th>
                  <th className="px-2 py-1 text-left">Session</th>
                  <th className="px-2 py-1 text-right">Rule 数</th>
                  <th className="px-2 py-1 text-right">assign / tie / floating</th>
                  <th className="px-2 py-1 text-right">耗时</th>
                  <th className="px-2 py-1 text-right">生成时间</th>
                  <th className="px-2 py-1 text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <WaiveHistoryRow
                    key={entry.runId}
                    entry={entry}
                    expanded={expandedRunId === entry.runId}
                    analysis={expandedRunId === entry.runId ? expandedAnalysis : null}
                    analysisLoading={analysisLoading && expandedRunId === entry.runId}
                    onToggle={() => currentProjectId && toggleExpand(currentProjectId, entry.runId)}
                    onOpen={() => currentProjectId && openWaiveDir(currentProjectId, entry.runId)}
                    onDelete={() => currentProjectId && deleteHistoryEntry(currentProjectId, entry.runId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── 历史行（含展开的中间产物明细） ────────────────────────────

function WaiveHistoryRow({
  entry,
  expanded,
  analysis,
  analysisLoading,
  onToggle,
  onOpen,
  onDelete,
}: {
  entry: import('@shared/types').WaiveHistoryEntry;
  expanded: boolean;
  analysis: import('@shared/types').WaiveAnalysisData | null;
  analysisLoading: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <tr className={cn('border-b border-border/50 hover:bg-secondary/30', expanded && 'bg-secondary/30')}>
        <td className="px-2 py-1">
          <button
            onClick={onToggle}
            className="flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
            data-testid={`waive-history-expand-${entry.runId}`}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {entry.runId}
          </button>
        </td>
        <td className="px-2 py-1 font-mono text-[10px]">{entry.sessionId}</td>
        <td className="px-2 py-1 text-right font-mono" data-testid={`waive-history-rules-${entry.runId}`}>
          {entry.ruleCount}
        </td>
        <td className="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
          {entry.signalCounts.const_assign} / {entry.signalCounts.input_tie} / {entry.signalCounts.output_floating}
        </td>
        <td className="px-2 py-1 text-right font-mono text-[10px]">
          {entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`}
        </td>
        <td className="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
          {formatTime(entry.generatedAt)}
        </td>
        <td className="px-2 py-1 text-center">
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={onOpen}
              className="rounded border border-border p-0.5 hover:bg-secondary"
              title="在文件管理器中显示 .vRefine"
              data-testid={`waive-history-open-${entry.runId}`}
            >
              <FileText className="h-3 w-3" />
            </button>
            <button
              onClick={onDelete}
              className="rounded border border-border p-0.5 text-destructive hover:bg-destructive/10"
              title="删除此记录及产物目录"
              data-testid={`waive-history-delete-${entry.runId}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50">
          <td colSpan={7} className="bg-secondary/20 px-3 py-2">
            {analysisLoading ? (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> 加载明细...
              </div>
            ) : analysis ? (
              <WaiveAnalysisDetail analysis={analysis} />
            ) : (
              <div className="text-[10px] text-muted-foreground">
                明细不可用（waive-analysis.json 缺失或已删除）
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── 展开的中间产物明细（waive-analysis.json 视图） ───────────

function WaiveAnalysisDetail({
  analysis,
}: {
  analysis: import('@shared/types').WaiveAnalysisData;
}) {
  return (
    <div className="space-y-2" data-testid="waive-analysis-detail">
      {/* 概要 */}
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span><FileCheck2 className="mr-1 inline h-3 w-3" />{analysis.instanceCount} instances / {analysis.fileCount} 文件</span>
        <span><Clock className="mr-1 inline h-3 w-3" />
          RTL 扫描 {analysis.timings.rtlScanMs}ms · XML {analysis.timings.xmlRenderMs}ms · 总 {analysis.timings.totalMs}ms
        </span>
        {analysis.droppedOutOfRange > 0 && (
          <span className="text-yellow-600">越界丢弃 {analysis.droppedOutOfRange}</span>
        )}
      </div>

      {/* 警告（截断展示） */}
      {analysis.warnings.length > 0 && (
        <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-1.5">
          <div className="mb-1 flex items-center gap-1 text-[10px] text-yellow-600">
            <AlertTriangle className="h-3 w-3" />
            {analysis.warnings.length} 条警告（前 5 条）
          </div>
          <div className="max-h-20 overflow-auto font-mono text-[10px] text-yellow-700">
            {analysis.warnings.slice(0, 5).map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        </div>
      )}

      {/* 信号明细（前 50 条 + 总数） */}
      <div>
        <div className="mb-1 text-[10px] font-medium">
          识别信号（{analysis.signals.length} 个，展示前 50）
        </div>
        <div className="max-h-44 overflow-auto rounded border border-border">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-muted-foreground">
                <th className="px-1.5 py-0.5 text-left">类型</th>
                <th className="px-1.5 py-0.5 text-left">层级路径.信号</th>
                <th className="px-1.5 py-0.5 text-left">tie 值</th>
                <th className="px-1.5 py-0.5 text-left">位置</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {analysis.signals.slice(0, 50).map((sig, i) => (
                <tr key={i} className="border-b border-border/30">
                  <td className="px-1.5 py-0.5">{KIND_LABELS[sig.kind]}</td>
                  <td className="px-1.5 py-0.5">
                    <span className="text-primary">{sig.hier}</span>
                    {sig.hier ? '.' : ''}{sig.signal}
                  </td>
                  <td className="px-1.5 py-0.5">{sig.tieValue || '—'}</td>
                  <td className="px-1.5 py-0.5 text-muted-foreground" title={sig.file}>
                    {sig.file.split('/').pop()}:{sig.line}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* per-file 统计 */}
      <div>
        <div className="mb-1 text-[10px] font-medium">文件统计（{analysis.fileStats.length}）</div>
        <div className="max-h-28 overflow-auto rounded border border-border">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-muted-foreground">
                <th className="px-1.5 py-0.5 text-left">文件</th>
                <th className="px-1.5 py-0.5 text-right">instances</th>
                <th className="px-1.5 py-0.5 text-right">信号</th>
                <th className="px-1.5 py-0.5 text-left">警告</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {analysis.fileStats.map((f, i) => (
                <tr key={i} className="border-b border-border/30">
                  <td className="px-1.5 py-0.5" title={f.file}>{f.file}</td>
                  <td className="px-1.5 py-0.5 text-right">{f.instanceCount}</td>
                  <td className="px-1.5 py-0.5 text-right">{f.signalCount}</td>
                  <td className="px-1.5 py-0.5 text-yellow-600">{f.warning ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
