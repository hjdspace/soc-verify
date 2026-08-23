/**
 * 通知中心测试（Issue #8 验收）：
 *   - 未读计数 badge 联动铃铛
 *   - 下拉面板渲染：类型着色图标、未读高亮 + 圆点、空状态
 *   - 标为已读（单条点击）与全部标为已读
 *   - notification:event 事件推送入库（sync 全量同步驱动 UI 更新）
 */

// @vitest-environment jsdom
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification, NotificationSyncEvent } from '@shared/types';

// ── trpc mock（notification store 数据入口）─────────────────────
const trpcMocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<AppNotification[]>>(),
  markRead: vi.fn<(input: { id: string }) => Promise<{ ok: boolean }>>(),
  markAllRead: vi.fn<() => Promise<{ ok: boolean }>>(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    notifications: {
      list: { query: () => trpcMocks.list() },
      markRead: { mutate: (input: { id: string }) => trpcMocks.markRead(input) },
      markAllRead: { mutate: () => trpcMocks.markAllRead() },
    },
  },
}));

// ── eventBridge mock（notification:event 订阅捕获）──────────────
const notifListeners: Array<(event: NotificationSyncEvent) => void> = [];

beforeEach(() => {
  notifListeners.length = 0;
  (window as unknown as { eventBridge: unknown }).eventBridge = {
    onNotificationEvent: (callback: (event: NotificationSyncEvent) => void) => {
      notifListeners.push(callback);
      return () => {
        const idx = notifListeners.indexOf(callback);
        if (idx >= 0) notifListeners.splice(idx, 1);
      };
    },
  };
});

import { NotificationCenter } from '@renderer/components/layout/NotificationCenter';
import { useNotificationStore } from '@renderer/stores/notification';

function makeNotification(partial: Partial<AppNotification> & { id: string }): AppNotification {
  return {
    type: 'success',
    title: partial.title ?? '通知',
    createdAt: Date.now(),
    read: false,
    ...partial,
  };
}

/** 模拟主进程 notification:event 全量同步 */
function pushSync(notifications: AppNotification[]): void {
  for (const cb of notifListeners) cb({ type: 'sync', notifications });
}

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], initialized: false });
  trpcMocks.list.mockReset();
  trpcMocks.markRead.mockReset().mockResolvedValue({ ok: true });
  trpcMocks.markAllRead.mockReset().mockResolvedValue({ ok: true });
});

describe('NotificationCenter 未读计数与列表渲染', () => {
  it('badge 显示未读数；打开面板渲染通知列表与未读圆点', async () => {
    trpcMocks.list.mockResolvedValue([
      makeNotification({ id: 'n1', type: 'failure', title: '仿真失败 · case_a', read: false }),
      makeNotification({ id: 'n2', type: 'coverage', title: '覆盖率 87.3%', read: false }),
      makeNotification({ id: 'n3', type: 'success', title: '冒烟套件全部通过', read: true }),
    ]);
    render(<NotificationCenter />);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('2');

    fireEvent.click(screen.getByRole('button', { name: /通知/ }));
    expect(screen.getByTestId('notification-dropdown')).toBeInTheDocument();
    expect(screen.getByText('仿真失败 · case_a')).toBeInTheDocument();
    expect(screen.getByText('覆盖率 87.3%')).toBeInTheDocument();
    // 两条未读各一枚圆点
    expect(screen.getAllByTestId('unread-dot')).toHaveLength(2);
  });

  it('全部已读时 badge 隐藏；空列表显示空状态', async () => {
    trpcMocks.list.mockResolvedValue([]);
    render(<NotificationCenter />);

    await waitFor(() => expect(trpcMocks.list).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /通知/ }));
    expect(screen.getByText('暂无通知')).toBeInTheDocument();
  });

  it('未读条目标题加粗区分已读', async () => {
    trpcMocks.list.mockResolvedValue([
      makeNotification({ id: 'n1', title: '未读标题', read: false }),
      makeNotification({ id: 'n2', title: '已读标题', read: true }),
    ]);
    render(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /通知/ }));

    expect(screen.getByText('未读标题').className).toContain('font-semibold');
    expect(screen.getByText('已读标题').className).not.toContain('font-semibold');
  });
});

describe('NotificationCenter 已读操作', () => {
  it('点击未读条目 → markRead 提交 + badge 递减（乐观更新）', async () => {
    trpcMocks.list.mockResolvedValue([
      makeNotification({ id: 'n1', title: '通知一', read: false }),
      makeNotification({ id: 'n2', title: '通知二', read: false }),
    ]);
    render(<NotificationCenter />);

    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('2');
    fireEvent.click(screen.getByRole('button', { name: /通知/ }));
    fireEvent.click(screen.getByText('通知一'));

    await waitFor(() => expect(trpcMocks.markRead).toHaveBeenCalledWith({ id: 'n1' }));
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');
  });

  it('全部标为已读 → badge 消失 + 圆点清零', async () => {
    trpcMocks.list.mockResolvedValue([
      makeNotification({ id: 'n1', title: '通知一', read: false }),
      makeNotification({ id: 'n2', title: '通知二', read: false }),
    ]);
    render(<NotificationCenter />);

    fireEvent.click(await screen.findByRole('button', { name: /通知/ }));
    fireEvent.click(screen.getByText('全部标为已读'));

    await waitFor(() => expect(trpcMocks.markAllRead).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('unread-dot')).not.toBeInTheDocument();
  });
});

describe('NotificationCenter 事件推送入库', () => {
  it('notification:event sync → 新通知进入列表并联动 badge', async () => {
    trpcMocks.list.mockResolvedValue([]);
    render(<NotificationCenter />);

    await waitFor(() => expect(trpcMocks.list).toHaveBeenCalled());
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();

    act(() => {
      pushSync([
        makeNotification({ id: 'live-1', type: 'failure', title: '仿真失败 · live_case', read: false }),
      ]);
    });

    // 铃铛 badge 联动（未打开面板）
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: /通知/ }));
    expect(screen.getByText('仿真失败 · live_case')).toBeInTheDocument();
  });

  it('sync 覆盖式更新：已读态变更后全量替换', async () => {
    trpcMocks.list.mockResolvedValue([
      makeNotification({ id: 'n1', title: '通知一', read: false }),
    ]);
    render(<NotificationCenter />);
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('1');

    act(() => {
      pushSync([makeNotification({ id: 'n1', title: '通知一', read: true })]);
    });
    expect(screen.queryByTestId('notification-badge')).not.toBeInTheDocument();
  });
});
