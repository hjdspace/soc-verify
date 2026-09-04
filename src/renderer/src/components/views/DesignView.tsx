/**
 * 设计视图（Design View，第七视图，issue 02 tracer bullet）。
 *
 * Design Source（.f 文件列表 + 顶层选择）→ 手动刷新 elaboration → 层级树。
 * 三态：未配置（配置表单）/ 错误（slang 诊断列表）/ 数据（缓存秒开的层级树）。
 * yosys 缺失时给出明确降级提示与引导（issue 01 降级策略）。
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, ListTree, Network, Plus, RefreshCw, Table2, Trash2, Wand2 } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';
import { DesignTree } from '@renderer/components/design/DesignTree';
import { ModuleInterfaceView } from '@renderer/components/design/ModuleInterfaceView';
import { BlockDiagram } from '@renderer/components/design/BlockDiagram';
import type { DesignInstRow, DesignStatus } from '@main/rtl/types';

/** 右侧详情视图：框图（默认，issue 05）/ 接口表（issue 04） */
type DetailView = 'diagram' | 'interface';

export function DesignView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [status, setStatus] = useState<DesignStatus | null>(null);
  const [config, setConfig] = useState<{ filelists: string[]; top: string | null } | null>(null);
  const [root, setRoot] = useState<DesignInstRow | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedInst, setSelectedInst] = useState<DesignInstRow | null>(null);
  const [detailView, setDetailView] = useState<DetailView>('diagram');

  const reload = useCallback(async (projectId: string) => {
    const [cfg, st, rt] = await Promise.all([
      trpc.rtl.getConfig.query({ projectId }),
      trpc.rtl.getStatus.query({ projectId }),
      trpc.rtl.getRoot.query({ projectId }),
    ]);
    setConfig(cfg);
    setStatus(st);
    setRoot(rt);
    // 配置不完整（未配 .f 或未选顶层）→ 自动展开配置面板引导补全
    setShowConfig((prev) => prev || !st.configured);
  }, []);

  useEffect(() => {
    if (currentProjectId) {
      void reload(currentProjectId);
    }
  }, [currentProjectId, reload]);

  if (!currentProjectId) {
    return <EmptyHint text="请先打开项目" />;
  }

  const handleRefreshed = async () => {
    if (!currentProjectId) return;
    setRefreshing(true);
    try {
      const result = await trpc.rtl.refresh.mutate({ projectId: currentProjectId });
      await reload(currentProjectId);
      if (result.ok) {
        setShowConfig(false);
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* ─── 头部：标题 + 过期提示 + 配置 + 刷新 ─────────────── */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2" data-testid="design-view-header">
        <ListTree className="size-4 text-primary" />
        <span className="text-sm font-semibold">设计</span>
        {status?.hasData && status.stale && (
          <span
            className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
            data-testid="design-stale-badge"
            title="点击「刷新」重新 elaboration"
          >
            <AlertTriangle className="size-3" />
            源文件已变化，数据过期
          </span>
        )}
        {status?.hasData && !status.stale && status.lastElaboratedAt && (
          <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3" />
            {status.top} · {new Date(status.lastElaboratedAt).toLocaleString()}
            {status.elapsedMs !== null ? ` · ${(status.elapsedMs / 1000).toFixed(1)}s` : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-testid="design-config-toggle"
            onClick={() => setShowConfig((v) => !v)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <FolderOpen className="size-3.5" />
            Design Source
          </button>
          <button
            type="button"
            data-testid="design-refresh"
            disabled={refreshing || !config || config.filelists.length === 0 || config.top === null}
            onClick={() => void handleRefreshed()}
            className="flex items-center gap-1 rounded bg-primary/15 px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            刷新
          </button>
        </div>
      </div>

      {/* ─── 主体 ──────────────────────────────────────────── */}
      {!status ? (
        <EmptyHint text="加载中..." />
      ) : !status.yosysAvailable ? (
        <DegradeBanner missingDlls={status.missingDlls} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {showConfig && currentProjectId && config && (
            <ConfigPanel
              projectId={currentProjectId}
              initial={config}
              top={config.top}
              onSaved={async (saved) => {
                setConfig(saved);
                setShowConfig(false);
                await handleRefreshed();
              }}
              onCancel={() => setShowConfig(false)}
            />
          )}

          {status.lastError && (
            <ErrorPanel
              error={status.lastError}
              onRetry={() => void handleRefreshed()}
            />
          )}

          {!status.hasData && !status.lastError && !showConfig && (
            <EmptyHint text="尚未 elaboration：配置 Design Source 后点击「刷新」" />
          )}

          {root && currentProjectId && (
            <div className="flex min-h-0 flex-1 gap-0 p-2">
              <div className="flex min-h-0 w-2/5 shrink-0 flex-col border-r border-border pr-2">
                <DesignTree
                  projectId={currentProjectId}
                  node={root}
                  onSelect={setSelectedInst}
                  selectedPath={selectedInst?.path ?? null}
                />
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col pl-2">
                {/* ── 详情视图切换：框图（默认）/ 接口表 ── */}
                <div className="mb-1 flex shrink-0 items-center gap-1" data-testid="design-detail-toggle">
                  <button
                    type="button"
                    data-testid="design-detail-diagram"
                    aria-pressed={detailView === 'diagram'}
                    onClick={() => setDetailView('diagram')}
                    className={cn(
                      'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                      detailView === 'diagram'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <Network className="size-3.5" />
                    框图
                  </button>
                  <button
                    type="button"
                    data-testid="design-detail-interface"
                    aria-pressed={detailView === 'interface'}
                    onClick={() => setDetailView('interface')}
                    className={cn(
                      'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                      detailView === 'interface'
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <Table2 className="size-3.5" />
                    接口
                  </button>
                </div>
                <div className="flex min-h-0 min-w-0 flex-1">
                  {detailView === 'diagram' ? (
                    <BlockDiagram projectId={currentProjectId} path={selectedInst?.path ?? root.path} />
                  ) : selectedInst ? (
                    <ModuleInterfaceView projectId={currentProjectId} inst={selectedInst} />
                  ) : (
                    <EmptyHint text="在左侧层级树选择实例查看接口" />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 配置面板 ────────────────────────────────────────────────

function ConfigPanel({
  projectId,
  initial,
  top,
  onSaved,
  onCancel,
}: {
  projectId: string;
  initial: { filelists: string[]; top: string | null };
  top: string | null;
  onSaved: (config: { filelists: string[]; top: string | null }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [filelists, setFilelists] = useState<string[]>(() => [...initial.filelists]);
  const [topInput, setTopInput] = useState<string>(top ?? '');
  const [detectedTops, setDetectedTops] = useState<string[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 恢复上次检测的 top units 列表（story 17：选择器记忆，无需重新 elaboration）
  useEffect(() => {
    void trpc.rtl.getDetectedTops
      .query({ projectId })
      .then(({ tops }) => {
        if (tops.length > 0) setDetectedTops(tops);
      })
      .catch(() => undefined);
  }, [projectId]);

  const detectTops = async () => {
    // 先保存 filelists 再检测（检测需要读 .f）
    setSaving(true);
    try {
      await trpc.rtl.setConfig.mutate({ projectId, filelists, top: topInput || null });
      const { tops } = await trpc.rtl.detectTops.mutate({ projectId });
      setDetectedTops(tops);
      setDetectError(null);
      if (tops.length > 0 && !topInput) {
        setTopInput(tops[0]);
      }
    } catch (err) {
      setDetectedTops([]);
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await trpc.rtl.setConfig.mutate({ projectId, filelists, top: topInput || null });
      await onSaved({ filelists, top: topInput || null });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-border p-4" data-testid="design-config-panel">
      <div className="mb-1 text-xs font-semibold text-foreground">Design Source</div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        配置一个或多个 VCS 风格 .f 文件（支持 +incdir+ / +define+ / -f 嵌套），检测并选择顶层模块后手动刷新。
      </p>

      <div className="mb-3 space-y-1.5">
        {filelists.map((f, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={f}
              onChange={(e) => setFilelists((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
              placeholder="design/filelist.f"
              className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary/50"
            />
            <button
              type="button"
              aria-label={`删除第 ${i + 1} 个 filelist`}
              onClick={() => setFilelists((prev) => prev.filter((_, j) => j !== i))}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setFilelists((prev) => [...prev, ''])}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3" />
          添加 .f 文件
        </button>
      </div>

      <div className="mb-3 flex items-center gap-1.5">
        {detectedTops !== null && detectedTops.length > 0 ? (
          <select
            value={topInput}
            onChange={(e) => setTopInput(e.target.value)}
            data-testid="design-top-select"
            aria-label="选择顶层模块"
            className="w-56 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary/50"
          >
            {(topInput && !detectedTops.includes(topInput) ? [topInput, ...detectedTops] : detectedTops).map(
              (t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ),
            )}
          </select>
        ) : (
          <input
            value={topInput}
            onChange={(e) => setTopInput(e.target.value)}
            placeholder="顶层模块名"
            data-testid="design-top-input"
            className="w-56 rounded border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-primary/50"
          />
        )}
        <button
          type="button"
          data-testid="design-detect-tops"
          disabled={saving || filelists.filter((f) => f.trim()).length === 0}
          onClick={() => void detectTops()}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Wand2 className={cn('size-3.5', saving && 'animate-pulse')} />
          检测顶层
        </button>
        {detectedTops !== null && detectedTops.length === 0 && (
          <span className="text-[11px] text-muted-foreground" data-testid="design-tops-result">
            未检测到顶层
          </span>
        )}
        {detectError && <span className="text-[11px] text-status-fail">{detectError}</span>}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="design-config-save"
          disabled={saving || filelists.filter((f) => f.trim()).length === 0 || topInput.trim().length === 0}
          onClick={() => void save()}
          className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          保存并刷新
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ─── 错误呈现（slang 诊断：文件+行号） ────────────────────────

function ErrorPanel({ error, onRetry }: { error: { message: string; diagnostics: { file: string; line: number; column: number | null; severity: string; message: string }[]; logTail: string }; onRetry: () => void }) {
  const errors = error.diagnostics.filter((d) => d.severity === 'error' || d.severity === 'fatal');
  const others = error.diagnostics.filter((d) => d.severity !== 'error' && d.severity !== 'fatal');
  return (
    <div className="m-3 rounded border border-status-fail/40 bg-status-fail/5 p-3" data-testid="design-error-panel">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-status-fail">
        <AlertTriangle className="size-3.5" />
        Elaboration 失败
      </div>
      <p className="mb-2 font-mono text-[11px] text-foreground">{error.message}</p>
      {(errors.length > 0 || others.length > 0) && (
        <div className="max-h-56 overflow-y-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
          {[...errors, ...others].map((d, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <span className="text-muted-foreground">
                {d.file}:{d.line}
                {d.column !== null ? `:${d.column}` : ''}
              </span>{' '}
              <span className={d.severity === 'error' || d.severity === 'fatal' ? 'text-status-fail' : 'text-amber-600 dark:text-amber-400'}>
                {d.severity}:
              </span>{' '}
              {d.message}
            </div>
          ))}
        </div>
      )}
      {errors.length === 0 && error.logTail && (
        <pre className="mt-2 max-h-40 overflow-y-auto rounded bg-background/60 p-2 font-mono text-[11px] text-muted-foreground">{error.logTail}</pre>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        重试
      </button>
    </div>
  );
}

// ─── 降级提示（工具缺失引导，对齐 officecli 策略） ─────────────

function DegradeBanner({ missingDlls }: { missingDlls: string[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center" data-testid="design-degrade-banner">
      <AlertTriangle className="size-8 text-amber-500" />
      <p className="text-sm font-medium">yosys 不可用，RTL 设计浏览已降级</p>
      <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
        {missingDlls.length > 0
          ? `缺少依赖 DLL：${missingDlls.join(', ')}（必须与 yosys.exe 同目录）。`
          : '未找到 yosys 二进制。'}
        请运行 <code className="rounded bg-accent px-1 py-0.5 font-mono">npm run download:rtl-tools</code> 安装 RTL 工具链，
        或参考 resources/binaries/README.md 手动放置。
      </p>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}
