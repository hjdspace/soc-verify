/**
 * KbWikiTasks — wiki 库导入任务面板（issue 03）+ PDF 资产查看（issue 11）。
 *
 * 用户从这里控制导入队列：来源加入队列、暂停/继续、取消/重试/上下移、
 * 清除已完成；重启恢复的 restoredWaiting 横幅提供「继续」入口。
 * 快照经 kb.queueSnapshot 拉取，kb:task 事件按 seq 增量应用。
 *
 * PDF 来源（issue 11）可展开图像资产面板：清单摘要（页进度/失败/跳过）、
 * 资产缩略图（kb.pdfAssetFile 解析路径 → local-resource:// 加载）、
 * 点击卡片看页码/坐标/渲染参数（返回原页信息）、继续渲染剩余页。
 *
 * @see src/renderer/src/stores/kb-queue.ts — 状态与操作
 * @see docs/prototypes/knowledge-base.html — UI 原型
 */

import { useEffect, useCallback, useState } from 'react';
import { ListTodo, Pause, Play, Trash2, RotateCcw, XCircle, ArrowUp, ArrowDown, Plus, Sparkles, AlertTriangle, Image as ImageIcon } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@main/ipc/router';
import { useKbQueueStore } from '@renderer/stores/kb-queue';
import { useKbStore } from '@renderer/stores/kb';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { WikiIngestPhase, WikiIngestTask, WikiSourceSummary, WikiTaskUsage } from '@shared/kb-types';
import { isActivePhase, isRetryablePhase } from '@shared/kb-task-phases';

type PdfAssetsOutput = inferRouterOutputs<AppRouter>['kb']['pdfAssets'];
type PdfAssetsManifest = NonNullable<PdfAssetsOutput['manifest']>;
type PdfAssetRecord = PdfAssetsManifest['assets'][number];
type PdfAssetStats = PdfAssetsManifest['stats'];

/** 本地文件 → local-resource:// URL（与主进程 local-resource-protocol 的编码约定一致） */
function localResourceUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return `local-resource://app/${encodeURIComponent(normalized)}`;
}

const METHOD_LABELS: Record<PdfAssetRecord['method'], string> = {
  object: '位图',
  'page-render': '整页渲染',
};

const PHASE_LABELS: Record<WikiIngestPhase, string> = {
  queued: '排队中',
  converting: '转换中',
  vision: '视觉解析',
  analyzing: '分析中',
  generating: '生成中',
  validating: '校验中',
  awaiting_review: '待审核',
  committing: '提交中',
  published: '已发布',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  blocked: '已阻塞',
};

const PHASE_STYLES: Partial<Record<WikiIngestPhase, string>> = {
  queued: 'bg-secondary text-secondary-foreground',
  converting: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  committing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  done: 'bg-green-500/15 text-green-600 dark:text-green-400',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
  blocked: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

const CANCELLABLE: ReadonlySet<WikiIngestPhase> = new Set([
  'queued',
  'converting',
  'vision',
  'analyzing',
  'generating',
  'validating',
  'awaiting_review',
]);

type WikiSourceSummaryLite = Pick<WikiSourceSummary, 'sourceId' | 'sourcePath' | 'ext'>;

function PhaseChip({ phase }: { phase: WikiIngestPhase }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
        PHASE_STYLES[phase] ?? 'bg-secondary text-secondary-foreground',
      )}
    >
      {PHASE_LABELS[phase]}
    </span>
  );
}

/**
 * 任务用量文本（issue 09）：只展示 API 实际给出的字段，
 * 全部缺失时返回空串（不显示伪造的 0 用量）。
 */
function usageText(usage: WikiTaskUsage | null | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`入 ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`出 ${usage.outputTokens}`);
  if (parts.length === 0 && usage.totalTokens !== undefined) parts.push(`共 ${usage.totalTokens}`);
  return parts.length > 0 ? `tokens ${parts.join(' / ')}` : '';
}

function TaskRow({ task, index, total }: { task: WikiIngestTask; index: number; total: number }) {
  const cancel = useKbQueueStore((s) => s.cancel);
  const retry = useKbQueueStore((s) => s.retry);
  const move = useKbQueueStore((s) => s.move);

  const active = task.phase === 'queued' || task.phase === 'converting' || task.phase === 'committing';
  const usage = usageText(task.usage);
  const retryCount = task.retryCount ?? 0;

  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-foreground" title={task.sourcePath}>
            {task.sourcePath || task.sourceId}
          </span>
          <PhaseChip phase={task.phase} />
          <span className="shrink-0 text-[10px] text-muted-foreground">第 {task.attempt} 次尝试</span>
        </div>
        {(retryCount > 0 || usage || task.progress) && (
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            {task.progress && task.progress.total > 0 && (
              <span title="长来源分段编译进度（已完成段数 / 总段数）">
                分段 {task.progress.done}/{task.progress.total}
              </span>
            )}
            {retryCount > 0 && (
              <span title="模型调用内部有界退避重试次数">已重试 {retryCount} 次</span>
            )}
            {usage && <span title="本次尝试 token 用量">{usage}</span>}
          </div>
        )}
        {task.lastError && (
          <div className="mt-0.5 truncate text-[10px] text-red-500" title={`${task.lastError.code}: ${task.lastError.message}`}>
            {task.lastError.message}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {task.phase === 'queued' && (
          <>
            <button
              onClick={() => void move(task.taskId, 'up')}
              disabled={index === 0}
              title="上移"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => void move(task.taskId, 'down')}
              disabled={index >= total - 1}
              title="下移"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {CANCELLABLE.has(task.phase) && (
          <button
            onClick={() => void cancel(task.taskId)}
            title="取消任务"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-red-500"
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        )}
        {isRetryablePhase(task.phase) && (
          <button
            onClick={() => void retry(task.taskId)}
            title={task.phase === 'blocked' ? '重试任务（补齐预算/配置后继续；已完成分段不会重做）' : '重试任务'}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {active && task.phase === 'committing' && (
          <span className="text-[10px] text-muted-foreground" title="正在提交，不可取消">
            提交中…
          </span>
        )}
      </div>
    </div>
  );
}

export function KbWikiTasks() {
  const snapshot = useKbQueueStore((s) => s.snapshot);
  const snapshotState = useKbQueueStore((s) => s.snapshotState);
  const loadSnapshot = useKbQueueStore((s) => s.loadSnapshot);
  const applyEvent = useKbQueueStore((s) => s.applyEvent);
  const pause = useKbQueueStore((s) => s.pause);
  const resume = useKbQueueStore((s) => s.resume);
  const clearFinished = useKbQueueStore((s) => s.clearFinished);
  const enqueue = useKbQueueStore((s) => s.enqueue);

  const mountedKbId = useKbStore((s) => s.kbStatus?.mounted?.kbId ?? null);

  // ── 快照拉取 + kb:task 事件订阅（重订阅先拉快照再按 seq 应用事件）──
  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot, mountedKbId]);

  useEffect(() => {
    if (!window.eventBridge) return;
    const unlisten = window.eventBridge.onKbTask((event) => {
      applyEvent(event);
    });
    return unlisten;
  }, [applyEvent]);

  // ── 来源列表（快照就绪后拉取，切库重拉）──
  const [sources, setSources] = useState<WikiSourceSummaryLite[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  // 当前展开 PDF 资产面板的来源（issue 11）
  const [assetsOpenFor, setAssetsOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (snapshotState !== 'ready') return;
    let cancelled = false;
    setSourcesLoading(true);
    trpc.kb.sources
      .query({})
      .then((rows) => {
        if (!cancelled) setSources(rows);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotState, mountedKbId]);

  const handleEnqueue = useCallback(
    (sourceId: string) => {
      void enqueue([sourceId]);
    },
    [enqueue],
  );

  const compile = useKbQueueStore((s) => s.compile);
  const handleCompile = useCallback(
    (sourceId: string) => {
      void compile(sourceId);
    },
    [compile],
  );

  const paused = snapshot?.paused ?? false;
  const tasks = snapshot?.tasks ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── 恢复横幅：重启后有中断任务等待继续 ── */}
      {snapshot?.restoredWaiting && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            检测到上次中断的任务，已恢复到安全状态，等待继续处理。
          </span>
          <button
            onClick={() => void resume()}
            title="继续处理队列任务"
            className="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 font-medium transition-colors hover:bg-amber-500/30"
          >
            <Play className="h-3 w-3" />
            继续
          </button>
        </div>
      )}

      {/* ── 持久化失败横幅 ── */}
      {snapshot?.lastPersistError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          队列持久化失败，处理已暂停：{snapshot.lastPersistError}
        </div>
      )}

      {/* ── 队列工具栏 ── */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">导入队列</span>
        <span className="text-[10px] text-muted-foreground">
          {tasks.filter((t) => isActivePhase(t.phase)).length} 个进行中 · 共 {tasks.length} 项
        </span>
        {paused && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">已暂停</span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void (paused ? resume() : pause())}
          title={paused ? '继续处理队列任务' : '暂停队列'}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {paused ? '继续' : '暂停'}
        </button>
        <button
          onClick={() => void clearFinished()}
          title="清除已完成任务"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="h-3 w-3" />
          清除已完成
        </button>
      </div>

      {/* ── 任务列表 ── */}
      {tasks.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">
          队列为空：从下方来源列表把文档加入导入队列
        </div>
      ) : (
        <div>
          {tasks.map((task, i) => (
            <TaskRow key={task.taskId} task={task} index={i} total={tasks.length} />
          ))}
        </div>
      )}

      {/* ── 来源列表（加入队列入口 + PDF 资产查看）── */}
      <SourceList
        sources={sources}
        sourcesLoading={sourcesLoading}
        assetsOpenFor={assetsOpenFor}
        onToggleAssets={(id) => setAssetsOpenFor((cur) => (cur === id ? null : id))}
        onEnqueue={handleEnqueue}
        onCompile={handleCompile}
      />
    </div>
  );
}

// ── PDF 资产面板（issue 11）────────────────────────────────────

/** 资产缩略图：路径经 kb.pdfAssetFile 解析（只接受内容 hash），local-resource 加载 */
function AssetThumb({
  sourceId,
  revision,
  record,
  selected,
  onSelect,
}: {
  sourceId: string;
  revision: string;
  record: PdfAssetRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    trpc.kb.pdfAssetFile
      .query({ sourceId, revision, assetId: record.assetId })
      .then((r) => {
        if (alive && r.path) setSrc(localResourceUrl(r.path));
      })
      .catch(() => {
        // 解析失败保持占位（清单与缩略图不一致时用户仍能看到页码信息）
      });
    return () => {
      alive = false;
    };
  }, [sourceId, revision, record.assetId]);

  const label = METHOD_LABELS[record.method] ?? record.method;
  return (
    <button
      onClick={onSelect}
      data-testid={`pdf-asset-${record.assetId.slice(0, 8)}`}
      title={`第 ${record.page} 页 ${label}（${record.width} × ${record.height}）`}
      className={cn(
        'group flex w-24 flex-col overflow-hidden rounded border transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
      )}
    >
      <div className="flex h-16 items-center justify-center overflow-hidden bg-secondary/40">
        {src ? (
          <img src={src} alt={`第 ${record.page} 页 ${label}`} className="max-h-16 max-w-full object-contain" />
        ) : (
          <span className="text-[10px] text-muted-foreground">加载中…</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-1 px-1 py-0.5">
        <span className="text-[10px] font-medium text-foreground">第 {record.page} 页</span>
        <span className="rounded bg-secondary px-1 text-[9px] text-secondary-foreground">{label}</span>
      </div>
    </button>
  );
}

/** 单条资产详情（页码 = 返回原页定位；坐标为 PDF 用户空间） */
function AssetDetail({ record }: { record: PdfAssetRecord }) {
  return (
    <div
      data-testid="pdf-asset-detail"
      className="rounded border border-border bg-secondary/30 px-3 py-2 text-[11px] leading-relaxed"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">原页：第 {record.page} 页</span>
        <span className="rounded bg-secondary px-1 text-[10px] text-secondary-foreground">
          {METHOD_LABELS[record.method] ?? record.method}
        </span>
        <span className="text-muted-foreground">
          {record.width} × {record.height} px
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/70" title={record.assetId}>
          {record.assetId.slice(0, 12)}…
        </span>
      </div>
      {record.rect && (
        <div className="mt-0.5 text-muted-foreground">
          位置 {Math.round(record.rect.x)}, {Math.round(record.rect.y)} ·{' '}
          {Math.round(record.rect.width)} × {Math.round(record.rect.height)}（PDF 用户空间）
        </div>
      )}
      {record.render && (
        <div className="mt-0.5 text-muted-foreground">
          渲染参数 scale {record.render.scale} · 最长边 {record.render.maxEdge}
          {record.render.scaled ? '（已等比缩小）' : ''}
        </div>
      )}
    </div>
  );
}

function PdfAssetsPanel({ sourceId }: { sourceId: string }) {
  const [manifest, setManifest] = useState<PdfAssetsManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [limit, setLimit] = useState(60);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await trpc.kb.pdfAssets.query({ sourceId });
      setManifest(r.manifest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const extract = useCallback(
    async (render?: readonly number[]) => {
      setExtracting(true);
      setError(null);
      try {
        const res = await trpc.kb.pdfAssetExtract.mutate(
          render ? { sourceId, render: [...render] } : { sourceId },
        );
        if (!res.ok) setError(`${res.error.message}`);
        else setSelectedId(null);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setExtracting(false);
      }
    },
    [sourceId, load],
  );

  if (loading) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground" data-testid="pdf-assets-panel">
        加载图像资产…
      </div>
    );
  }

  return (
    <div className="border-t border-border/40 bg-secondary/20 px-3 py-2" data-testid="pdf-assets-panel">
      {error && <div className="mb-2 text-[11px] text-red-500">{error}</div>}

      {!manifest ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>尚未提取图像资产</span>
          <button
            onClick={() => void extract()}
            disabled={extracting}
            title="提取 PDF 图像资产"
            className="rounded bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
          >
            {extracting ? '提取中…' : '提取图片'}
          </button>
        </div>
      ) : (
        <>
          {/* 摘要：覆盖情况可解释，不默默只取前 N 张 */}
          <SummaryLine stats={manifest.stats} textLayer={manifest.textLayer} />

          {manifest.stats.failures.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {manifest.stats.failures.map((f, i) => (
                <li key={i} className="text-[10px] text-red-500">
                  第 {f.page} 页：{f.reason}
                </li>
              ))}
            </ul>
          )}

          {manifest.stats.renderRemaining.length > 0 && !extracting && (
            <button
              onClick={() => void extract(manifest.stats.renderRemaining)}
              title="渲染剩余未渲染页"
              className="mt-1 rounded bg-secondary px-2 py-1 text-[11px] text-secondary-foreground transition-colors hover:bg-accent"
            >
              继续渲染剩余 {manifest.stats.renderRemaining.length} 页
            </button>
          )}
          {extracting && <p className="mt-1 text-[11px] text-muted-foreground">提取中…</p>}

          {/* 资产网格 */}
          <div className="mt-2 flex flex-wrap gap-2">
            {manifest.assets.slice(0, limit).map((record) => (
              <AssetThumb
                key={`${record.assetId}-${record.page}-${record.method}`}
                sourceId={sourceId}
                revision={manifest.revision}
                record={record}
                selected={selectedId === record.assetId}
                onSelect={() => setSelectedId((cur) => (cur === record.assetId ? null : record.assetId))}
              />
            ))}
          </div>
          {manifest.assets.length > limit && (
            <button
              onClick={() => setLimit((l) => l + 120)}
              className="mt-1 text-[11px] text-primary underline underline-offset-2"
            >
              显示更多（还有 {manifest.assets.length - limit} 条记录）
            </button>
          )}

          {selectedId && manifest.assets.find((a) => a.assetId === selectedId) && (
            <div className="mt-2">
              <AssetDetail record={manifest.assets.find((a) => a.assetId === selectedId)!} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryLine({ stats, textLayer }: { stats: PdfAssetStats; textLayer: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">资产 {stats.bitmapAssets + stats.renderAssets}</span>
      <span>页 {stats.processedPages}/{stats.totalPages}</span>
      <span>失败 {stats.failedPages}</span>
      <span>跳过 {stats.skippedPages}</span>
      {stats.renderRemaining.length > 0 && <span>待渲染 {stats.renderRemaining.length} 页</span>}
      <span
        className={cn(
          'rounded px-1 text-[10px]',
          textLayer ? 'bg-secondary text-secondary-foreground' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        )}
        title={textLayer ? '来源含文本层' : '纯图像来源（扫描件）：原图可预览，但不承诺机械全文/OCR'}
      >
        {textLayer ? '含文本层' : '无文本层'}
      </span>
    </div>
  );
}

// ── 来源列表 ────────────────────────────────────────────────────

function SourceList({
  sources,
  sourcesLoading,
  assetsOpenFor,
  onToggleAssets,
  onEnqueue,
  onCompile,
}: {
  sources: WikiSourceSummaryLite[];
  sourcesLoading: boolean;
  assetsOpenFor: string | null;
  onToggleAssets: (sourceId: string) => void;
  onEnqueue: (sourceId: string) => void;
  onCompile: (sourceId: string) => void;
}) {
  return (
    <div className="mt-4 border-t border-border">
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground">库内来源</div>
      {sourcesLoading ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">加载来源…</div>
      ) : sources.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
          库内暂无来源文档
        </div>
      ) : (
        sources.map((s) => (
          <div key={s.sourceId}>
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-foreground" title={s.sourcePath}>
                {s.sourcePath}
              </span>
              {s.ext === '.pdf' && (
                <button
                  onClick={() => onToggleAssets(s.sourceId)}
                  title="查看 PDF 图像资产"
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ImageIcon className="h-3 w-3" />
                  图片
                </button>
              )}
              <button
                onClick={() => onEnqueue(s.sourceId)}
                title="加入队列"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                加入队列
              </button>
              <button
                onClick={() => onCompile(s.sourceId)}
                title="编译为知识页（提案经审阅后发布）"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Sparkles className="h-3 w-3" />
                编译
              </button>
            </div>
            {assetsOpenFor === s.sourceId && s.ext === '.pdf' && <PdfAssetsPanel sourceId={s.sourceId} />}
          </div>
        ))
      )}
    </div>
  );
}
