/**
 * KB 导入队列 store（issue 03）— 任务面板的状态与操作。
 *
 * 数据流：kb.queueSnapshot 拉快照 → kb:task 事件按 seq 增量应用
 * （旧 seq/未知库事件忽略；快照缺失时事件直接建立基线）。
 * 操作经 tRPC mutation；失败经 toast 提示，成功后重拉快照对齐。
 *
 * @see src/renderer/src/components/kb/KbWikiTasks.tsx — 面板组件
 * @see .scratch/llm-wiki/issues/03-durable-ingest-queue.md
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '@renderer/stores/toast';
import type { WikiQueueSnapshot, WikiTaskEvent } from '@shared/kb-types';

export type KbQueueSnapshotState = 'idle' | 'loading' | 'ready' | 'unavailable';

type KbQueueState = {
  /** 队列快照（null = 尚未拉取或队列不可用） */
  snapshot: WikiQueueSnapshot | null;
  snapshotState: KbQueueSnapshotState;
  loadSnapshot: () => Promise<void>;
  /** kb:task 事件入口（seq 守卫：只应用更新的序列） */
  applyEvent: (e: WikiTaskEvent) => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: (taskId: string) => Promise<void>;
  retry: (taskId: string) => Promise<void>;
  move: (taskId: string, direction: 'up' | 'down') => Promise<void>;
  clearFinished: () => Promise<void>;
  enqueue: (sourceIds: string[]) => Promise<void>;
  /** 编译单个来源（issue 08）：入队 compileSource 任务 */
  compile: (sourceId: string) => Promise<void>;
};

function toastError(message: string): void {
  useToastStore.getState().error(message);
}

export const useKbQueueStore = create<KbQueueState>((set, get) => ({
  snapshot: null,
  snapshotState: 'idle',

  loadSnapshot: async () => {
    set({ snapshotState: 'loading' });
    try {
      const r = await trpc.kb.queueSnapshot.query({});
      if (r.ok) {
        set({ snapshot: r.snapshot, snapshotState: 'ready' });
      } else {
        set({ snapshot: null, snapshotState: 'unavailable' });
      }
    } catch {
      set({ snapshot: null, snapshotState: 'unavailable' });
    }
  },

  applyEvent: (e) => {
    const cur = get().snapshot;
    // seq 守卫：快照缺失时事件直接建立基线；有快照时只应用更新的序列
    if (cur && e.kbId !== cur.kbId) return;
    if (cur && e.seq <= cur.seq) return;

    if (e.type === 'queue') {
      if (!cur) {
        set({
          snapshot: {
            kbId: e.kbId,
            paused: e.paused,
            seq: e.seq,
            restoredWaiting: e.restoredWaiting,
            lastPersistError: null,
            tasks: [],
          },
          snapshotState: 'ready',
        });
        return;
      }
      set({
        snapshot: {
          ...cur,
          seq: e.seq,
          paused: e.paused,
          restoredWaiting: e.restoredWaiting,
        },
      });
      return;
    }

    // task 事件：更新匹配任务；未知任务（快照竞态落后）追加
    if (!cur) {
      set({
        snapshot: {
          kbId: e.kbId,
          paused: false,
          seq: e.seq,
          restoredWaiting: false,
          lastPersistError: null,
          tasks: [],
        },
        snapshotState: 'ready',
      });
      // 追加路径在下方统一处理
    }
    const base = get().snapshot;
    if (!base) return;
    const idx = base.tasks.findIndex((t) => t.taskId === e.taskId);
    const tasks = [...base.tasks];
    if (idx >= 0) {
      const prev = tasks[idx]!;
      tasks[idx] = {
        ...prev,
        phase: e.phase,
        attemptId: e.attemptId,
        lastError: e.lastError ?? null,
        // usage/retryCount 缺省表示本次事件未变化（保留上一次已知值）
        usage: e.usage ?? prev.usage ?? null,
        retryCount: e.retryCount ?? prev.retryCount ?? 0,
        // progress 缺省表示本次事件未变化；显式 null 表示已清空（issue 10）
        progress: e.progress === undefined ? (prev.progress ?? null) : e.progress,
      };
    } else {
      tasks.push({
        taskId: e.taskId,
        kbId: e.kbId,
        kind: 'convertSource',
        sourceId: '',
        sourcePath: '',
        phase: e.phase,
        attemptId: e.attemptId,
        attempt: 0,
        lastError: e.lastError ?? null,
        usage: e.usage ?? null,
        retryCount: e.retryCount ?? 0,
        progress: e.progress ?? null,
        enqueuedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
    }
    set({ snapshot: { ...base, seq: e.seq, tasks } });
  },

  pause: async () => {
    const r = await trpc.kb.queuePause.mutate({});
    if (!r.ok) {
      toastError(`暂停失败（${r.error.code}）：${r.error.message}`);
      return;
    }
    await get().loadSnapshot();
  },

  resume: async () => {
    const r = await trpc.kb.queueResume.mutate({});
    if (!r.ok) {
      toastError(`继续失败（${r.error.code}）：${r.error.message}`);
      return;
    }
    await get().loadSnapshot();
  },

  cancel: async (taskId) => {
    const r = await trpc.kb.queueCancel.mutate({ taskId });
    if (!r.ok) {
      toastError(`取消失败（${r.error.code}）：${r.error.message}`);
      return;
    }
    await get().loadSnapshot();
  },

  retry: async (taskId) => {
    const r = await trpc.kb.queueRetry.mutate({ taskId });
    if (!r.ok) {
      toastError(`重试失败（${r.error.code}）：${r.error.message}`);
      return;
    }
    await get().loadSnapshot();
  },

  move: async (taskId, direction) => {
    const r = await trpc.kb.queueMove.mutate({ taskId, direction });
    if (r.moved) await get().loadSnapshot();
  },

  clearFinished: async () => {
    const r = await trpc.kb.queueClear.mutate({});
    if (r.removed > 0) await get().loadSnapshot();
  },

  enqueue: async (sourceIds) => {
    const r = await trpc.kb.queueEnqueue.mutate({ sourceIds });
    const failed = r.results.filter((x) => !x.ok);
    if (failed.length > 0) {
      const first = failed[0]!;
      toastError(`加入队列失败（${first.error.code}）：${first.error.message}`);
    }
    await get().loadSnapshot();
  },

  compile: async (sourceId) => {
    const r = await trpc.kb.wikiCompileEnqueue.mutate({ sourceId });
    const first = r.results[0];
    if (first && !first.ok) {
      toastError(`编译入队失败（${first.error.code}）：${first.error.message}`);
    }
    await get().loadSnapshot();
  },
}));
