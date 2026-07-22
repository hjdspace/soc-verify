/**
 * CoveragePanel — Slice 2 完整覆盖率数据模型与会话生命周期 UI。
 *
 * 5 个 Tab：
 *   1. 概览 — 8 metric Coverage Triplet（percentage + covered/total）+ 模块层级表（8 metric）
 *   2. 目标 — 7 metric 行业默认目标 + 项目级覆盖；assertion 无默认目标
 *   3. 缺口 — 自动检测 Gap + 手动 Triage 标注（5 根因 × 3 置信度）
 *   4. 排除 — Exclusion 工作流（请求 / 审批 / 驳回，不可自动排除）
 *   5. 对比 — 两个 Session 之间逐 metric Delta
 *
 * 完整树表格 / 仪表盘 UI 在 Slice 3 / Slice 4 实现。
 */
import { useEffect, useState } from 'react';
import {
  Loader2, BarChart3, Upload, ChevronDown, ChevronRight,
  Target as TargetIcon, AlertTriangle, ShieldBan, GitCompare, Trash2, Plus,
} from 'lucide-react';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type {
  CoverageNode, EdaTool, CoverageMetric, CoverageGap, CoverageTriplet,
  TriageCause, TriageConfidence,
} from '@shared/types';
import { COVERAGE_METRICS, DEFAULT_COVERAGE_TARGETS } from '@shared/types';

const EDA_TOOL_OPTIONS: Array<{ value: EdaTool; label: string }> = [
  { value: 'imc', label: 'Cadence IMC' },
  { value: 'vcs-urg', label: 'Synopsys VCS urg' },
  { value: 'vcover', label: 'Mentor Questa vcover' },
  { value: 'unknown', label: '未知/其他' },
];

const METRIC_LABELS: Record<CoverageMetric, string> = {
  line: 'Line',
  branch: 'Branch',
  toggle: 'Toggle',
  condition: 'Condition',
  fsm_state: 'FSM State',
  fsm_transition: 'FSM Trans',
  functional: 'Functional',
  assertion: 'Assertion',
};

const TRIAGE_CAUSES: Array<{ value: TriageCause; label: string }> = [
  { value: 'missing_scenario', label: '缺失场景' },
  { value: 'wrong_config', label: '配置错误' },
  { value: 'dead_code', label: '死代码' },
  { value: 'sampling_issue', label: '采样问题' },
  { value: 'encoding_mismatch', label: '编码不匹配' },
];

const TRIAGE_CONFIDENCES: Array<{ value: TriageConfidence; label: string }> = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
];

type Tab = 'overview' | 'targets' | 'gaps' | 'exclusions' | 'delta';

const TABS: Array<{ id: Tab; label: string; icon: typeof BarChart3 }> = [
  { id: 'overview', label: '概览', icon: BarChart3 },
  { id: 'targets', label: '目标', icon: TargetIcon },
  { id: 'gaps', label: '缺口', icon: AlertTriangle },
  { id: 'exclusions', label: '排除', icon: ShieldBan },
  { id: 'delta', label: '对比', icon: GitCompare },
];

function pct(n: number | null): string {
  return n === null ? 'N/A' : `${n.toFixed(1)}%`;
}

function tripletStr(t: CoverageTriplet): string {
  if (t.percentage === null) return 'N/A';
  return `${t.covered ?? '?'}/${t.total ?? '?'}`;
}

/** 收集树中所有节点为扁平列表 */
function flattenTree(node: CoverageNode, out: CoverageNode[] = []): CoverageNode[] {
  out.push(node);
  for (const child of node.children) flattenTree(child, out);
  return out;
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
  const deleteSession = useCoverageStore((s) => s.deleteSession);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [tab, setTab] = useState<Tab>('overview');
  const [showImport, setShowImport] = useState(false);
  const [covMergeDir, setCovMergeDir] = useState('');
  const [edaTool, setEdaTool] = useState<EdaTool>('imc');
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const handleDelete = async () => {
    if (!currentProjectId || !currentSessionId) return;
    const ok = await deleteSession(currentProjectId, currentSessionId);
    if (ok) setConfirmDelete(false);
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
      {/* 工具栏：Session 选择 + 导入 + 删除 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
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
          className="flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs hover:bg-secondary"
        >
          <Upload className="h-3 w-3" />
          导入
        </button>
        {currentSessionId && (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs text-destructive hover:bg-secondary"
          >
            <Trash2 className="h-3 w-3" />
            删除
          </button>
        )}
        {edaConfig && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            EDA: {edaConfig.tool} · cov_merge: {edaConfig.covMergeDir}
          </span>
        )}
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

      {/* 删除确认 */}
      {confirmDelete && currentSessionId && (
        <div className="mb-3 rounded border border-destructive/50 bg-destructive/10 p-3">
          <div className="mb-2 text-xs">确认删除 session <span className="font-mono">{currentSessionId}</span>？此操作不可撤销。</div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
            >
              取消
            </button>
            <button
              onClick={handleDelete}
              className="rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground"
            >
              删除
            </button>
          </div>
        </div>
      )}

      {!tree && !loading && (
        <div className="flex flex-col items-center justify-center gap-2 py-8">
          <BarChart3 className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">暂无覆盖率数据</p>
          <p className="text-[10px] text-muted-foreground/70">点击「导入」开始，或确保已加载 coverage-parser 插件</p>
        </div>
      )}

      {/* Tab 导航 */}
      {tree && (
        <>
          <div className="mb-3 flex gap-1 border-b border-border">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex items-center gap-1 border-b-2 px-3 py-1.5 text-xs transition-colors',
                    tab === t.id
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'overview' && <OverviewSection overview={overview} tree={tree} />}
          {tab === 'targets' && <TargetsSection currentProjectId={currentProjectId} currentSessionId={currentSessionId} />}
          {tab === 'gaps' && <GapsSection currentProjectId={currentProjectId} currentSessionId={currentSessionId} />}
          {tab === 'exclusions' && <ExclusionsSection currentProjectId={currentProjectId} currentSessionId={currentSessionId} />}
          {tab === 'delta' && <DeltaSection currentProjectId={currentProjectId} sessions={sessions} />}
        </>
      )}
    </div>
  );
}

// ─── 概览 Tab：8 metric Triplet 卡片 + 模块层级表 ───────────────

function OverviewSection({
  overview,
  tree,
}: {
  overview: ReturnType<typeof useCoverageStore.getState>['overview'];
  tree: NonNullable<ReturnType<typeof useCoverageStore.getState>['tree']>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set([tree.root.path]));

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  return (
    <div className="space-y-3">
      {/* 8 metric Triplet 卡片 */}
      {overview && (
        <div className="grid grid-cols-4 gap-2">
          {COVERAGE_METRICS.map((m) => {
            const v = overview[m];
            const nodeMetric = tree.root.metrics[m];
            return (
              <div key={m} className="rounded border border-border bg-card p-2">
                <div className="text-[10px] text-muted-foreground">{METRIC_LABELS[m]}</div>
                <div className="font-mono text-sm font-bold">{pct(v)}</div>
                <div className="font-mono text-[10px] text-muted-foreground">{tripletStr(nodeMetric)}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* 模块层级表（8 metric） */}
      <div className="rounded border border-border">
        <table className="w-full text-xs">
          <thead className="bg-secondary text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left">模块</th>
              {COVERAGE_METRICS.map((m) => (
                <th key={m} className="px-2 py-1 text-right">{METRIC_LABELS[m]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {flattenTree(tree.root).map((node, idx) => {
              const isRoot = node.depth === 0;
              const hasChildren = node.children.length > 0;
              const isExpanded = expanded.has(node.path);
              return (
                <tr
                  key={`${node.path}-${idx}`}
                  className={cn('border-t border-border', isRoot && 'bg-card font-medium')}
                >
                  <td className="px-2 py-1" style={{ paddingLeft: `${8 + node.depth * 14}px` }}>
                    {hasChildren ? (
                      <button
                        onClick={() => toggle(node.path)}
                        className="flex items-center gap-1"
                      >
                        {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        {node.name}
                      </button>
                    ) : (
                      <span className="pl-4">{node.name}</span>
                    )}
                  </td>
                  {COVERAGE_METRICS.map((m) => (
                    <td key={m} className="px-2 py-1 text-right font-mono">
                      {pct(node.metrics[m].percentage)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 目标 Tab：7 metric 默认目标 + 项目级覆盖 ───────────────────

function TargetsSection({
  currentProjectId,
  currentSessionId,
}: {
  currentProjectId: string | null;
  currentSessionId: string | null;
}) {
  const targets = useCoverageStore((s) => s.targets);
  const loadTargets = useCoverageStore((s) => s.loadTargets);
  const setTargets = useCoverageStore((s) => s.setTargets);
  const [draft, setDraft] = useState<Partial<Record<CoverageMetric, number>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (currentProjectId) loadTargets(currentProjectId, currentSessionId ?? undefined);
  }, [currentProjectId, currentSessionId, loadTargets]);

  useEffect(() => {
    setDraft({ ...targets });
  }, [targets]);

  const handleSave = async () => {
    if (!currentProjectId || !currentSessionId) return;
    setSaving(true);
    await setTargets(currentProjectId, currentSessionId, draft);
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground">
        7 种 metric 有行业默认目标；assertion 无默认目标（行业惯例）。项目级设置会覆盖默认值。
        {currentSessionId && <span className="ml-2">当前 session: <span className="font-mono">{currentSessionId}</span></span>}
      </div>
      <div className="rounded border border-border bg-card p-3">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left">Metric</th>
              <th className="px-2 py-1 text-right">行业默认</th>
              <th className="px-2 py-1 text-right">本项目目标</th>
            </tr>
          </thead>
          <tbody>
            {COVERAGE_METRICS.map((m) => {
              const def = DEFAULT_COVERAGE_TARGETS[m];
              const cur = draft[m];
              return (
                <tr key={m} className="border-t border-border">
                  <td className="px-2 py-1">{METRIC_LABELS[m]}</td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                    {def === undefined ? '—' : `${def}%`}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={cur ?? ''}
                      placeholder={def === undefined ? '无目标' : String(def)}
                      onChange={(e) => {
                        const val = e.target.value === '' ? undefined : Number(e.target.value);
                        setDraft((d) => {
                          const next = { ...d };
                          if (val === undefined || !Number.isFinite(val)) delete next[m];
                          else next[m] = val;
                          return next;
                        });
                      }}
                      className="w-20 rounded border border-border bg-background px-1 py-0.5 text-right font-mono text-xs"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!currentSessionId || saving}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {saving ? '保存中...' : '保存目标'}
        </button>
      </div>
    </div>
  );
}

// ─── 缺口 Tab：自动检测 Gap + 手动 Triage 标注 ──────────────────

function GapsSection({
  currentProjectId,
  currentSessionId,
}: {
  currentProjectId: string | null;
  currentSessionId: string | null;
}) {
  const gaps = useCoverageStore((s) => s.gaps);
  const triages = useCoverageStore((s) => s.triages);
  const loadGaps = useCoverageStore((s) => s.loadGaps);
  const loadTriages = useCoverageStore((s) => s.loadTriages);
  const addTriage = useCoverageStore((s) => s.addTriage);
  const deleteTriage = useCoverageStore((s) => s.deleteTriage);
  const [triagingGap, setTriagingGap] = useState<CoverageGap | null>(null);

  useEffect(() => {
    if (currentProjectId) {
      loadGaps(currentProjectId, currentSessionId ?? undefined);
      loadTriages(currentProjectId, currentSessionId ?? undefined);
    }
  }, [currentProjectId, currentSessionId, loadGaps, loadTriages]);

  const triagedKeys = new Set(triages.map((t) => `${t.nodePath}:${t.metric}`));

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground">
        自动检测所有模块中 metric 低于 Target 的缺口（deficit = Target − Actual）。
        可对缺口进行手动 Triage 标注（5 种根因 × 3 级置信度）。AI 自动分类在 Slice 6b。
      </div>

      {gaps.length === 0 ? (
        <div className="rounded border border-border bg-card p-4 text-center text-xs text-muted-foreground">
          无覆盖率缺口（所有模块均达标或无目标）
        </div>
      ) : (
        <div className="rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-secondary text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">模块</th>
                <th className="px-2 py-1 text-left">Metric</th>
                <th className="px-2 py-1 text-right">实际</th>
                <th className="px-2 py-1 text-right">目标</th>
                <th className="px-2 py-1 text-right">Deficit</th>
                <th className="px-2 py-1 text-center">Triage</th>
              </tr>
            </thead>
            <tbody>
              {gaps.map((g, idx) => {
                const key = `${g.nodePath}:${g.metric}`;
                const isTriaged = triagedKeys.has(key);
                return (
                  <tr key={`${key}-${idx}`} className="border-t border-border">
                    <td className="px-2 py-1 font-mono">{g.nodeName}</td>
                    <td className="px-2 py-1">{METRIC_LABELS[g.metric]}</td>
                    <td className="px-2 py-1 text-right font-mono">{g.actual.toFixed(1)}%</td>
                    <td className="px-2 py-1 text-right font-mono">{g.target}%</td>
                    <td className="px-2 py-1 text-right font-mono text-destructive">−{g.deficit.toFixed(1)}</td>
                    <td className="px-2 py-1 text-center">
                      {isTriaged ? (
                        <span className="text-[10px] text-primary">已标注</span>
                      ) : (
                        <button
                          onClick={() => setTriagingGap(g)}
                          className="rounded border border-border px-2 py-0.5 text-[10px] hover:bg-secondary"
                        >
                          标注
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 已有 Triage 列表 */}
      {triages.length > 0 && (
        <div className="rounded border border-border">
          <div className="bg-secondary px-2 py-1 text-[10px] uppercase text-muted-foreground">已标注 Triage</div>
          <table className="w-full text-xs">
            <tbody>
              {triages.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-2 py-1 font-mono">{t.gap.nodeName}</td>
                  <td className="px-2 py-1">{METRIC_LABELS[t.metric]}</td>
                  <td className="px-2 py-1">
                    {t.cause ? TRIAGE_CAUSES.find((c) => c.value === t.cause)?.label : '—'}
                  </td>
                  <td className="px-2 py-1">
                    {t.confidence ? TRIAGE_CONFIDENCES.find((c) => c.value === t.confidence)?.label : '—'}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{t.note ?? ''}</td>
                  <td className="px-2 py-1 text-right">
                    <button
                      onClick={() => currentProjectId && deleteTriage(currentProjectId, t.id)}
                      className="text-[10px] text-destructive hover:underline"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {triagingGap && currentProjectId && currentSessionId && (
        <TriageDialog
          gap={triagingGap}
          onClose={() => setTriagingGap(null)}
          onSubmit={async (cause, confidence, note) => {
            await addTriage(currentProjectId, {
              sessionId: currentSessionId,
              nodePath: triagingGap.nodePath,
              metric: triagingGap.metric,
              gap: triagingGap,
              cause,
              confidence,
              note,
            });
            setTriagingGap(null);
          }}
        />
      )}
    </div>
  );
}

function TriageDialog({
  gap,
  onClose,
  onSubmit,
}: {
  gap: CoverageGap;
  onClose: () => void;
  onSubmit: (cause: TriageCause, confidence: TriageConfidence, note: string) => Promise<void>;
}) {
  const [cause, setCause] = useState<TriageCause>('missing_scenario');
  const [confidence, setConfidence] = useState<TriageConfidence>('medium');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    await onSubmit(cause, confidence, note);
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 rounded border border-border bg-card p-4 shadow-lg">
        <div className="mb-3 text-sm font-medium">Triage 标注</div>
        <div className="mb-3 text-xs text-muted-foreground">
          模块 <span className="font-mono">{gap.nodeName}</span> · {METRIC_LABELS[gap.metric]} · deficit {gap.deficit.toFixed(1)}
        </div>
        <div className="space-y-2">
          <label className="block text-[10px] text-muted-foreground">
            根因
            <select
              value={cause}
              onChange={(e) => setCause(e.target.value as TriageCause)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
            >
              {TRIAGE_CAUSES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-[10px] text-muted-foreground">
            置信度
            <select
              value={confidence}
              onChange={(e) => setConfidence(e.target.value as TriageConfidence)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
            >
              {TRIAGE_CONFIDENCES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="block text-[10px] text-muted-foreground">
            备注
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              placeholder="可选：补充说明"
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
          >
            {submitting ? '提交中...' : '提交'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 排除 Tab：Exclusion 工作流（请求 / 审批 / 驳回） ───────────

function ExclusionsSection({
  currentProjectId,
  currentSessionId,
}: {
  currentProjectId: string | null;
  currentSessionId: string | null;
}) {
  const exclusions = useCoverageStore((s) => s.exclusions);
  const gaps = useCoverageStore((s) => s.gaps);
  const loadExclusions = useCoverageStore((s) => s.loadExclusions);
  const loadGaps = useCoverageStore((s) => s.loadGaps);
  const requestExclusion = useCoverageStore((s) => s.requestExclusion);
  const approveExclusion = useCoverageStore((s) => s.approveExclusion);
  const rejectExclusion = useCoverageStore((s) => s.rejectExclusion);
  const [showRequest, setShowRequest] = useState(false);
  const [selectedGap, setSelectedGap] = useState<CoverageGap | null>(null);
  const [reason, setReason] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [approver, setApprover] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    if (currentProjectId) {
      loadExclusions(currentProjectId, currentSessionId ?? undefined);
      loadGaps(currentProjectId, currentSessionId ?? undefined);
    }
  }, [currentProjectId, currentSessionId, loadExclusions, loadGaps]);

  const handleRequest = async () => {
    if (!currentProjectId || !currentSessionId || !selectedGap || !reason.trim() || !requestedBy.trim()) return;
    await requestExclusion(currentProjectId, {
      sessionId: currentSessionId,
      nodePath: selectedGap.nodePath,
      metric: selectedGap.metric,
      reason: reason.trim(),
      requestedBy: requestedBy.trim(),
    });
    setShowRequest(false);
    setSelectedGap(null);
    setReason('');
  };

  const handleReject = async (id: string) => {
    if (!currentProjectId || !approver.trim() || !rejectReason.trim()) return;
    await rejectExclusion(currentProjectId, id, approver.trim(), rejectReason.trim());
    setRejectingId(null);
    setRejectReason('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="text-[10px] text-muted-foreground">
          建议排除的覆盖率项（如死代码）必须人工审批，不可自动排除。
        </div>
        <button
          onClick={() => setShowRequest(true)}
          disabled={!currentSessionId || gaps.length === 0}
          className="ml-auto flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs hover:bg-secondary disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          请求排除
        </button>
      </div>

      {/* 请求排除对话框 */}
      {showRequest && (
        <div className="rounded border border-border bg-card p-3">
          <div className="mb-2 text-xs font-medium">发起排除请求</div>
          <div className="space-y-2">
            <label className="block text-[10px] text-muted-foreground">
              选择缺口
              <select
                value={selectedGap?.nodePath ?? ''}
                onChange={(e) => {
                  const g = gaps.find((x) => x.nodePath === e.target.value);
                  setSelectedGap(g ?? null);
                }}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              >
                <option value="">— 选择 —</option>
                {gaps.map((g, i) => (
                  <option key={`${g.nodePath}-${i}`} value={g.nodePath}>
                    {g.nodeName} · {METRIC_LABELS[g.metric]} · deficit {g.deficit.toFixed(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[10px] text-muted-foreground">
              排除原因
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例如：该模块为死代码，已废弃"
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              />
            </label>
            <label className="block text-[10px] text-muted-foreground">
              申请人
              <input
                type="text"
                value={requestedBy}
                onChange={(e) => setRequestedBy(e.target.value)}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowRequest(false); setSelectedGap(null); setReason(''); }}
                className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
              >
                取消
              </button>
              <button
                onClick={handleRequest}
                disabled={!selectedGap || !reason.trim() || !requestedBy.trim()}
                className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
              >
                提交请求
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 排除项列表 */}
      {exclusions.length === 0 ? (
        <div className="rounded border border-border bg-card p-4 text-center text-xs text-muted-foreground">
          暂无排除请求
        </div>
      ) : (
        <div className="rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-secondary text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">模块</th>
                <th className="px-2 py-1 text-left">Metric</th>
                <th className="px-2 py-1 text-left">原因</th>
                <th className="px-2 py-1 text-left">申请人</th>
                <th className="px-2 py-1 text-center">状态</th>
                <th className="px-2 py-1 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {exclusions.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-2 py-1 font-mono">{e.nodePath}</td>
                  <td className="px-2 py-1">{METRIC_LABELS[e.metric]}</td>
                  <td className="px-2 py-1 text-muted-foreground">{e.reason}</td>
                  <td className="px-2 py-1">{e.requestedBy}</td>
                  <td className="px-2 py-1 text-center">
                    <span className={cn(
                      'rounded px-1.5 py-0.5 text-[10px]',
                      e.status === 'pending' && 'bg-secondary text-muted-foreground',
                      e.status === 'approved' && 'bg-primary/15 text-primary',
                      e.status === 'rejected' && 'bg-destructive/15 text-destructive',
                    )}>
                      {e.status === 'pending' ? '待审批' : e.status === 'approved' ? '已批准' : '已驳回'}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-center">
                    {e.status === 'pending' && (
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => currentProjectId && approver.trim() && approveExclusion(currentProjectId, e.id, approver.trim())}
                          disabled={!approver.trim()}
                          className="rounded border border-primary/50 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 disabled:opacity-50"
                        >
                          批准
                        </button>
                        <button
                          onClick={() => setRejectingId(e.id)}
                          className="rounded border border-destructive/50 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                        >
                          驳回
                        </button>
                      </div>
                    )}
                    {e.status === 'rejected' && e.rejectionReason && (
                      <span className="text-[10px] text-destructive">{e.rejectionReason}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 审批人输入 */}
      <label className="block text-[10px] text-muted-foreground">
        审批人姓名（用于批准 / 驳回操作）
        <input
          type="text"
          value={approver}
          onChange={(e) => setApprover(e.target.value)}
          className="mt-1 w-48 rounded border border-border bg-background px-2 py-1 text-xs"
        />
      </label>

      {/* 驳回原因对话框 */}
      {rejectingId && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-3">
          <div className="mb-2 text-xs">驳回原因</div>
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="说明为何驳回此排除请求"
            className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-xs"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setRejectingId(null); setRejectReason(''); }}
              className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
            >
              取消
            </button>
            <button
              onClick={() => handleReject(rejectingId)}
              disabled={!rejectReason.trim() || !approver.trim()}
              className="rounded bg-destructive px-2 py-1 text-xs text-destructive-foreground disabled:opacity-50"
            >
              确认驳回
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 对比 Tab：两个 Session 之间逐 metric Delta ─────────────────

function DeltaSection({
  currentProjectId,
  sessions,
}: {
  currentProjectId: string | null;
  sessions: ReturnType<typeof useCoverageStore.getState>['sessions'];
}) {
  const delta = useCoverageStore((s) => s.delta);
  const loadDelta = useCoverageStore((s) => s.loadDelta);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');

  const handleCompute = () => {
    if (!currentProjectId || !before || !after || before === after) return;
    loadDelta(currentProjectId, before, after);
  };

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-muted-foreground">
        选择两个 Session 计算逐 metric 覆盖率变化（delta = after − before；正值表示提升，负值表示退化）。
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-[10px] text-muted-foreground">
          Before
          <select
            value={before}
            onChange={(e) => setBefore(e.target.value)}
            className="mt-1 block rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">— 选择 —</option>
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>{s.sessionId}</option>
            ))}
          </select>
        </label>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <label className="block text-[10px] text-muted-foreground">
          After
          <select
            value={after}
            onChange={(e) => setAfter(e.target.value)}
            className="mt-1 block rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">— 选择 —</option>
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>{s.sessionId}</option>
            ))}
          </select>
        </label>
        <button
          onClick={handleCompute}
          disabled={!before || !after || before === after}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          计算
        </button>
      </div>

      {delta && (
        <div className="rounded border border-border">
          <table className="w-full text-xs">
            <thead className="bg-secondary text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">Metric</th>
                <th className="px-2 py-1 text-right">Before</th>
                <th className="px-2 py-1 text-right">After</th>
                <th className="px-2 py-1 text-right">Delta</th>
              </tr>
            </thead>
            <tbody>
              {delta.deltas.map((d) => (
                <tr key={d.metric} className="border-t border-border">
                  <td className="px-2 py-1">{METRIC_LABELS[d.metric]}</td>
                  <td className="px-2 py-1 text-right font-mono">{d.before.toFixed(1)}%</td>
                  <td className="px-2 py-1 text-right font-mono">{d.after.toFixed(1)}%</td>
                  <td className={cn(
                    'px-2 py-1 text-right font-mono',
                    d.delta > 0 && 'text-primary',
                    d.delta < 0 && 'text-destructive',
                  )}>
                    {d.delta > 0 ? '+' : ''}{d.delta.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
