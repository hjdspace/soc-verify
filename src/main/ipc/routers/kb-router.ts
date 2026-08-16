/**
 * Knowledge Base router — 注册、挂载、状态管理、上传流水线。
 *
 * Procedure（inline input validator，非 zod）：
 *   - kb.list       已注册库列表 + 每库文档数/分类数统计
 *   - kb.register   注册知识库（空目录初始化 / 已有目录兼容校验）
 *   - kb.unregister 注销知识库（已挂载的库不可注销）
 *   - kb.mount      挂载知识库到项目（v1 上限 1）
 *   - kb.unmount    卸载知识库
 *   - kb.status     当前挂载库 + 结构健康检查
 *   - kb.upload     上传文档 → 转换 → 分类 → 索引
 *   - kb.documents  文档列表
 *   - kb.delete     删除文档
 *   - kb.retry      重试失败转换
 *   - kb.categories 分类树 + 计数
 *
 * 错误处理：register/unregister/mount/unmount 返回 Result 联合
 * （{ ok: true, ...data } | { ok: false, error: KbError }），
 * 保留结构化错误码供渲染端精确分支处理。
 *
 * 状态与进度通过原生 IPC 推送（kb:* 通道）。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { BrowserWindow, dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import { projectManager } from '../../project/project-manager';
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
import { protocolForProvider, type LlmConfig } from '../../kb/indexer';
import { credentialManager } from '../../credentials/credential-manager';
import { ensureV1Prefix } from '../../agent/openai-compatible';
import { loadSessions } from '../../agent/session-persistence';
import type { KbRegistration, KbMount, KbError, KbDocument, KbCategory, KbDocStatusEvent } from '../../kb/types';

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

type UploadResult =
  | { ok: true; document: KbDocument }
  | { ok: false; error: { code: string; message: string } };

// ── 辅助函数 ─────────────────────────────────────────────────────

/**
 * 获取当前活跃项目的 rootPath。
 * 单用户桌面应用：取最近打开的项目。无项目时抛 NOT_FOUND。
 */
function getActiveProjectRoot(): string {
  const projects = projectManager.listProjects();
  if (projects.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: '未找到打开的项目，请先打开项目' });
  }
  // 取最近打开的项目
  const latest = projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  return latest.rootPath;
}

/**
 * 获取当前挂载的知识库路径。
 * 未挂载时抛出 TRPCError。
 */
async function getMountedKbPath(): Promise<string> {
  const rootPath = getActiveProjectRoot();
  const status = await kbRegistry.status(rootPath);
  if (!status.mounted) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '未挂载知识库，请先挂载' });
  }
  return status.mounted.path;
}

/**
 * 根据 providerId 推导默认模型名。
 * 用户未显式配置 model 时使用此映射。
 */
function defaultModelForProvider(providerId: string): string {
  const lower = providerId.toLowerCase();
  if (lower === 'openai' || lower === 'openai-compatible') return 'gpt-4o-mini';
  if (lower === 'anthropic' || lower === 'claude') return 'claude-sonnet-4-20250514';
  if (lower === 'google' || lower === 'gemini') return 'gemini-2.5-flash';
  if (lower === 'deepseek') return 'deepseek-chat';
  if (lower === 'ollama') return 'llama3.2';
  return 'gpt-4o-mini';
}

/** credentialManager 返回的凭证结构（模块内使用） */
type ActiveCredential = {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
};

/**
 * 解析当前生效的 LLM 凭证 — 与右侧 AI Agent 面板保持一致：
 * 优先用项目最近 AI 会话持久化的 providerId（用户在 Agent 面板
 * 实际选择且验证可用的凭证），回退到默认凭证（列表第一条）。
 */
async function resolveActiveCredential(): Promise<ActiveCredential | null> {
  try {
    const rootPath = getActiveProjectRoot();
    const sessions = await loadSessions(rootPath);
    const latest = sessions
      .filter((s) => s.model?.providerId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    const providerId = latest?.model?.providerId;
    if (providerId) {
      const cred = await credentialManager.get(providerId);
      if (cred) return cred;
    }
  } catch {
    // 项目未打开等 — 回退默认凭证
  }
  return credentialManager.getDefaultCredential();
}

/**
 * 尝试获取 LLM 配置（复用 AI Agent 面板的凭证选择）。
 * 无配置时返回 null（上传时降级为占位条目）。
 */
async function getLlmConfig(): Promise<LlmConfig | null> {
  const cred = await resolveActiveCredential();
  if (!cred || !cred.baseUrl || !cred.apiKey) {
    return null;
  }
  // gemini 原生端点用 /v1beta 版本前缀，不能强加 /v1
  const baseUrl = protocolForProvider(cred.providerId) === 'gemini'
    ? cred.baseUrl.replace(/\/+$/, '')
    : ensureV1Prefix(cred.baseUrl);
  return {
    baseUrl,
    apiKey: cred.apiKey,
    model: cred.model ?? defaultModelForProvider(cred.providerId),
    providerId: cred.providerId,
  };
}

/**
 * 推送文档状态变化事件到所有窗口。
 */
function notifyKbStatus(event: KbDocStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('kb:docStatus', event);
    }
  }
}

/**
 * 推送深度重建进度事件到所有窗口。
 */
function notifyKbDeepReindex(event: DeepReindexEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('kb:deepReindex', event);
    }
  }
}

// ── 自动扫描文档 ─────────────────────────────────────────────

/** 支持的文档文件扩展名 */
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx',
  '.xls', '.xlsx', '.odt', '.rtf', '.epub', '.csv',
]);

/**
 * 扫描知识库目录下的文档文件。
 *
 * 策略：
 *  1. 扫描 sources/ 目录中已有的文档文件（已上传但可能未转换）
 *  2. 扫描库根目录下（非 sources/、docs/）的文档文件
 *
 * 对于 sources/ 中已有但 docs/ 中无对应 .md 的文件，自动触发上传流水线。
 * 对于库根目录下的文档文件，复制到 sources/ 后触发上传流水线。
 *
 * 异步执行，不阻塞 mount 响应。
 */
async function autoScanDocuments(
  kbPath: string,
  _kbId: string,
): Promise<{ scanned: number }> {
  const { readdir, copyFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');

  const sourcesDir = join(kbPath, 'sources');
  const docsDir = join(kbPath, 'docs');
  const toUpload: string[] = [];

  // 1. 扫描 sources/ 中已有文档
  if (existsSync(sourcesDir)) {
    try {
      const entries = await readdir(sourcesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

        const docName = entry.name.slice(0, -ext.length) || entry.name;
        // 检查 docs/ 中是否已有对应的 .md
        const rootMd = join(docsDir, `${docName}.md`);
        if (existsSync(rootMd)) continue;

        // 检查子目录
        let found = false;
        if (existsSync(docsDir)) {
          try {
            const docEntries = await readdir(docsDir, { withFileTypes: true });
            for (const de of docEntries) {
              if (!de.isDirectory() || de.name === 'assets') continue;
              if (existsSync(join(docsDir, de.name, `${docName}.md`))) {
                found = true;
                break;
              }
            }
          } catch {
            // ignore
          }
        }
        if (!found) {
          toUpload.push(join(sourcesDir, entry.name));
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 扫描库根目录下的文档文件（非 sources/、docs/）
  try {
    const entries = await readdir(kbPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const srcPath = join(kbPath, entry.name);
      // 复制到 sources/ 后上传
      if (!existsSync(sourcesDir)) {
        await import('node:fs/promises').then((fs) => fs.mkdir(sourcesDir, { recursive: true }));
      }
      const destPath = join(sourcesDir, entry.name);
      if (!existsSync(destPath)) {
        await copyFile(srcPath, destPath);
      }
      toUpload.push(destPath);
    }
  } catch {
    // ignore
  }

  // 3. 异步上传所有待处理文档
  if (toUpload.length > 0) {
    const llmConfig = await getLlmConfig();
    // 异步执行，不等待
    void (async () => {
      for (const filePath of toUpload) {
        try {
          await uploadDocument(filePath, kbPath, llmConfig, notifyKbStatus);
        } catch {
          // 单个文件失败不阻塞其他文件
        }
      }
    })();
  }

  return { scanned: toUpload.length };
}

export const kbRouter = t.router({
  // ─── kb.list ──────────────────────────────────────────────

  list: t.procedure
    .input((_raw): Record<string, never> => {
      return {};
    })
    .query(async () => {
      const rootPath = getActiveProjectRoot();
      return kbRegistry.list(rootPath);
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
      const rootPath = getActiveProjectRoot();
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
      const rootPath = getActiveProjectRoot();
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
    .mutation(async ({ input }): Promise<MountResult & { autoScanned?: number }> => {
      const rootPath = getActiveProjectRoot();
      const result = await kbRegistry.mount(input.kbId, rootPath);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      // 挂载成功后自动扫描库目录下的文档
      try {
        const entries = await kbRegistry.list(rootPath);
        const mounted = entries.find((e) => e.id === input.kbId);
        if (mounted) {
          const scanResult = await autoScanDocuments(mounted.path, mounted.id);
          if (scanResult.scanned > 0) {
            // 异步触发上传，不阻塞 mount 响应
            void scanResult;
          }
          return { ok: true, data: result.data, autoScanned: scanResult.scanned };
        }
      } catch {
        // 自动扫描失败不阻塞挂载
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
      const rootPath = getActiveProjectRoot();
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
      const rootPath = getActiveProjectRoot();
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
      const kbPath = await getMountedKbPath();
      const llmConfig = await getLlmConfig();

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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
      const llmConfig = await getLlmConfig();
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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
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
      const kbPath = await getMountedKbPath();
      const llmConfig = await getLlmConfig();
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
      const kbPath = await getMountedKbPath();
      const rootPath = getActiveProjectRoot();
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
});
