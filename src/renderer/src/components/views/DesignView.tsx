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
import { useUiStore } from '@renderer/stores/ui';
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle';
import { DesignTree } from '@renderer/components/design/DesignTree';
import { ModuleInterfaceView } from '@renderer/components/design/ModuleInterfaceView';
import { BlockDiagram } from '@renderer/components/design/BlockDiagram';
import type { DesignInstRow, DesignSourceConfig, DesignStatus } from '@main/rtl/types';

/** 右侧详情视图：框图（默认，issue 05）/ 接口表（issue 04） */
type DetailView = 'diagram' | 'interface';

function hasDesignSourceInput(config: Pick<DesignSourceConfig, 'source' | 'filelists' | 'directory'>): boolean {
  if (config.source === 'directory') return Boolean(config.directory?.root.trim());
  return config.filelists.some((filelist) => filelist.trim().length > 0);
}

export function DesignView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const designTreeWidth = useUiStore((s) => s.designTreeWidth);
  const setDesignTreeWidth = useUiStore((s) => s.setDesignTreeWidth);

  const [status, setStatus] = useState<DesignStatus | null>(null);
  const [config, setConfig] = useState<DesignSourceConfig | null>(null);
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
      // ok:false 时 lastError 已由主进程持久化，reload 后 ErrorPanel 呈现失败原因
    } catch (err) {
      console.error('[DesignView] refresh 失败:', err);
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
            disabled={refreshing || !config || !hasDesignSourceInput(config) || config.top === null}
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
              onDetectFinished={async () => {
                if (currentProjectId) await reload(currentProjectId);
              }}
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
              <div
                className="flex min-h-0 shrink-0 flex-col"
                style={{ width: `${designTreeWidth}px` }}
                data-testid="design-tree-panel"
              >
                <DesignTree
                  projectId={currentProjectId}
                  node={root}
                  onSelect={setSelectedInst}
                  selectedPath={selectedInst?.path ?? null}
                />
              </div>
              <ResizeHandle side="left" width={designTreeWidth} onResize={setDesignTreeWidth} />
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
  onDetectFinished,
}: {
  projectId: string;
  initial: DesignSourceConfig;
  top: string | null;
  onSaved: (config: DesignSourceConfig) => void | Promise<void>;
  onCancel: () => void;
  /** 检测顶层结束后回调：父级重载 status，同步 lastError 面板（成功清除残留旧错误 / 失败呈现新错误） */
  onDetectFinished: () => void | Promise<void>;
}) {
  const [source, setSource] = useState<'filelist' | 'directory'>(initial.source === 'directory' ? 'directory' : 'filelist');
  const [filelists, setFilelists] = useState<string[]>(() => [...initial.filelists]);
  const [directory, setDirectory] = useState(() => ({
    root: initial.directory?.root ?? '',
    excludes: initial.directory?.excludes ?? ['**/dv/**', '**/test/**', '**/tests/**', '**/vendor/**'],
    incdirs: initial.directory?.incdirs ?? [],
    defines: initial.directory?.defines ?? [],
  }));
  const [topInput, setTopInput] = useState<string>(top ?? '');
  const [detectedTops, setDetectedTops] = useState<string[] | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectErrorDetail, setDetectErrorDetail] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [browsingDirectory, setBrowsingDirectory] = useState(false);

  useEffect(() => {
    void trpc.rtl.getDetectedTops
      .query({ projectId })
      .then(({ tops }) => {
        if (tops.length > 0) setDetectedTops(tops);
      })
      .catch(() => undefined);
  }, [projectId]);

  const buildConfig = (): DesignSourceConfig => ({
    source,
    filelists,
    directory: source === 'directory' ? directory : undefined,
    top: topInput.trim().length > 0 ? topInput.trim() : null,
  });

  const hasSourceInput = source === 'directory' ? directory.root.trim().length > 0 : filelists.some((filelist) => filelist.trim().length > 0);

  const browseFilelist = async (index: number) => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 filelist 文件',
        filters: [
          { name: 'Filelist (.f)', extensions: ['f'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length === 0) return;
      setFilelists((prev) => {
        const next = [...prev];
        const [first, ...rest] = result.paths;
        next[index] = first;
        return [...next, ...rest];
      });
    } catch {
      // best-effort：对话框失败不影响手动输入
    }
  };

  const browseDirectory = async () => {
    setBrowsingDirectory(true);
    try {
      const result = await trpc.tools.selectDirectory.mutate({
        title: '选择 RTL 扫描目录',
        defaultPath: directory.root || undefined,
      });
      if (result.path) setDirectory((prev) => ({ ...prev, root: result.path ?? prev.root }));
    } catch {
      // best-effort：对话框失败不影响手动输入
    } finally {
      setBrowsingDirectory(false);
    }
  };

  const updateDirectoryList = (key: 'excludes' | 'incdirs' | 'defines', value: string) => {
    setDirectory((prev) => ({
      ...prev,
      [key]: value.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.length > 0),
    }));
  };

  const detectTops = async () => {
    setSaving(true);
    try {
      await trpc.rtl.setConfig.mutate({ projectId, ...buildConfig() });
      const { tops } = await trpc.rtl.detectTops.mutate({ projectId });
      setDetectedTops(tops);
      setDetectError(null);
      setDetectErrorDetail(null);
      if (tops.length > 0 && !topInput) setTopInput(tops[0]);
    } catch (err) {
      setDetectedTops([]);
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as { cause?: { logTail?: string } }).cause;
      setDetectError(msg);
      setDetectErrorDetail(cause?.logTail ?? null);
    } finally {
      setSaving(false);
    }
    await onDetectFinished();
  };

  const save = async () => {
    setSaving(true);
    const nextConfig = buildConfig();
    try {
      await trpc.rtl.setConfig.mutate({ projectId, ...nextConfig });
      await onSaved(nextConfig);
    } finally {
      setSaving(false);
    }
  };

  const previewMode = source === 'directory' ? 'DIRECTORY SCAN' : 'FILELIST';
  const previewSource = source === 'directory' ? (directory.root.trim() || '未选择目录') : `${filelists.filter((filelist) => filelist.trim()).length} 个 filelist`;
  const previewFiles = source === 'directory' ? '递归发现 .v / .sv' : '按 filelist 顺序解析';
  const previewNotice = source === 'directory'
    ? '目录扫描无法可靠推断所有宏定义、生成 RTL 和第三方库依赖。请检查排除项与预检诊断。'
    : 'Filelist 中的 include、define 和嵌套顺序会原样保留。';

  return (
    <div className="grid min-h-0 max-h-[min(720px,75vh)] grid-cols-[minmax(0,1fr)_19rem] border-b border-border bg-background" data-testid="design-config-panel">
      <div className="min-h-0 overflow-y-auto p-5">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="mb-1 text-sm font-semibold text-foreground">配置 RTL 设计源</div>
            <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
              选择能表达真实编译上下文的来源。系统会先规范化输入，再生成实例层级、模块接口与框图。
            </p>
          </div>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Configure · 1 / 1</span>
        </div>

        <section className="mb-5">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">1</span>
            <div>
              <h3 className="text-xs font-semibold text-foreground">选择来源</h3>
              <p className="text-[10px] text-muted-foreground">没有项目清单时，目录扫描适合受控的 RTL 工程。</p>
            </div>
          </div>
          <div className="grid grid-cols-2 overflow-hidden rounded border border-border" role="tablist" aria-label="设计源类型">
            <button
              type="button"
              role="tab"
              aria-selected={source === 'filelist'}
              data-testid="design-source-filelist"
              onClick={() => setSource('filelist')}
              className={cn(
                'flex min-h-16 items-start gap-2 border-r border-border px-3 py-2.5 text-left transition-colors',
                source === 'filelist' ? 'bg-primary/10 text-foreground shadow-[inset_0_-2px_var(--primary)]' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <ListTree className={cn('mt-0.5 size-4 shrink-0', source === 'filelist' ? 'text-primary' : 'text-muted-foreground')} />
              <span><strong className="block text-xs font-semibold">Filelist</strong><span className="mt-0.5 block text-[10px] leading-relaxed">VCS 风格 .f / .flist，兼容现有配置</span></span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={source === 'directory'}
              data-testid="design-source-directory"
              onClick={() => setSource('directory')}
              className={cn(
                'flex min-h-16 items-start gap-2 px-3 py-2.5 text-left transition-colors',
                source === 'directory' ? 'bg-primary/10 text-foreground shadow-[inset_0_-2px_var(--primary)]' : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <FolderOpen className={cn('mt-0.5 size-4 shrink-0', source === 'directory' ? 'text-primary' : 'text-muted-foreground')} />
              <span><strong className="block text-xs font-semibold">目录扫描</strong><span className="mt-0.5 block text-[10px] leading-relaxed">递归发现 .v / .sv，需要补充编译上下文</span></span>
            </button>
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">2</span>
            <div>
              <h3 className="text-xs font-semibold text-foreground">{source === 'directory' ? '限定扫描范围' : '添加 Filelist'}</h3>
              <p className="text-[10px] text-muted-foreground">{source === 'directory' ? '只扫描设计 RTL，测试平台和工具产物默认排除。' : '支持多个 .f 文件、include、define 和嵌套路径。'}</p>
            </div>
          </div>

          {source === 'filelist' ? (
            <div className="space-y-1.5" data-testid="design-filelist-source-panel">
              {filelists.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={f} onChange={(e) => setFilelists((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))} placeholder="design/filelist.f 或绝对路径" className="min-w-0 flex-1 rounded border border-border bg-card px-2.5 py-1.5 font-mono text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30" />
                  <button type="button" aria-label={`浏览第 ${i + 1} 个 filelist`} data-testid={`design-filelist-browse-${i}`} onClick={() => void browseFilelist(i)} className="rounded border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><FolderOpen className="size-3.5" /></button>
                  <button type="button" aria-label={`删除第 ${i + 1} 个 filelist`} onClick={() => setFilelists((prev) => prev.filter((_, j) => j !== i))} className="rounded border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Trash2 className="size-3.5" /></button>
                </div>
              ))}
              <button type="button" onClick={() => setFilelists((prev) => [...prev, ''])} className="flex items-center gap-1 rounded px-1 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="size-3" />添加 .f 文件</button>
            </div>
          ) : (
            <div className="space-y-3" data-testid="design-directory-source-panel">
              <div className="flex items-center gap-1.5">
                <input value={directory.root} onChange={(e) => setDirectory((prev) => ({ ...prev, root: e.target.value }))} placeholder="RTL 根目录，例如 D:\\doc\\opentitan\\hw" data-testid="design-scan-root" className="min-w-0 flex-1 rounded border border-border bg-card px-2.5 py-1.5 font-mono text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30" />
                <button type="button" aria-label="选择 RTL 扫描目录" data-testid="design-scan-browse" disabled={browsingDirectory} onClick={() => void browseDirectory()} className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-wait disabled:opacity-60">
                  <FolderOpen className={cn('size-3.5', browsingDirectory && 'animate-pulse')} />{browsingDirectory ? '打开中' : '浏览'}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">排除目录 <span className="text-[9px] text-muted-foreground/70">每行一个 glob</span><textarea value={directory.excludes.join('\n')} onChange={(e) => updateDirectoryList('excludes', e.target.value)} rows={3} data-testid="design-scan-excludes" className="resize-y rounded border border-border bg-card px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30" /></label>
                <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">Include 目录 <span className="text-[9px] text-muted-foreground/70">.svh 搜索路径</span><textarea value={directory.incdirs.join('\n')} onChange={(e) => updateDirectoryList('incdirs', e.target.value)} rows={3} data-testid="design-scan-incdirs" placeholder="hw/ip/prim/rtl" className="resize-y rounded border border-border bg-card px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30" /></label>
                <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">宏定义 <span className="text-[9px] text-muted-foreground/70">决定 `ifdef 分支</span><textarea value={directory.defines.join('\n')} onChange={(e) => updateDirectoryList('defines', e.target.value)} rows={3} data-testid="design-scan-defines" placeholder="SYNTHESIS=1" className="resize-y rounded border border-border bg-card px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30" /></label>
              </div>
              <p className="flex items-start gap-1.5 rounded bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />目录扫描不能自动还原所有条件编译、生成 RTL 或第三方库依赖。</p>
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">3</span>
            <div><h3 className="text-xs font-semibold text-foreground">预检与顶层</h3><p className="text-[10px] text-muted-foreground">先检查输入，再选择最终 elaboration 顶层。</p></div>
          </div>
          <div className="flex flex-wrap items-start gap-1.5">
            {detectedTops !== null && detectedTops.length > 0 ? (
              <select value={topInput} onChange={(e) => setTopInput(e.target.value)} data-testid="design-top-select" aria-label="选择顶层模块" className="min-w-56 rounded border border-border bg-card px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary/30">
                {(topInput && !detectedTops.includes(topInput) ? [topInput, ...detectedTops] : detectedTops).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <input value={topInput} onChange={(e) => setTopInput(e.target.value)} placeholder="顶层模块名" data-testid="design-top-input" className="min-w-56 rounded border border-border bg-card px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary/30" />
            )}
            <button type="button" data-testid="design-detect-tops" disabled={saving || !hasSourceInput} onClick={() => void detectTops()} className="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"><Wand2 className={cn('size-3.5', saving && 'animate-pulse')} />{saving ? '处理中…' : '检测顶层'}</button>
            {detectedTops !== null && detectedTops.length === 0 && <span className="pt-1.5 text-[11px] text-muted-foreground" data-testid="design-tops-result">未检测到顶层</span>}
            {detectError && <div className="flex w-full flex-col gap-0.5" data-testid="design-detect-error"><span className="text-[11px] text-status-fail">{detectError}</span>{detectErrorDetail && <details className="mt-0.5"><summary className="cursor-pointer text-[10px] text-muted-foreground">yosys 输出详情</summary><pre className="mt-1 max-h-32 overflow-auto rounded bg-card p-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all">{detectErrorDetail}</pre></details>}</div>}
          </div>
        </section>

        <div className="mt-6 flex items-center gap-2 border-t border-border pt-3">
          <p className="mr-auto text-[10px] text-muted-foreground">配置保存于 <code className="font-mono">.socverify/design/config.json</code></p>
          <button type="button" data-testid="design-config-save" disabled={saving || !hasSourceInput || topInput.trim().length === 0} onClick={() => void save()} className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">{saving ? '保存中…' : '保存并刷新'}</button>
          <button type="button" onClick={onCancel} className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">取消</button>
        </div>
      </div>

      <aside className="min-h-0 overflow-y-auto border-l border-border bg-muted/20" data-testid="design-source-preview">
        <div className="flex min-h-11 items-center border-b border-border px-3.5"><strong className="text-[11px]">输入预览</strong><span className="ml-auto font-mono text-[9px] text-muted-foreground">{previewMode}</span></div>
        <div className="space-y-5 p-3.5">
          <div><h4 className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">解析范围</h4><div className="rounded border border-border bg-card p-2.5"><div className="flex items-center gap-1.5 font-mono text-[10px] text-foreground"><FolderOpen className="size-3.5 text-muted-foreground" /><span className="truncate" title={previewSource}>{previewSource}</span></div><div className="mt-1.5 text-[10px] text-muted-foreground">{previewFiles}</div><div className="mt-2 grid grid-cols-3 gap-1 border-t border-border pt-2 text-center"><span><b className="block text-sm font-semibold text-foreground">{source === 'directory' ? directory.excludes.length : filelists.filter((filelist) => filelist.trim()).length}</b><em className="not-italic text-[9px] text-muted-foreground">输入</em></span><span><b className="block text-sm font-semibold text-foreground">{directory.incdirs.length}</b><em className="not-italic text-[9px] text-muted-foreground">include</em></span><span><b className="block text-sm font-semibold text-foreground">{directory.defines.length}</b><em className="not-italic text-[9px] text-muted-foreground">define</em></span></div></div></div>
          <div><h4 className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">顶层候选</h4><div className="rounded border border-border bg-card p-2.5"><div className="flex items-center gap-2"><span className="size-2 rounded-full bg-primary" /><span className="truncate font-mono text-[10px] text-foreground">{topInput.trim() || '尚未选择顶层'}</span></div>{detectedTops && detectedTops.length > 0 && <p className="mt-1.5 text-[9px] text-muted-foreground">已检测到 {detectedTops.length} 个候选</p>}</div></div>
          <div><h4 className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">注意</h4><p className="rounded bg-amber-500/10 p-2.5 text-[10px] leading-relaxed text-muted-foreground"><AlertTriangle className="mr-1 inline size-3 text-amber-500" />{previewNotice}</p></div>
          <div><h4 className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">规范化输入</h4><pre className="overflow-x-auto rounded bg-foreground p-2.5 font-mono text-[9px] leading-relaxed text-background">read_slang -f {source === 'directory' ? '.socverify/design/scanned.f' : (filelists.find((filelist) => filelist.trim()) || 'design/filelist.f')}\n--top {topInput.trim() || '<top>'} --keep-hierarchy{directory.defines.length > 0 ? `\n--define ${directory.defines[0]}` : ''}</pre></div>
        </div>
      </aside>
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
