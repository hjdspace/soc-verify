/**
 * 通知中心 store（Issue #8）。
 *
 * 数据流：启动时经 trpc.notifications.list 拉取一次全量，此后主进程任意变更
 * （新增 / 已读）经 notification:event 全量同步（webContents.send + eventBridge，
 * tRPC subscription 不可用的硬约束）——整体替换列表，幂等无竞态。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import type { AppNotification, NotificationSyncEvent } from '@shared/types';

interface NotificationState {
  notifications: AppNotification[];
  /** init 已执行（幂等保护，多组件挂载只拉取/订阅一次） */
  initialized: boolean;
  /** 拉取初始列表 + 订阅 notification:event */
  init: () => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    void trpc.notifications.list.query().then((notifications) => {
      // 事件订阅先注册再落地列表：若同步事件先到，此处可能覆盖新数据——
      // 事件为全量同步，下一条事件即校正；列表替换仅初始化路径使用。
      set((s) => (s.notifications.length > 0 ? s : { notifications }));
    }).catch((err) => {
      console.warn('[notification] load failed:', err instanceof Error ? err.message : String(err));
      // 失败允许重试
      set({ initialized: false });
    });

    window.eventBridge?.onNotificationEvent((event: NotificationSyncEvent) => {
      if (event.type === 'sync') {
        set({ notifications: event.notifications });
      }
    });
  },

  markRead: async (id) => {
    // 乐观更新，主进程持久化成功后会经事件再同步一次（幂等）
    set((s) => ({
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    }));
    try {
      await trpc.notifications.markRead.mutate({ id });
    } catch {
      // 失败时下一条全量同步事件会校正
    }
  },

  markAllRead: async () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
    }));
    try {
      await trpc.notifications.markAllRead.mutate();
    } catch {
      // 同上
    }
  },
}));

/** 未读数（TitleBar 铃铛 badge） */
export const selectUnreadCount = (s: NotificationState): number =>
  s.notifications.filter((n) => !n.read).length;
