/**
 * Knowledge Base router — 注册、挂载、状态管理、上传流水线。
 *
 * Procedure（inline input validator，非 zod）：
 *   - kb.list            已注册库列表（含格式 format 与可达性 state）
 *   - kb.register        注册知识库（空目录初始化 wiki 布局 / wiki 目录读取
 *                        库内 kbId；复制库冲突时 asCopy 注册为副本）
 *   - kb.unregister      注销知识库（不删除文件；已挂载的库不可注销）
 *   - kb.deleteKb        删除库（尚未支持，返回 deleteNotSupported）
 *   - kb.disposals       旧格式处置记录查询
 *   - kb.dismissDisposal 移除处置记录（不触碰库目录）
 *   - kb.mount           挂载知识库到项目（v1 上限 1；wiki 库挂载时执行事务恢复）
 *   - kb.unmount         卸载知识库
 *   - kb.status          当前挂载库 + 健康检查（legacy health + wikiHealth）
 *   - kb.upload / documents / delete / retry / categories / index / preview /
 *     moveCategory / renameCategory / reclassify / deepReindex
 *                        旧分类读写入口——挂载 wiki 布局库时明确不可用
 *                        （notAvailableForWikiLayout），能力由后继票接入
 *   - kb.importSources / sources / sourceParsed / sourceRevisions /
 *     sourceOriginal / convertSource / importExtensions
 *                        wiki 来源导入与修订保留（issue 02）：单文档/小批量
 *                        导入、来源列表、机械全文预览（身份解析）、修订核对、
 *                        原件路径解析、失败重试转换、能力清单
 *
 * 错误处理：register/unregister/mount/unmount 返回 Result 联合
 * （{ ok: true, ...data } | { ok: false, error: KbError }），
 * 保留结构化错误码供渲染端精确分支处理。
 *
 * 状态与进度通过原生 IPC 推送（kb:* 通道）。
 *
 * @see ADR 0034 — 知识库重构为 LLM Wiki 双层架构
 * @see ADR 0021 — anydoc 文档知识库（旧布局，已停用）
 */

import { dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import { projectManager } from '../../project/project-manager';
import { activeProject } from '../../services/project-service';
import { broadcastToWindows } from '../broadcast';
import { kbRegistry } from '../../kb/registry';
import {
  uploadDocument,
  listDocuments,
  deleteDocument,
  retryDocument,
  listCategories,
  readIndexMd,
  writeIndexMd,
  readMarkdownDoc,
  moveDocumentCategory,
  renameCategory,
  reclassifyDocument,
} from '../../kb/pipeline';
import { deepReindex, type DeepReindexEvent } from '../../kb/deep-reindexer';
import { resolveKbLlmConfig } from '../../kb/llm-config';
import { kbSettingsManager, ENGINE_IDS, type KbSettings } from '../../kb/kb-settings';
import { listConvertEngines, type ConvertEngineInfo } from '../../kb/engines';
import {
  convertWikiSource,
  importWikiSources,
  listImportExtensions,
  listSourceRevisions,
  listWikiSources,
  readWikiParsed,
  resolveWikiOriginalPath,
  WikiSourceError,
  type SourceConvertOutcome,
  type SourceImportInput,
  type SourceImportOutcome,
} from '../../kb/source-import';
import { wikiIngestQueue } from '../../kb/wiki-queue';
import { WikiQueueError, type WikiQueueAttachResult } from '../../kb/ingest-queue';
import {
  scanWikiCatalog,
  readWikiPage,
} from '../../kb/wiki-catalog';
import {
  readWikiRules,
  saveWikiRules,
} from '../../kb/wiki-rules';
import { parseWikiSchema } from '../../kb/wiki-schema';
import { WIKI_PAGE_TEMPLATES } from '../../kb/wiki-page';
import type {
  KbRegistration,
  KbMount,
  KbError,
  KbDocument,
  KbCategory,
  KbDocStatusEvent,
  KbRecoveryReport,
  KbFormat,
} from '../../kb/types';
import type {
  WikiParsedView,
  WikiQueueErrorCode,
  WikiQueueSnapshot,
  WikiSourceRevisionInfo,
  WikiSourceSummary,
  WikiIngestTask,
} from '@shared/kb-types';

// ── Result 联合类型（供 tRPC 输出推导） ─────────────────────────

type RegisterResult =
  | { ok: true; id: string; name: string; path: string; registeredAt: number; format: KbFormat }
  | { ok: false; error: KbError };

type UnregisterResult =
  | { ok: true }
  | { ok: false; error: KbError };

type MountResult =
  | { ok: true; data: KbMount; recovery: KbRecoveryReport | null; /** wiki 库挂载时的队列附着结果 */ queue?: WikiQueueAttachResult }
  | { ok: false; error: KbError };

type UnmountResult =
  | { ok: true }
  | { ok: false; error: KbError | { code: WikiQueueErrorCode; message: string } };

type QueueOpResult =
  | { ok: true }
  | { ok: false; error: { code: WikiQueueErrorCode; message: string } };

type QueueEnqueueResult = {
  results: Array<{ ok: true; task: WikiIngestTask } | { ok: false; error: { code: WikiQueueErrorCode; message: string } }>;
};

type QueueSnapshotResult =
  | { ok: true; snapshot: WikiQueueSnapshot }
  | { ok: false; reason: 'notMounted' | 'notWikiLayout' | 'notAttached' };

type UploadResult =
  | { ok: true; document: KbDocument }
  | { ok: false; error: { code: string; message: string } };

// ── 辅助函数 ─────────────────────────────────────────────────────

/** 旧分类入口对新布局不可用的统一错误信息 */
const WIKI_LAYOUT_UNAVAILABLE =
  '新布局（LLM Wiki）知识库暂不支持此能力：旧分类读写入口已停用，功能将由知识库新流水线提供';

/**
 * 获取当前挂载的知识库路径与格式。
 * 未挂载时抛出 TRPCError。
 */
async function getMountedKb(): Promise<{ path: string; format: KbFormat | null }> {
  const rootPath = activeProject().rootPath;
  const status = await kbRegistry.status(rootPath);
  if (!status.mounted) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '未挂载知识库，请先挂载' });
  }
  return { path: status.mounted.path, format: status.mounted.format };
}

/**
 * 获取当前挂载的知识库路径，并守卫旧分类读写入口：
 * wiki 布局挂载时这些入口必须明确不可用，不能对新布局误操作。
 */
async function getLegacyMountedKbPath(): Promise<string> {
  const mounted = await getMountedKb();
  if (mounted.format === 'wiki') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: WIKI_LAYOUT_UNAVAILABLE });
  }
  return mounted.path;
}

/**
 * 获取当前挂载的知识库路径，并守卫 wiki 来源入口：
 * 来源导入/预览/修订只对 wiki 布局挂载开放。
 */
async function getWikiMountedKbPath(): Promise<string> {
  const mounted = await getMountedKb();
  if (mounted.format !== 'wiki') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '当前挂载的不是 wiki 布局知识库' });
  }
  return mounted.path;
}

/** WikiSourceError → TRPCError（sourceNotFound 映射 NOT_FOUND，其余保持消息） */
function mapWikiSourceError(err: unknown): never {
  if (err instanceof WikiSourceError) {
    throw new TRPCError({
      code: err.code === 'sourceNotFound' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
      message: err.message,
    });
  }
  throw err;
}

/**
 * wiki 来源身份输入校验（issue 02 procedures 共用）：
 * sourceId 必填；optionalKeys 中给出的键须为非空字符串；均 trim。
 */
function parseSourceIdInput(
  raw: unknown,
  optionalKeys: readonly string[] = [],
): { sourceId: string } & Record<string, string> {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.sourceId !== 'string' || r.sourceId.trim().length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'sourceId is required' });
  }
  const out: Record<string, string> = { sourceId: r.sourceId.trim() };
  for (const key of optionalKeys) {
    const v = r[key];
    if (v !== undefined) {
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${key} must be a non-empty string when provided` });
      }
      out[key] = v.trim();
    }
  }
  return out as { sourceId: string } & Record<string, string>;
}

/**
 * 获取当前挂载的 wiki 布局知识库（路径 + kbId，队列 procedures 共用）。
 */
async function getWikiMountedKb(): Promise<{ path: string; kbId: string }> {
  const rootPath = activeProject().rootPath;
  const status = await kbRegistry.status(rootPath);
  if (!status.mounted) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '未挂载知识库，请先挂载' });
  }
  if (status.mounted.format !== 'wiki') {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '当前挂载的不是 wiki 布局知识库' });
  }
  return { path: status.mounted.path, kbId: status.mounted.kbId };
}

/** WikiQueueError → 结构化 Result（不抛错；渲染端按 code 分支处理） */
function queueErrorResult(err: unknown): { ok: false; error: { code: WikiQueueErrorCode; message: string } } {
  if (err instanceof WikiQueueError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  return { ok: false, error: { code: 'persistFailed', message: String(err) } };
}

/**
 * 推送文档状态变化事件到所有窗口。
 */
function notifyKbStatus(event: KbDocStatusEvent): void {
  broadcastToWindows('kb:docStatus', event);
}

/**
 * 推送深度重建进度事件到所有窗口。
 */
function notifyKbDeepReindex(event: DeepReindexEvent): void {
  broadcastToWindows('kb:deepReindex', event);
}

export const kbRouter = t.router({
  // ─── kb.list ──────────────────────────────────────────────

  list: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const rootPath = activeProject().rootPath;
      return kbRegistry.list(rootPath);
    }),

  // ─── kb.register ──────────────────────────────────────────

  register: t.procedure
    .input((raw): { name: string; path: string; asCopy?: boolean } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      if (typeof r.path !== 'string' || r.path.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'path is required' });
      }
      if (r.asCopy !== undefined && typeof r.asCopy !== 'boolean') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'asCopy must be a boolean' });
      }
      return {
        name: r.name.trim(),
        path: r.path.trim(),
        ...(r.asCopy === true ? { asCopy: true } : {}),
      };
    })
    .mutation(async ({ input }): Promise<RegisterResult> => {
      const result = await kbRegistry.register(input.name, input.path, { asCopy: input.asCopy });
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
        format: d.format,
      };
    }),

  // ─── kb.disposals ─────────────────────────────────────────
  //
  // 旧格式处置记录查询：已确认旧格式而移出活动使用的库路径。

  disposals: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      return kbRegistry.listDisposals();
    }),

  // ─── kb.dismissDisposal ───────────────────────────────────
  //
  // 移除处置记录（仅删除记录本身，不触碰库目录）。

  dismissDisposal: t.procedure
    .input((raw): { disposalId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.disposalId !== 'string' || r.disposalId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'disposalId is required' });
      }
      return { disposalId: r.disposalId.trim() };
    })
    .mutation(async ({ input }): Promise<UnregisterResult> => {
      const result = await kbRegistry.dismissDisposal(input.disposalId);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
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
      const rootPath = activeProject().rootPath;
      const result = await kbRegistry.unregister(input.kbId, rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return { ok: true };
    }),

  // ─── kb.deleteKb ──────────────────────────────────────────
  //
  // 删除知识库：注销注册 + 删除库目录全部内容。
  // 如果库已挂载，先自动卸载。

  deleteKb: t.procedure
    .input((raw): { kbId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.kbId !== 'string' || r.kbId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'kbId is required' });
      }
      return { kbId: r.kbId.trim() };
    })
    .mutation(async ({ input }): Promise<UnregisterResult> => {
      const rootPath = activeProject().rootPath;
      // 先解除队列绑定（中止可中止工作、等待提交、落安全状态）再删库：
      // flush 面向尚存在的目录；删库后再 flush 会因目录消失写失败。
      try {
        await wikiIngestQueue.detach(input.kbId);
      } catch {
        // 队列安全状态已尽力落盘；删除意图优先
      }
      const result = await kbRegistry.deleteKb(input.kbId, rootPath);
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
      const rootPath = activeProject().rootPath;
      const result = await kbRegistry.mount(input.kbId, rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      // wiki 库挂载 = 重开：registry.mount 内部已执行 recoverTransactions。
      // 旧布局的自动扫描（autoScanDocuments）已停用——wiki 布局没有
      // sources/ 文档流水线，导入由后继票的新链路提供。

      // wiki 库挂载时附着持久导入队列（issue 03）：恢复中断任务到安全状态
      // 并等待用户继续。附着失败不阻断挂载，结果透传给 UI 呈现（坏队列文件
      // 保留现场，不静默清空）。
      let queue: WikiQueueAttachResult | undefined;
      const status = await kbRegistry.status(rootPath);
      if (status.mounted && status.mounted.kbId === input.kbId && status.mounted.format === 'wiki') {
        queue = await wikiIngestQueue.attach(status.mounted.path, input.kbId);
      }
      return {
        ok: true,
        data: result.data.mount,
        recovery: result.data.recovery,
        ...(queue ? { queue } : {}),
      };
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
      const rootPath = activeProject().rootPath;
      const result = await kbRegistry.unmount(input.kbId, rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      // 卸载绑定原任务库：中止可中止工作、等待正在提交的工作、落安全状态。
      // 持久化失败不确认操作成功（结构化错误码透传）。
      try {
        await wikiIngestQueue.detach(input.kbId);
      } catch (err) {
        return queueErrorResult(err);
      }
      return { ok: true };
    }),

  // ─── kb.status ────────────────────────────────────────────

  status: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const rootPath = activeProject().rootPath;
      return kbRegistry.status(rootPath);
    }),

  // ─── kb.pickFiles ──────────────────────────────────────────
  //
  // 打开系统文件选择对话框，返回选中的文件路径列表。
  // 不依赖 projectId — 知识库的文件选择不需要项目上下文。

  pickFiles: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .mutation(async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        title: '选择文档上传到知识库',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const };
      }
      return { canceled: false as const, filePaths: result.filePaths };
    }),

  // ─── kb.upload ────────────────────────────────────────────

  upload: t.procedure
    .input((raw): { filePaths: string[] } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.filePaths) || r.filePaths.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePaths is required and must be non-empty' });
      }
      for (const p of r.filePaths) {
        if (typeof p !== 'string' || p.trim().length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'each filePath must be a non-empty string' });
        }
      }
      return { filePaths: r.filePaths as string[] };
    })
    .mutation(async ({ input }): Promise<{ results: UploadResult[] }> => {
      const kbPath = await getLegacyMountedKbPath();
      const llmConfig = await resolveKbLlmConfig();

      const results: UploadResult[] = [];
      for (const filePath of input.filePaths) {
        const result = await uploadDocument(filePath, kbPath, llmConfig, notifyKbStatus);
        if (result.ok) {
          results.push({ ok: true, document: result.document });
        } else {
          results.push({ ok: false, error: result.error });
        }
      }

      return { results };
    }),

  // ─── kb.documents ──────────────────────────────────────────

  documents: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async (): Promise<KbDocument[]> => {
      const kbPath = await getLegacyMountedKbPath();
      return listDocuments(kbPath);
    }),

  // ─── kb.delete ────────────────────────────────────────────

  delete: t.procedure
    .input((raw): { name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { name: r.name.trim() };
    })
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      const kbPath = await getLegacyMountedKbPath();
      await deleteDocument(kbPath, input.name);
      return { ok: true };
    }),

  // ─── kb.retry ─────────────────────────────────────────────

  retry: t.procedure
    .input((raw): { name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { name: r.name.trim() };
    })
    .mutation(async ({ input }): Promise<UploadResult> => {
      const kbPath = await getLegacyMountedKbPath();
      const llmConfig = await resolveKbLlmConfig();
      const result = await retryDocument(kbPath, input.name, llmConfig, notifyKbStatus);
      if (result.ok) {
        return { ok: true, document: result.document };
      }
      return { ok: false, error: result.error };
    }),

  // ─── kb.categories ─────────────────────────────────────────

  categories: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async (): Promise<KbCategory[]> => {
      const kbPath = await getLegacyMountedKbPath();
      return listCategories(kbPath);
    }),

  // ─── kb.index ──────────────────────────────────────────────

  index: t.procedure
    .input((raw): { content?: string } => {
      const r = raw as Record<string, unknown>;
      // If content is provided, it's a write; otherwise it's a read
      if (r.content !== undefined && typeof r.content !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'content must be a string' });
      }
      return { content: r.content as string | undefined };
    })
    .mutation(async ({ input }): Promise<{ content: string }> => {
      const kbPath = await getLegacyMountedKbPath();
      if (input.content !== undefined) {
        // Write mode
        await writeIndexMd(kbPath, input.content);
        return { content: input.content };
      }
      // Read mode
      const content = await readIndexMd(kbPath);
      return { content };
    }),

  // ─── kb.preview ────────────────────────────────────────────

  preview: t.procedure
    .input((raw): { name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { name: r.name.trim() };
    })
    .query(async ({ input }): Promise<{ content: string | null }> => {
      const kbPath = await getLegacyMountedKbPath();
      const content = await readMarkdownDoc(kbPath, input.name);
      return { content };
    }),

  // ─── kb.moveCategory ────────────────────────────────────────

  moveCategory: t.procedure
    .input((raw): { name: string; category: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      if (typeof r.category !== 'string' || r.category.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'category is required' });
      }
      return { name: r.name.trim(), category: r.category.trim() };
    })
    .mutation(async ({ input }): Promise<{ ok: true; newPath: string } | { ok: false; error: { code: string; message: string } }> => {
      const kbPath = await getLegacyMountedKbPath();
      const newPath = await moveDocumentCategory(kbPath, input.name, input.category);
      if (newPath === null) {
        return { ok: false, error: { code: 'notFound', message: `文档未找到: ${input.name}` } };
      }
      return { ok: true, newPath };
    }),

  // ─── kb.renameCategory ──────────────────────────────────────

  renameCategory: t.procedure
    .input((raw): { oldName: string; newName: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.oldName !== 'string' || r.oldName.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'oldName is required' });
      }
      if (typeof r.newName !== 'string' || r.newName.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'newName is required' });
      }
      return { oldName: r.oldName.trim(), newName: r.newName.trim() };
    })
    .mutation(async ({ input }): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> => {
      const kbPath = await getLegacyMountedKbPath();
      const success = await renameCategory(kbPath, input.oldName, input.newName);
      if (!success) {
        return { ok: false, error: { code: 'notFound', message: `分类不存在: ${input.oldName}` } };
      }
      return { ok: true };
    }),

  // ─── kb.reclassify ─────────────────────────────────────────
  //
  // AI 重新分类单个文档并重新生成标题/摘要/关键词。
  // 分类变化时自动移动文件到新分类目录并同步 index.md 路径。
  // 无 LLM 配置或调用失败时返回明确错误（不降级）。

  reclassify: t.procedure
    .input((raw): { name: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'name is required' });
      }
      return { name: r.name.trim() };
    })
    .mutation(async ({ input }): Promise<
      { ok: true; category: string; title: string; summary: string; keywords: string[]; moved: boolean }
      | { ok: false; error: { code: string; message: string } }
    > => {
      const kbPath = await getLegacyMountedKbPath();
      const llmConfig = await resolveKbLlmConfig();
      const result = await reclassifyDocument(kbPath, input.name, llmConfig);
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        category: result.entry.category,
        title: result.entry.title,
        summary: result.entry.summary,
        keywords: result.entry.keywords,
        moved: result.moved,
      };
    }),

  // ─── kb.deepReindex ────────────────────────────────────────

  deepReindex: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .mutation(async (): Promise<{ ok: true; sessionId: string; documentCount: number } | { ok: false; error: { code: string; message: string } }> => {
      const kbPath = await getLegacyMountedKbPath();
      const rootPath = activeProject().rootPath;
      const project = projectManager.getProjectByPath(rootPath);
      if (!project) {
        return { ok: false, error: { code: 'noProject', message: '未找到活跃项目' } };
      }

      const result = await deepReindex({
        kbPath,
        projectId: project.id,
        cwd: rootPath,
        notify: notifyKbDeepReindex,
      });

      if (result.ok) {
        return { ok: true, sessionId: result.sessionId, documentCount: result.documentCount };
      }
      return { ok: false, error: result.error };
    }),

  // ─── kb.getSettings ────────────────────────────────────────
  //
  // 知识库应用级设置（转换引擎 + AI 分类模型显式配置）。

  getSettings: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async (): Promise<{ settings: KbSettings; engines: ConvertEngineInfo[] }> => {
      const settings = await kbSettingsManager.load();
      return { settings, engines: listConvertEngines() };
    }),

  // ─── kb.updateSettings ─────────────────────────────────────
  //
  // 全量覆写知识库设置。llm.providerId/model 传空字符串即清除
  // （回退自动推导）。未提供的字段按默认值处理（覆写语义，
  // 渲染端先 load 再整体提交，与 TV 配置保存模式一致）。

  updateSettings: t.procedure
    .input((raw): { convertEngine: string; llm: { providerId?: string; model?: string } } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.convertEngine !== 'string' || !ENGINE_IDS.has(r.convertEngine)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'convertEngine must be anydoc' });
      }
      const llmRaw = (r.llm ?? {}) as Record<string, unknown>;
      if (
        (llmRaw.providerId !== undefined && typeof llmRaw.providerId !== 'string')
        || (llmRaw.model !== undefined && typeof llmRaw.model !== 'string')
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'llm.providerId and llm.model must be strings' });
      }
      return {
        convertEngine: r.convertEngine,
        llm: {
          providerId: typeof llmRaw.providerId === 'string' ? llmRaw.providerId : '',
          model: typeof llmRaw.model === 'string' ? llmRaw.model : '',
        },
      };
    })
    .mutation(async ({ input }): Promise<{ settings: KbSettings }> => {
      const settings = await kbSettingsManager.save({
        convertEngine: input.convertEngine as KbSettings['convertEngine'],
        llm: input.llm,
      });
      return { settings };
    }),

  // ─── kb.importSources（issue 02） ──────────────────────────
  //
  // 单文档/小批量导入到挂载的 wiki 库。逐文件独立结果，
  // 部分失败不影响其余（结构化错误码由渲染端分支处理）。

  importSources: t.procedure
    .input((raw): { items: SourceImportInput[] } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.items) || r.items.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'items is required and must be non-empty' });
      }
      const items: SourceImportInput[] = r.items.map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        if (typeof o.absolutePath !== 'string' || o.absolutePath.trim().length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'each item.absolutePath must be a non-empty string' });
        }
        if (o.relPath !== undefined && (typeof o.relPath !== 'string' || o.relPath.trim().length === 0)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'item.relPath must be a non-empty string when provided' });
        }
        return {
          absolutePath: o.absolutePath,
          ...(typeof o.relPath === 'string' ? { relPath: o.relPath } : {}),
        };
      });
      return { items };
    })
    .mutation(async ({ input }): Promise<{ results: SourceImportOutcome[] }> => {
      const kbPath = await getWikiMountedKbPath();
      return { results: await importWikiSources(kbPath, input.items) };
    }),

  // ─── kb.sources（issue 02） ────────────────────────────────
  //
  // wiki 库来源摘要列表（revisionShort / parsedStale 供 UI 核对）。

  sources: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async (): Promise<WikiSourceSummary[]> => {
      const kbPath = await getWikiMountedKbPath();
      return listWikiSources(kbPath);
    }),

  // ─── kb.sourceParsed（issue 02） ───────────────────────────
  //
  // 机械全文预览（身份解析而非任意路径）；revision/parsedHash
  // 指向历史快照时返回 isHistorical = true。

  sourceParsed: t.procedure
    .input((raw): { sourceId: string; revision?: string; parsedHash?: string } => {
      return parseSourceIdInput(raw, ['revision', 'parsedHash']);
    })
    .query(async ({ input }): Promise<WikiParsedView> => {
      const kbPath = await getWikiMountedKbPath();
      try {
        return await readWikiParsed(kbPath, input);
      } catch (err) {
        mapWikiSourceError(err);
        throw err; // 防御性兜底：保证所有代码路径都有返回/抛出，不依赖 never 注解
      }
    }),

  // ─── kb.sourceRevisions（issue 02） ────────────────────────
  //
  // 来源修订清单（当前 + 历史），UI 核对修订用。

  sourceRevisions: t.procedure
    .input((raw): { sourceId: string } => parseSourceIdInput(raw))
    .query(async ({ input }): Promise<WikiSourceRevisionInfo[]> => {
      const kbPath = await getWikiMountedKbPath();
      try {
        return await listSourceRevisions(kbPath, input.sourceId);
      } catch (err) {
        mapWikiSourceError(err);
        throw err; // 防御性兜底：保证所有代码路径都有返回/抛出，不依赖 never 注解
      }
    }),

  // ─── kb.sourceOriginal（issue 02） ─────────────────────────
  //
  // 从身份解析原件绝对路径（当前或历史修订）；
  // 未知来源/盘上缺失返回 null（不抛错）。

  sourceOriginal: t.procedure
    .input((raw): { sourceId: string; revision?: string } => {
      return parseSourceIdInput(raw, ['revision']);
    })
    .query(async ({ input }): Promise<{ path: string | null }> => {
      const kbPath = await getWikiMountedKbPath();
      return { path: await resolveWikiOriginalPath(kbPath, input) };
    }),

  // ─── kb.convertSource（issue 02） ──────────────────────────
  //
  // 失败重试 / 引擎指纹变更后重转。Result 联合返回（不抛错）。

  convertSource: t.procedure
    .input((raw): { sourceId: string } => parseSourceIdInput(raw))
    .mutation(async ({ input }): Promise<SourceConvertOutcome> => {
      const kbPath = await getWikiMountedKbPath();
      return convertWikiSource(kbPath, input.sourceId);
    }),

  // ─── kb.importExtensions（issue 02） ───────────────────────
  //
  // UI/工具能力清单：当前引擎可导入的扩展名（不宣称未支持格式）。

  importExtensions: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async (): Promise<{ extensions: string[] }> => {
      const settings = await kbSettingsManager.load();
      return { extensions: listImportExtensions(settings.convertEngine) };
    }),

  // ─── kb.queueSnapshot（issue 03） ──────────────────────────
  //
  // 导入队列快照（重订阅先拉快照再按 seq 应用 kb:task 事件）。
  // 队列未附着（挂载附着失败或非 wiki 挂载）返回 ok: false + 原因。

  queueSnapshot: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async (): Promise<QueueSnapshotResult> => {
      const kb = await getWikiMountedKb();
      const snapshot = wikiIngestQueue.snapshot(kb.kbId);
      if (!snapshot) return { ok: false, reason: 'notAttached' };
      return { ok: true, snapshot };
    }),

  // ─── kb.queueEnqueue（issue 03） ───────────────────────────
  //
  // 来源转换任务入队（持久队列）。逐来源独立结果：未知来源
  // sourceNotFound，持久化失败 persistFailed——操作不确认成功。

  queueEnqueue: t.procedure
    .input((raw): { sourceIds: string[] } => {
      const r = raw as Record<string, unknown>;
      if (!Array.isArray(r.sourceIds) || r.sourceIds.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sourceIds is required and must be non-empty' });
      }
      for (const id of r.sourceIds) {
        if (typeof id !== 'string' || id.trim().length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'each sourceId must be a non-empty string' });
        }
      }
      return { sourceIds: r.sourceIds as string[] };
    })
    .mutation(async ({ input }): Promise<QueueEnqueueResult> => {
      const kb = await getWikiMountedKb();
      const results: QueueEnqueueResult['results'] = [];
      for (const sourceId of input.sourceIds) {
        try {
          const task = await wikiIngestQueue.enqueueConvert(kb.kbId, sourceId);
          results.push({ ok: true, task });
        } catch (err) {
          results.push(queueErrorResult(err));
        }
      }
      return { results };
    }),

  // ─── kb.queuePause / kb.queueResume（issue 03） ────────────
  //
  // 队列级暂停/继续。暂停中止 converting（回 queued，消耗 attempt）、
  // 等待 committing 完成；resume 清除 paused/restoredWaiting 并恢复调度。

  queuePause: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .mutation(async (): Promise<QueueOpResult> => {
      const kb = await getWikiMountedKb();
      try {
        await wikiIngestQueue.pause(kb.kbId);
        return { ok: true };
      } catch (err) {
        return queueErrorResult(err);
      }
    }),

  queueResume: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .mutation(async (): Promise<QueueOpResult> => {
      const kb = await getWikiMountedKb();
      try {
        await wikiIngestQueue.resume(kb.kbId);
        return { ok: true };
      } catch (err) {
        return queueErrorResult(err);
      }
    }),

  // ─── kb.queueCancel / kb.queueRetry（issue 03） ────────────
  //
  // 任务级取消/重试。取消：converting 中止（attempt 失效使迟到结果不可
  // 提交）、committing 拒绝；重试：failed/cancelled → queued 新 attempt。

  queueCancel: t.procedure
    .input((raw): { taskId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.taskId !== 'string' || r.taskId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'taskId is required' });
      }
      return { taskId: r.taskId.trim() };
    })
    .mutation(async ({ input }): Promise<QueueOpResult> => {
      const kb = await getWikiMountedKb();
      try {
        await wikiIngestQueue.cancelTask(kb.kbId, input.taskId);
        return { ok: true };
      } catch (err) {
        return queueErrorResult(err);
      }
    }),

  queueRetry: t.procedure
    .input((raw): { taskId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.taskId !== 'string' || r.taskId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'taskId is required' });
      }
      return { taskId: r.taskId.trim() };
    })
    .mutation(async ({ input }): Promise<QueueOpResult> => {
      const kb = await getWikiMountedKb();
      try {
        await wikiIngestQueue.retryTask(kb.kbId, input.taskId);
        return { ok: true };
      } catch (err) {
        return queueErrorResult(err);
      }
    }),

  // ─── kb.queueMove / kb.queueClear（issue 03） ──────────────
  //
  // queued 子序列内上/下移（非 queued 是固定点，moved false）；
  // 清除 done 任务（failed/cancelled 保留供查看与重试）。

  queueMove: t.procedure
    .input((raw): { taskId: string; direction: 'up' | 'down' } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.taskId !== 'string' || r.taskId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'taskId is required' });
      }
      if (r.direction !== 'up' && r.direction !== 'down') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: "direction must be 'up' or 'down'" });
      }
      return { taskId: r.taskId.trim(), direction: r.direction };
    })
    .mutation(async ({ input }): Promise<{ moved: boolean }> => {
      const kb = await getWikiMountedKb();
      return { moved: await wikiIngestQueue.moveTask(kb.kbId, input.taskId, input.direction) };
    }),

  queueClear: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .mutation(async (): Promise<{ removed: number }> => {
      const kb = await getWikiMountedKb();
      return { removed: await wikiIngestQueue.clearFinished(kb.kbId) };
    }),

  // ─── kb.wikiCatalog（issue 04） ────────────────────────────
  //
  // 只读浏览：按 schema 路由编目 wiki/ 页面（pageId 含类型路径），
  // 聚合页与 orphan 单独归类。仅 wiki 布局挂载开放。

  wikiCatalog: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const kbPath = await getWikiMountedKbPath();
      return scanWikiCatalog(kbPath);
    }),

  // ─── kb.wikiPage（issue 04） ───────────────────────────────
  //
  // 只读阅读单个页面：pageId 必须在 catalog 中（不做任意路径拼接），
  // 读取前执行注册库路径校验（realpath 围栏）；返回统一解析的链接
  // （歧义报告全部候选，不取第一个）。

  wikiPage: t.procedure
    .input((raw): { pageId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.pageId !== 'string' || r.pageId.trim().length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'pageId is required' });
      }
      return { pageId: r.pageId.trim() };
    })
    .query(async ({ input }) => {
      const kbPath = await getWikiMountedKbPath();
      const res = await readWikiPage(kbPath, input.pageId);
      if (!res.ok) {
        const message =
          res.reason === 'unknownPage'
            ? `页面不存在或不在编目中: ${input.pageId}`
            : res.reason === 'outsideRoot'
              ? '页面真实路径逃逸出注册库根目录，拒绝读取'
              : res.reason === 'readFailed'
                ? `页面读取失败: ${input.pageId}`
                : 'schema.md 无法解析，页面目录不可用';
        throw new TRPCError({
          code: res.reason === 'unknownPage' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
          message,
        });
      }
      return res.page;
    }),

  // ─── kb.wikiRules（issue 04） ──────────────────────────────
  //
  // 读取写作规则（schema/purpose 原文 + schema 解析结果）。

  wikiRules: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const kbPath = await getWikiMountedKbPath();
      return readWikiRules(kbPath);
    }),

  // ─── kb.saveWikiRules（issue 04） ──────────────────────────
  //
  // 保存写作规则：schema 需通过受约束表校验且不重映射已有页面目录；
  // purpose 原文任意写。Result 联合返回（不抛错）。

  saveWikiRules: t.procedure
    .input((raw): { schemaRaw?: string; purposeRaw?: string } => {
      const r = raw as Record<string, unknown>;
      if (r.schemaRaw === undefined && r.purposeRaw === undefined) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'schemaRaw or purposeRaw is required' });
      }
      if (r.schemaRaw !== undefined && typeof r.schemaRaw !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'schemaRaw must be a string' });
      }
      if (r.purposeRaw !== undefined && typeof r.purposeRaw !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'purposeRaw must be a string' });
      }
      return {
        ...(typeof r.schemaRaw === 'string' ? { schemaRaw: r.schemaRaw } : {}),
        ...(typeof r.purposeRaw === 'string' ? { purposeRaw: r.purposeRaw } : {}),
      };
    })
    .mutation(async ({ input }) => {
      const kbPath = await getWikiMountedKbPath();
      return saveWikiRules(kbPath, input);
    }),

  // ─── kb.validateWikiSchema（issue 04） ─────────────────────
  //
  // 即时校验 schema 草稿（纯解析，不落盘）。规则编辑器防抖调用。

  validateWikiSchema: t.procedure
    .input((raw): { schemaRaw: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.schemaRaw !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'schemaRaw must be a string' });
      }
      return { schemaRaw: r.schemaRaw };
    })
    .mutation(async ({ input }) => {
      return parseWikiSchema(input.schemaRaw);
    }),

  // ─── kb.wikiTemplates（issue 04） ──────────────────────────
  //
  // 八类默认模板清单（模板正文骨架 + 默认 frontmatter 字段）。

  wikiTemplates: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      return { templates: Object.values(WIKI_PAGE_TEMPLATES) };
    }),
});
