/**
 * RTL 设计视图领域 router（ADR 0032 / spec: docs/specs/rtl-design-view-spec.md）。
 *
 * issue 01：三工具可用性状态查询（UI 降级提示数据源）。
 * issue 02 tracer bullet：Design Source 配置 → 手动刷新 elaboration →
 * SQLite 提炼模型 → 子树查询（渲染端零解析）。
 *
 * 测试主 seam 即本 router 的 tRPC procedure 边界（mock yosys spawn）。
 */

import { t, TRPCError } from '../router-context';
import { requireProject } from '../../services/project-service';
import { getRtlToolsStatus } from '../../rtl/binary';
import {
  detectTops,
  getStatus,
  loadDesignConfig,
  loadDetectedTops,
  queryChildren,
  queryDef,
  queryRoot,
  querySubgraph,
  refresh,
  saveDesignConfig,
} from '../../rtl/design-service';
import { RtlElaborationError } from '../../rtl/elaborator';

/** inline validator：projectId 必填 */
const projectIdInput = (raw: unknown): { projectId: string } => {
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
  }
  return { projectId: r.projectId };
};

export const rtlRouter = t.router({
  /** 三工具（yosys / slang-server / verible）路径解析与可用性状态。 */
  toolsStatus: t.procedure.query(() => getRtlToolsStatus()),

  // ── Design Source 配置（issue 02）────────────────────────

  getConfig: t.procedure
    .input(projectIdInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return loadDesignConfig(project.rootPath);
    }),

  setConfig: t.procedure
    .input((raw): { projectId: string; filelists: string[]; top: string | null } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (!Array.isArray(r.filelists) || r.filelists.some((f) => typeof f !== 'string')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filelists must be a string array' });
      }
      if (r.top !== null && typeof r.top !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'top must be a string or null' });
      }
      return {
        projectId: r.projectId,
        filelists: r.filelists as string[],
        top: (r.top as string | null) ?? null,
      };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      const top = input.top !== null && input.top.trim().length > 0 ? input.top.trim() : null;
      saveDesignConfig(project.rootPath, {
        filelists: input.filelists.map((f) => f.trim()).filter((f) => f.length > 0),
        top,
      });
      return { ok: true as const };
    }),

  /** 检测顶层模块（elaborated top units，read_slang 自动判定顶层，全量走一遍提炼前端） */
  detectTops: t.procedure
    .input(projectIdInput)
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      try {
        return { tops: await detectTops(input.projectId, project.rootPath) };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  /** 上次检测的 top units 列表（持久化于 .socverify/design/tops.json，选择器直接恢复） */
  getDetectedTops: t.procedure
    .input(projectIdInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return { tops: loadDetectedTops(project.rootPath) };
    }),

  // ── 状态与数据（秒开：DB 有数据直接查，不触发 elaboration）──

  getStatus: t.procedure
    .input(projectIdInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return getStatus(input.projectId, project.rootPath);
    }),

  /** 手动刷新（对齐 Case Scan 模式）：失败返回结构化错误（slang 诊断含文件+行号） */
  refresh: t.procedure
    .input(projectIdInput)
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      return refresh(input.projectId, project.rootPath);
    }),

  /** 层级树根实例（顶层模块本身） */
  getRoot: t.procedure
    .input(projectIdInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return queryRoot(input.projectId, project.rootPath);
    }),

  /** 子树懒加载：直接子实例（SoC 级数据不整树进渲染进程） */
  getChildren: t.procedure
    .input((raw): { projectId: string; path: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.path !== 'string' || r.path.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path is required' });
      }
      return { projectId: r.projectId, path: r.path };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return queryChildren(input.projectId, project.rootPath, input.path);
    }),

  /** Module Definition 详情（端口全表，供接口视图/树节点查看） */
  getDef: t.procedure
    .input((raw): { projectId: string; name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.name !== 'string' || r.name.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { projectId: r.projectId, name: r.name };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return queryDef(input.projectId, project.rootPath, input.name);
    }),

  /** 框图子图（issue 05）：以任意实例为图根的直接子实例 + 连线表 + bundle 打标 */
  getSubgraph: t.procedure
    .input((raw): { projectId: string; path: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.path !== 'string' || r.path.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path is required' });
      }
      return { projectId: r.projectId, path: r.path };
    })
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return querySubgraph(input.projectId, project.rootPath, input.path);
    }),
});

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof RtlElaborationError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err.toElaborationError() });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : String(err),
  });
}
