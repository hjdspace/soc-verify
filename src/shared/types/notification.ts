/**
 * 全局通知（通知中心 / TitleBar 铃铛）。
 *
 * 事件流：主进程 notificationManager 持久化到
 * `userData/socverify-data/notifications.json`（与项目状态 state_*.json 同级），
 * 并通过 `notification:event` IPC 通道（webContents.send + preload eventBridge，
 * tRPC subscription 不可用的硬约束）全量同步到渲染进程；渲染进程 store
 * 订阅后整体替换列表（幂等，无初始加载竞态）。
 */

/** 通知类型：失败红 / 覆盖率蓝 / 评审琥珀 / 通过绿 */
export type NotificationType = 'failure' | 'coverage' | 'review' | 'success';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  /** 补充信息（如「axi_lite 子系统 · 2 分钟前」的上下文部分） */
  detail?: string;
  /** 创建时间（epoch ms） */
  createdAt: number;
  read: boolean;
}

/** notification:event 载荷：任意变更（新增/已读）后全量同步 */
export interface NotificationSyncEvent {
  type: 'sync';
  notifications: AppNotification[];
}
