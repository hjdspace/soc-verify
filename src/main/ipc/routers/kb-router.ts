/**
 * Knowledge Base router — 注册、挂载、状态管理。
 *
 * Procedure（inline input validator，非 zod）：
 *   - kb.list       已注册库列表 + 每库文档数/分类数统计
 *   - kb.register   注册知识库（空目录初始化 / 已有目录兼容校验）
 *   - kb.unregister 注销知识库（已挂载的库不可注销）
 *   - kb.mount      挂载知识库到项目（v1 上限 1）
 *   - kb.unmount    卸载知识库
 *   - kb.status     当前挂载库 + 结构健康检查
 *
 * 错误处理：register/unregister/mount/unmount 返回 Result 联合
 * （{ ok: true, ...data } | { ok: false, error: KbError }），
 * 保留结构化错误码供渲染端精确分支处理。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { kbRegistry } from '../../kb/registry';
import type { KbRegistration, KbMount, KbError } from '../../kb/types';

// ── Result 联合类型（供 tRPC 输出推导） ─────────────────────────

type RegisterResult =
  | { ok: true; id: string; name: string; path: string; registeredAt: number }
  | { ok: false; error: KbError };

type UnregisterResult =
  | { ok: true }
  | { ok: false; error: KbError };

type MountResult =
  | { ok: true; data: KbMount }
  | { ok: false; error: KbError };

type UnmountResult =
  | { ok: true }
  | { ok: false; error: KbError };

export const kbRouter = t.router({
  // ─── kb.list ──────────────────────────────────────────────

  list: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const project = requireProject('default');
      return kbRegistry.list(project.rootPath);
    }),

  // ─── kb.register ──────────────────────────────────────────

  register: t.procedure
    .input((raw): { name: string; path: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      if (typeof r.path !== 'string' || r.path.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path is required' });
      }
      return { name: r.name.trim(), path: r.path.trim() };
    })
    .mutation(async ({ input }): Promise<RegisterResult> => {
      const result = await kbRegistry.register(input.name, input.path);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      const d: KbRegistration = result.data;
      return {
        ok: true,
        id: d.id,
        name: d.name,
        path: d.path,
        registeredAt: d.registeredAt,
      };
    }),

  // ─── kb.unregister ────────────────────────────────────────

  unregister: t.procedure
    .input((raw): { kbId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.kbId !== 'string' || r.kbId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'kbId is required' });
      }
      return { kbId: r.kbId.trim() };
    })
    .mutation(async ({ input }): Promise<UnregisterResult> => {
      const project = requireProject('default');
      const result = await kbRegistry.unregister(input.kbId, project.rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    }),

  // ─── kb.mount ─────────────────────────────────────────────

  mount: t.procedure
    .input((raw): { kbId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.kbId !== 'string' || r.kbId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'kbId is required' });
      }
      return { kbId: r.kbId.trim() };
    })
    .mutation(async ({ input }): Promise<MountResult> => {
      const project = requireProject('default');
      const result = await kbRegistry.mount(input.kbId, project.rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true, data: result.data };
    }),

  // ─── kb.unmount ───────────────────────────────────────────

  unmount: t.procedure
    .input((raw): { kbId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.kbId !== 'string' || r.kbId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'kbId is required' });
      }
      return { kbId: r.kbId.trim() };
    })
    .mutation(async ({ input }): Promise<UnmountResult> => {
      const project = requireProject('default');
      const result = await kbRegistry.unmount(input.kbId, project.rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    }),

  // ─── kb.status ────────────────────────────────────────────

  status: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const project = requireProject('default');
      return kbRegistry.status(project.rootPath);
    }),
});
