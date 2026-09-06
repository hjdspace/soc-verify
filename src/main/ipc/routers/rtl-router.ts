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
import { stripPathQuotes } from '../../rtl/filelist';
import {
  getLspStatus,
  lspDefinition,
  lspDidChange,
  lspDidOpen,
  lspHover,
  restartLsp,
  startLsp,
  stopLsp,
} from '../../rtl/lsp-manager';
import { runVeribleLint, type VeribleLintDiagnostic } from '../../rtl/verible-lint';
import type { DesignSourceConfig } from '../../rtl/types';

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
    .input((raw): { projectId: string; source?: 'filelist' | 'directory'; filelists: string[]; directory?: DesignSourceConfig['directory']; top: string | null } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (!Array.isArray(r.filelists) || r.filelists.some((f) => typeof f !== 'string')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filelists must be a string array' });
      }
      if (r.source !== undefined && r.source !== 'filelist' && r.source !== 'directory') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'source must be filelist or directory' });
      }
      const source = r.source === 'directory' ? 'directory' : 'filelist';
      let directory: DesignSourceConfig['directory'];
      if (r.directory !== undefined) {
        const d = r.directory as Record<string, unknown>;
        if (typeof d.root !== 'string') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'directory.root must be a string' });
        }
        for (const key of ['excludes', 'incdirs', 'defines']) {
          if (d[key] !== undefined && (!Array.isArray(d[key]) || (d[key] as unknown[]).some((item) => typeof item !== 'string'))) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `directory.${key} must be a string array` });
          }
        }
        directory = {
          root: d.root,
          excludes: Array.isArray(d.excludes) ? d.excludes as string[] : [],
          incdirs: Array.isArray(d.incdirs) ? d.incdirs as string[] : [],
          defines: Array.isArray(d.defines) ? d.defines as string[] : [],
        };
      }
      if (r.top !== null && typeof r.top !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'top must be a string or null' });
      }
      return {
        projectId: r.projectId,
        source,
        filelists: r.filelists as string[],
        directory,
        top: (r.top as string | null) ?? null,
      };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      const top = input.top !== null && input.top.trim().length > 0 ? input.top.trim() : null;
      // stripPathQuotes：去除「复制文件地址」粘贴带来的首尾引号（含 trim）
      saveDesignConfig(project.rootPath, {
        source: input.source,
        filelists: input.filelists.map((f) => stripPathQuotes(f)).filter((f) => f.length > 0),
        directory: input.directory
          ? {
              root: stripPathQuotes(input.directory.root),
              excludes: input.directory.excludes.map((item) => stripPathQuotes(item)).filter((item) => item.length > 0),
              incdirs: input.directory.incdirs.map((item) => stripPathQuotes(item)).filter((item) => item.length > 0),
              defines: input.directory.defines.map((item) => item.trim()).filter((item) => item.length > 0),
            }
          : undefined,
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

  // ── slang-server LSP 桥（issue 06：诊断 + hover + 跳转）──

  /** 启动 LSP 进程（slang-server 不可用时返回 null） */
  lspStart: t.procedure
    .input(projectIdInput)
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      return startLsp(input.projectId, project.rootPath);
    }),

  /** LSP 状态查询 */
  lspStatus: t.procedure
    .input(projectIdInput)
    .query(({ input }) => {
      const project = requireProject(input.projectId);
      return getLspStatus(input.projectId, project.rootPath);
    }),

  /** textDocument/didOpen — 打开 .sv 文件 */
  lspOpen: t.procedure
    .input((raw): { projectId: string; uri: string; text: string; version: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      if (typeof r.uri !== 'string' || r.uri.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'uri is required' });
      if (typeof r.text !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'text is required' });
      if (typeof r.version !== 'number') throw new TRPCError({ code: 'BAD_REQUEST', message: 'version is required' });
      return { projectId: r.projectId, uri: r.uri, text: r.text, version: r.version };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      lspDidOpen(input.projectId, project.rootPath, { uri: input.uri, text: input.text, version: input.version });
      return { ok: true as const };
    }),

  /** textDocument/didChange — 全量文本替换 */
  lspChange: t.procedure
    .input((raw): { projectId: string; uri: string; text: string; version: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      if (typeof r.uri !== 'string' || r.uri.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'uri is required' });
      if (typeof r.text !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'text is required' });
      if (typeof r.version !== 'number') throw new TRPCError({ code: 'BAD_REQUEST', message: 'version is required' });
      return { projectId: r.projectId, uri: r.uri, text: r.text, version: r.version };
    })
    .mutation(({ input }) => {
      const project = requireProject(input.projectId);
      lspDidChange(input.projectId, project.rootPath, { uri: input.uri, text: input.text, version: input.version });
      return { ok: true as const };
    }),

  /** textDocument/hover — 悬停符号信息 */
  lspHover: t.procedure
    .input((raw): { projectId: string; uri: string; line: number; character: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      if (typeof r.uri !== 'string' || r.uri.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'uri is required' });
      if (typeof r.line !== 'number') throw new TRPCError({ code: 'BAD_REQUEST', message: 'line is required' });
      if (typeof r.character !== 'number') throw new TRPCError({ code: 'BAD_REQUEST', message: 'character is required' });
      return { projectId: r.projectId, uri: r.uri, line: r.line, character: r.character };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return lspHover(input.projectId, project.rootPath, { uri: input.uri, position: { line: input.line, character: input.character } });
    }),

  /** textDocument/definition — 跳转定义（跨文件） */
  lspDefinition: t.procedure
    .input((raw): { projectId: string; uri: string; line: number; character: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      if (typeof r.uri !== 'string' || r.uri.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'uri is required' });
      if (typeof r.line !== 'number') throw new TRPCError({ code: 'BAD_REQUEST', message: 'line is required' });
      if (typeof r.character !== 'number') throw new TRPCError({ code: 'BAD_REQUEST', message: 'character is required' });
      return { projectId: r.projectId, uri: r.uri, line: r.line, character: r.character };
    })
    .query(async ({ input }) => {
      const project = requireProject(input.projectId);
      return lspDefinition(input.projectId, project.rootPath, { uri: input.uri, position: { line: input.line, character: input.character } });
    }),

  /** 关闭 LSP 进程（闲置/关闭视图时调用，不泄漏） */
  lspStop: t.procedure
    .input(projectIdInput)
    .mutation(async ({ input }) => {
      await stopLsp(input.projectId);
      return { ok: true as const };
    }),

  /** 重启 LSP 进程（Design Source 变更后调用，编译选项共享不瞎报） */
  lspRestart: t.procedure
    .input(projectIdInput)
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      return restartLsp(input.projectId, project.rootPath);
    }),

  // ── verible lint（issue 08：风格检查，打开/保存时后台自动）────────

  /**
   * 对单个 .sv/.v 文件执行 verible lint，返回风格诊断。
   *
   * verible 不可用时返回空诊断（不抛出，渲染端静默降级）。
   * content 可选：提供时写入临时文件（编辑器未保存的修改也能实时 lint）。
   */
  lintFile: t.procedure
    .input((raw): { projectId: string; filePath: string; content?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      if (r.content !== undefined && typeof r.content !== 'string') throw new TRPCError({ code: 'BAD_REQUEST', message: 'content must be a string' });
      return { projectId: r.projectId, filePath: r.filePath, content: r.content as string | undefined };
    })
    .query(async ({ input }) => {
      requireProject(input.projectId);
      const result = await runVeribleLint({ filePath: input.filePath, content: input.content });
      return { diagnostics: result.diagnostics satisfies VeribleLintDiagnostic[] };
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
