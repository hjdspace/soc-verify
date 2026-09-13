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

// ── Result 联合类型（供 tRPC 输出推导） ─────────────────────────

type RegisterResult =
  | { ok: true; id: string; name: string; path: string; registeredAt: number; format: KbFormat }
  | { ok: false; error: KbError };

type UnregisterResult =
  | { ok: true }
  | { ok: false; error: KbError };

type MountResult =
  | { ok: true; data: KbMount; recovery: KbRecoveryReport | null }
  | { ok: false; error: KbError };

type UnmountResult =
  | { ok: true }
  | { ok: false; error: KbError };

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
      return { ok: true, data: result.data.mount, recovery: result.data.recovery };
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
});
