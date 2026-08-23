/**
 * NotificationCenter — TitleBar 通知铃铛 + 下拉面板（Issue #8）。
 *
 * 视觉规范：原型 .notif-wrap / .notif-dropdown（340px，z-index 70）。
 *   - 未读条目：标题加粗 + accent 圆点
 *   - 图标按类型着色：失败红 / 覆盖率蓝 / 评审琥珀 / 通过绿
 *   - 头部「全部标为已读」
 * 数据：notification store（启动拉取 + notification:event 全量同步）。
 */

import { useEffect, useRef, useState } from 'react';
import { Bell, Check, CircleAlert, FileText, TriangleAlert } from 'lucide-react';
import { useNotificationStore } from '@renderer/stores/notification';
import type { AppNotification, NotificationType } from '@shared/types';
import { cn } from '@renderer/lib/utils';

const TYPE_STYLE: Record<NotificationType, { icon: typeof Bell; className: string }> = {
  failure: { icon: TriangleAlert, className: 'bg-status-fail/10 text-status-fail' },
  coverage: { icon: CircleAlert, className: 'bg-status-running/10 text-status-running' },
  review: { icon: FileText, className: 'bg-status-aborted/10 text-status-aborted' },
  success: { icon: Check, className: 'bg-status-pass/10 text-status-pass' },
};

/** 相对时间（通知中心条目副行） */
function relativeTime(createdAt: number): string {
  const deltaSec = Math.round((Date.now() - createdAt) / 1000);
  if (deltaSec < 60) return '刚刚';
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} 分钟前`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)} 小时前`;
  return `${Math.floor(deltaSec / 86400)} 天前`;
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.notifications.filter((n) => !n.read).length);
  const init = useNotificationStore((s) => s.init);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);

  // 启动即拉取 + 订阅事件（未读计数与铃铛 badge 常驻，不依赖面板打开）
  useEffect(() => {
    init();
  }, [init]);

  // 点击面板外关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title="通知"
        aria-label={`通知（${unreadCount} 条未读）`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          'titlebar-no-drag',
          'relative grid h-7 w-7 place-items-center rounded transition-colors',
          'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
          open && 'bg-foreground/10 text-foreground',
        )}
      >
        <Bell className="size-3.5" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-status-fail px-[3px] text-[9px] font-semibold text-background"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="notification-dropdown"
          className="absolute right-0 top-full z-[70] mt-1.5 w-[340px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        >
          <div className="flex items-center border-b border-border px-3.5 py-2.5 text-xs font-semibold text-popover-foreground">
            通知
            <button
              type="button"
              className="ml-auto text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => void markAllRead()}
            >
              全部标为已读
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-3.5 py-6 text-center text-xs text-muted-foreground">暂无通知</div>
            ) : (
              notifications.map((n) => <NotificationItem key={n.id} notification={n} onRead={() => void markRead(n.id)} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationItem({ notification, onRead }: { notification: AppNotification; onRead: () => void }) {
  const { icon: Icon, className } = TYPE_STYLE[notification.type];
  return (
    <button
      type="button"
      onClick={onRead}
      className={cn(
        'flex w-full items-start gap-2.5 border-b border-border px-3.5 py-2.5 text-left transition-colors last:border-b-0',
        notification.read ? 'hover:bg-accent/50' : 'bg-accent/30 hover:bg-accent/50',
      )}
    >
      <span className={cn('grid size-6 shrink-0 place-items-center rounded-[7px]', className)}>
        <Icon className="size-3" />
      </span>
      <span className="min-w-0 flex-1 leading-relaxed">
        <span className={cn('block truncate text-xs', notification.read ? 'font-normal' : 'font-semibold')}>
          {notification.title}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
          {notification.detail ? `${notification.detail} · ` : ''}{relativeTime(notification.createdAt)}
        </span>
      </span>
      {!notification.read && (
        <span data-testid="unread-dot" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
      )}
    </button>
  );
}
