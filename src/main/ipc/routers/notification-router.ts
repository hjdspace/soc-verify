/**
 * Notification router — 通知中心 tRPC 入口。
 *
 *   list        — 全量通知（渲染端启动时拉取，此后经 notification:event 同步）
 *   markRead    — 单条标为已读
 *   markAllRead — 全部标为已读
 */

import { t, TRPCError } from '../router-context';
import { notificationManager } from '../../notifications/notification-manager';

export const notificationRouter = t.router({
  list: t.procedure.query(async () => {
    await notificationManager.init();
    return notificationManager.list();
  }),

  markRead: t.procedure
    .input((raw): { id: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'id is required' });
      }
      return { id: r.id };
    })
    .mutation(async ({ input }) => {
      await notificationManager.init();
      await notificationManager.markRead(input.id);
      return { ok: true };
    }),

  markAllRead: t.procedure.mutation(async () => {
    await notificationManager.init();
    await notificationManager.markAllRead();
    return { ok: true };
  }),
});
