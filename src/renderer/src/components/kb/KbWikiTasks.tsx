/**
 * KbWikiTasks — wiki 库导入任务面板（issue 03）。
 *
 * 用户从这里控制导入队列：来源加入队列、暂停/继续、取消/重试/上下移、
 * 清除已完成；重启恢复的 restoredWaiting 横幅提供「继续」入口。
 * 快照经 kb.queueSnapshot 拉取，kb:task 事件按 seq 增量应用。
 *
 * @see src/renderer/src/stores/kb-queue.ts — 状态与操作
 * @see docs/prototypes/knowledge-base.html — UI 原型
 */

import { useEffect, useCallback, useState } from 'react';
import { ListTodo, Pause, Play, Trash2, RotateCcw, XCircle, ArrowUp, ArrowDown, Plus, Sparkles, AlertTriangle } from 'lucide-react';
import { useKbQueueStore } from '@renderer/stores/kb-queue';
import { useKbStore } from '@renderer/stores/kb';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { WikiIngestPhase, WikiIngestTask, WikiSourceSummary, WikiTaskUsage } from '@shared/kb-types';

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
};

const PHASE_STYLES: Partial<Record<WikiIngestPhase, string>> = {
  queued: 'bg-secondary text-secondary-foreground',
  converting: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  committing: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  done: 'bg-green-500/15 text-green-600 dark:text-green-400',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
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

type WikiSourceSummaryLite = Pick<WikiSourceSummary, 'sourceId' | 'sourcePath'>;

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
        {(retryCount > 0 || usage) && (
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
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
        {(task.phase === 'failed' || task.phase === 'cancelled') && (
          <button
            onClick={() => void retry(task.taskId)}
            title="重试任务"
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
          {tasks.filter((t) => t.phase !== 'done' && t.phase !== 'failed' && t.phase !== 'cancelled').length} 个进行中 · 共 {tasks.length} 项
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

      {/* ── 来源列表（加入队列入口）── */}
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
            <div
              key={s.sourceId}
              className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-foreground" title={s.sourcePath}>
                {s.sourcePath}
              </span>
              <button
                onClick={() => handleEnqueue(s.sourceId)}
                title="加入队列"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                加入队列
              </button>
              <button
                onClick={() => handleCompile(s.sourceId)}
                title="编译为知识页（提案经审阅后发布）"
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Sparkles className="h-3 w-3" />
                编译
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
