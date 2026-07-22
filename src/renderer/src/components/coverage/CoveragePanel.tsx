/**
 * CoveragePanel — Slice 1 Tracer Bullet 极简 UI。
 *
 * 证明端到端通路：导入对话框 + Session 选择器 + 扁平模块列表（line coverage）。
 * 完整双视图（树表格 + 仪表盘）在 Slice 3/4 实现。
 */
import { useEffect, useState } from 'react';
import { Loader2, BarChart3, Upload, ChevronDown, ChevronUp } from 'lucide-react';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type { CoverageNode, EdaTool } from '@shared/types';
import { COVERAGE_METRICS } from '@shared/types';

const EDA_TOOL_OPTIONS: Array<{ value: EdaTool; label: string }> = [
  { value: 'imc', label: 'Cadence IMC' },
  { value: 'vcs-urg', label: 'Synopsys VCS urg' },
  { value: 'vcover', label: 'Mentor Questa vcover' },
  { value: 'unknown', label: '未知/其他' },
];

/** 收集树中所有节点为扁平列表（tracer bullet：仅显示 line coverage） */
function flattenTree(node: CoverageNode, out: Array<{ node: CoverageNode }> = []): Array<{ node: CoverageNode }> {
  out.push({ node });
  for (const child of node.children) flattenTree(child, out);
  return out;
}

function pct(n: number | null): string {
  return n === null ? 'N/A' : `${n.toFixed(1)}%`;
}

export function CoveragePanel() {
  const sessions = useCoverageStore((s) => s.sessions);
  const currentSessionId = useCoverageStore((s) => s.currentSessionId);
  const tree = useCoverageStore((s) => s.tree);
  const overview = useCoverageStore((s) => s.overview);
  const loading = useCoverageStore((s) => s.loading);
  const importing = useCoverageStore((s) => s.importing);
  const edaConfig = useCoverageStore((s) => s.edaConfig);
  const loadSessions = useCoverageStore((s) => s.loadSessions);
  const loadTree = useCoverageStore((s) => s.loadTree);
  const loadEdaConfig = useCoverageStore((s) => s.loadEdaConfig);
  const importCoverage = useCoverageStore((s) => s.importCoverage);
  const setSessionId = useCoverageStore((s) => s.setSessionId);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [showImport, setShowImport] = useState(false);
  const [covMergeDir, setCovMergeDir] = useState('');
  const [edaTool, setEdaTool] = useState<EdaTool>('imc');
  const [expandedRoot, setExpandedRoot] = useState(true);

  useEffect(() => {
    if (currentProjectId) {
      loadSessions(currentProjectId);
      loadEdaConfig(currentProjectId);
    }
  }, [currentProjectId, loadSessions, loadEdaConfig]);

  useEffect(() => {
    if (currentProjectId && currentSessionId) {
      loadTree(currentProjectId, currentSessionId);
    } else if (currentProjectId && sessions.length > 0 && !currentSessionId) {
      loadTree(currentProjectId);
    }
  }, [currentProjectId, currentSessionId, loadTree, sessions.length]);

  const handleImport = async () => {
    if (!currentProjectId || !covMergeDir.trim()) return;
    const sid = await importCoverage(currentProjectId, covMergeDir.trim(), {
      tool: edaTool,
      covMergeDir: covMergeDir.trim(),
    });
    if (sid) {
      setShowImport(false);
      setCovMergeDir('');
    }
  };

  if (loading && !tree) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">加载覆盖率数据...</span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      {/* 工具栏：Session 选择 + 导入按钮 */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Session:</span>
        <select
          value={currentSessionId ?? ''}
          onChange={(e) => setSessionId(e.target.value || null)}
          className="bg-card border border-border rounded px-2 py-1 text-xs"
        >
          {sessions.length === 0 && <option value="">无 session</option>}
          {sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.sessionId} ({s.edaTool})
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowImport(!showImport)}
          className="ml-auto flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs hover:bg-secondary"
        >
          <Upload className="h-3 w-3" />
          导入覆盖率
        </button>
      </div>

      {/* 导入对话框 */}
      {showImport && (
        <div className="mb-3 rounded border border-border bg-card p-3">
          <div className="mb-2 text-xs font-medium">导入覆盖率数据</div>
          <div className="flex flex-col gap-2">
            <label className="text-[10px] text-muted-foreground">
              cov_merge 目录路径
              <input
                type="text"
                value={covMergeDir}
                onChange={(e) => setCovMergeDir(e.target.value)}
                placeholder="例如 cov_merge 或 /abs/path/to/covdb"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              />
            </label>
            <label className="text-[10px] text-muted-foreground">
              EDA 工具
              <select
                value={edaTool}
                onChange={(e) => setEdaTool(e.target.value as EdaTool)}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              >
                {EDA_TOOL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowImport(false)}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
              >
                取消
              </button>
              <button
                onClick={handleImport}
                disabled={!covMergeDir.trim() || importing}
                className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
              >
                {importing ? '导入中...' : '导入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {edaConfig && (
        <div className="mb-2 text-[10px] text-muted-foreground">
          EDA 配置: {edaConfig.tool} · cov_merge: {edaConfig.covMergeDir}
        </div>
      )}

      {!tree && !loading && (
        <div className="flex flex-col items-center justify-center gap-2 py-8">
          <BarChart3 className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">暂无覆盖率数据</p>
          <p className="text-[10px] text-muted-foreground/70">点击「导入覆盖率」开始，或确保已加载 coverage-parser 插件</p>
        </div>
      )}

      {/* 概览卡片行（8 metric，tracer bullet 简化版） */}
      {overview && (
        <div className="mb-3 grid grid-cols-4 gap-2">
          {COVERAGE_METRICS.map((m) => {
            const v = overview[m];
            return (
              <div key={m} className="rounded border border-border bg-card p-2">
                <div className="text-[10px] text-muted-foreground">{m}</div>
                <div className="font-mono text-sm font-bold">{pct(v)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* 扁平模块列表（tracer bullet：仅 line coverage） */}
      {tree && (
        <div className="rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-elevated text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">模块</th>
                <th className="px-2 py-1 text-right">Line</th>
                <th className="px-2 py-1 text-right">Branch</th>
                <th className="px-2 py-1 text-right">Toggle</th>
                <th className="px-2 py-1 text-right">Functional</th>
                <th className="px-2 py-1 text-right">Assertion</th>
              </tr>
            </thead>
            <tbody>
              {flattenTree(tree.root).map(({ node }, idx) => {
                const isRoot = node.depth === 0;
                return (
                  <tr
                    key={`${node.path}-${idx}`}
                    className={cn('border-t border-border', isRoot && 'bg-card font-medium')}
                  >
                    <td className="px-2 py-1" style={{ paddingLeft: `${8 + node.depth * 14}px` }}>
                      {isRoot ? (
                        <button
                          onClick={() => setExpandedRoot(!expandedRoot)}
                          className="flex items-center gap-1"
                        >
                          {expandedRoot ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          {node.name}
                        </button>
                      ) : (
                        node.name
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{pct(node.metrics.line.percentage)}</td>
                    <td className="px-2 py-1 text-right font-mono">{pct(node.metrics.branch.percentage)}</td>
                    <td className="px-2 py-1 text-right font-mono">{pct(node.metrics.toggle.percentage)}</td>
                    <td className="px-2 py-1 text-right font-mono">{pct(node.metrics.functional.percentage)}</td>
                    <td className="px-2 py-1 text-right font-mono">{pct(node.metrics.assertion.percentage)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
