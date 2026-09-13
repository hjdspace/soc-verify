/**
 * Knowledge Base Store — 知识库前端状态管理。
 *
 * 管理库列表、当前挂载库、分类树、文档列表、上传状态。
 * 通过 tRPC kb-router 调用主进程 API，通过 eventBridge 订阅 kb:docStatus 事件。
 *
 * 类型从 @shared/kb-types 统一导入，消除手工复刻类型的漂移风险。
 *
 * @see ADR 0021 — anydoc 文档知识库
 * @see Issue #5 — 知识库 UI 列表 Tab
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type {
  KbDocument,
  KbCategory,
  KbDocStatusEvent,
  KbSettings,
  ConvertEngineInfo,
  ConvertEngineId,
  KbLlmSettings,
  KbMount,
  KbStatus,
  KbListEntry,
  KbDisposal,
} from '@shared/kb-types';

// ── 渲染端独有类型（不跨进程） ─────────────────────────────────

export type KbTab = 'list' | 'index' | 'preview';

/** registerKb 结果（渲染端需要区分错误码以提供「注册为副本」入口） */
export type KbRegisterOutcome = { ok: true } | { ok: false; errorCode?: string; message: string };

// ── 重新导出共享类型（供组件 import 不变） ────────────────────

export type {
  KbDocument,
  KbCategory,
  KbDocStatusEvent,
  KbSettings,
  ConvertEngineInfo as KbEngineInfo,
  ConvertEngineId as KbConvertEngineId,
  KbLlmSettings,
  KbMount,
  KbListEntry,
  KbStatus,
  KbDisposal,
};

// ── done/failed 事件刷新防抖 ─────────────────────────────────
//
// 批量上传/挂载自动扫描时每篇文档完成都广播 done 事件，每个事件直接
// 触发 refreshAll（3 次 IPC 查询 × 全库目录扫描）。N 篇文档 ≈ N×5 次
// 主进程文件系统扫描排队，会拖垮 IPC 响应（表现为 GUI 数秒冻结）。
// 防抖把突发事件合并为一次尾部刷新。
const REFRESH_DEBOUNCE_MS = 300;
let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDebouncedRefresh(): void {
  if (refreshDebounceTimer !== null) {
    clearTimeout(refreshDebounceTimer);
  }
  refreshDebounceTimer = setTimeout(() => {
    refreshDebounceTimer = null;
    void useKbStore.getState().refreshAll();
  }, REFRESH_DEBOUNCE_MS);
}

// ── Store 接口 ──────────────────────────────────────────────

interface KbStoreState {
  // ── 库列表 ───────────────────────────────────────────────
  kbList: KbListEntry[];
  kbListLoading: boolean;

  // ── 当前挂载状态 ─────────────────────────────────────────
  kbStatus: KbStatus | null;
  kbStatusLoading: boolean;

  // ── 分类树 ───────────────────────────────────────────────
  categories: KbCategory[];
  categoriesLoading: boolean;
  selectedCategory: string | null; // null = 全部文档

  // ── 文档列表 ─────────────────────────────────────────────
  documents: KbDocument[];
  documentsLoading: boolean;

  // ── 上传状态 ─────────────────────────────────────────────
  uploading: boolean;

  // ── 库注册/挂载对话框 ───────────────────────────────────
  kbModalOpen: boolean;

  // ── 当前活跃 Tab ─────────────────────────────────────────
  activeTab: KbTab;

  // ── 索引 Tab 状态 ───────────────────────────────────────
  indexContent: string;
  indexLoading: boolean;
  indexEditing: boolean;
  indexSaving: boolean;

  // ── 深度重建状态（Issue #7）─────────────────────────────────
  deepReindexing: boolean;
  deepReindexProgress: { current: number; total: number; message: string } | null;

  // ── 预览 Tab 状态 ───────────────────────────────────────
  previewDocName: string | null;
  previewContent: string | null;
  previewLoading: boolean;

  // ── 操作 ─────────────────────────────────────────────────
  loadKbList: () => Promise<void>;
  loadKbStatus: () => Promise<void>;
  loadCategories: () => Promise<void>;
  loadDocuments: () => Promise<void>;
  setSelectedCategory: (category: string | null) => void;
  uploadFiles: (filePaths: string[]) => Promise<void>;
  pickAndUpload: () => Promise<void>;
  retryDocument: (name: string) => Promise<void>;
  deleteDocument: (name: string) => Promise<void>;
  registerKb: (name: string, path: string, asCopy?: boolean) => Promise<KbRegisterOutcome>;
  unregisterKb: (kbId: string) => Promise<boolean>;
  mountKb: (kbId: string) => Promise<boolean>;
  unmountKb: (kbId: string) => Promise<boolean>;
  setKbModalOpen: (open: boolean) => void;
  handleDocStatusEvent: (event: KbDocStatusEvent) => void;
  refreshAll: () => Promise<void>;
  setActiveTab: (tab: KbTab) => void;
  openPreview: (docName: string) => void;
  loadIndex: () => Promise<void>;
  saveIndex: (content: string) => Promise<void>;
  setIndexEditing: (editing: boolean) => void;
  loadPreview: (docName: string) => Promise<void>;
  moveCategory: (docName: string, category: string) => Promise<boolean>;
  renameCategory: (oldName: string, newName: string) => Promise<boolean>;
  reclassifyDocument: (name: string) => Promise<boolean>;
  // ── 深度重建（Issue #7）─────────────────────────────────
  deepReindex: () => Promise<void>;
  handleDeepReindexEvent: (event: {
    phase: 'processing' | 'completed' | 'failed';
    current?: number;
    total?: number;
    message: string;
    error?: string;
  }) => void;

  // ── 知识库设置（引擎 + AI 模型）────────────────────────
  kbSettings: KbSettings | null;
  kbSettingsLoading: boolean;
  kbEngines: ConvertEngineInfo[];
  loadKbSettings: () => Promise<void>;
  updateKbSettings: (settings: KbSettings) => Promise<boolean>;

  // ── 旧格式处置记录 ──────────────────────────────────────
  kbDisposals: KbDisposal[];
  loadDisposals: () => Promise<void>;
  dismissDisposal: (disposalId: string) => Promise<boolean>;
}

export const useKbStore = create<KbStoreState>((set, get) => ({
  // ── 初始状态 ─────────────────────────────────────────────
  kbList: [],
  kbListLoading: false,
  kbStatus: null,
  kbStatusLoading: false,
  categories: [],
  categoriesLoading: false,
  selectedCategory: null,
  documents: [],
  documentsLoading: false,
  uploading: false,
  kbModalOpen: false,
  activeTab: 'list',
  indexContent: '',
  indexLoading: false,
  indexEditing: false,
  indexSaving: false,
  deepReindexing: false,
  deepReindexProgress: null,
  previewDocName: null,
  previewContent: null,
  previewLoading: false,
  kbSettings: null,
  kbSettingsLoading: false,
  kbEngines: [],
  kbDisposals: [],

  // ── 加载库列表 ───────────────────────────────────────────
  loadKbList: async () => {
    set({ kbListLoading: true });
    try {
      const result = await trpc.kb.list.query({});
      set({ kbList: result, kbListLoading: false });
    } catch (err) {
      set({ kbListLoading: false, kbList: [] });
      // 静默失败：未打开项目时主进程返回 NOT_FOUND
      if (err instanceof Error && !err.message.includes('未找到打开的项目')) {
        useToastStore.getState().error(
          '加载知识库列表失败',
          err.message,
        );
      }
    }
  },

  // ── 加载挂载状态 ─────────────────────────────────────────
  loadKbStatus: async () => {
    set({ kbStatusLoading: true });
    try {
      const result = await trpc.kb.status.query({});
      set({ kbStatus: result, kbStatusLoading: false });
    } catch (err) {
      set({ kbStatusLoading: false, kbStatus: null });
      // 静默失败：未打开项目或未挂载时主进程返回错误
      if (err instanceof Error && !err.message.includes('未挂载') && !err.message.includes('未找到打开的项目')) {
        useToastStore.getState().error(
          '加载知识库状态失败',
          err.message,
        );
      }
    }
  },

  // ── 加载分类树 ───────────────────────────────────────────
  loadCategories: async () => {
    set({ categoriesLoading: true });
    try {
      const result = await trpc.kb.categories.query({});
      set({ categories: result, categoriesLoading: false });
    } catch {
      set({ categoriesLoading: false, categories: [] });
    }
  },

  // ── 加载文档列表 ─────────────────────────────────────────
  loadDocuments: async () => {
    set({ documentsLoading: true });
    try {
      const result = await trpc.kb.documents.query({});
      set({ documents: result, documentsLoading: false });
    } catch {
      set({ documentsLoading: false, documents: [] });
    }
  },

  // ── 分类筛选 ─────────────────────────────────────────────
  setSelectedCategory: (category) => set({ selectedCategory: category }),

  // ── 打开文件选择器并上传 ─────────────────────────────────
  pickAndUpload: async () => {
    try {
      const result = await trpc.kb.pickFiles.mutate({});
      if (!result.canceled && result.filePaths.length > 0) {
        await get().uploadFiles(result.filePaths);
      }
    } catch (err) {
      useToastStore.getState().error(
        '选择文件失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 上传文档 ─────────────────────────────────────────────
  uploadFiles: async (filePaths) => {
    if (filePaths.length === 0) return;
    set({ uploading: true });
    try {
      const result = await trpc.kb.upload.mutate({ filePaths });
      const failures = result.results.filter((r) => !r.ok);
      if (failures.length > 0) {
        useToastStore.getState().warning(
          `${failures.length} 个文档上传失败`,
          failures
            .map((f) => f.ok === false ? `${f.error.code}: ${f.error.message}` : '')
            .join('\n'),
        );
      }
      const successes = result.results.filter((r) => r.ok);
      const degraded = successes.filter((r) => r.ok && r.document.aiDegraded);
      if (degraded.length > 0) {
        const firstError = degraded[0].ok ? degraded[0].document.aiError : undefined;
        useToastStore.getState().warning(
          `${degraded.length} 个文档 AI 分类/摘要失败，已归入「未分类」`,
          firstError
            ? `${firstError}。修复后可用列表行内的「AI 重分类」按钮重试。`
            : '请在配置 LLM 凭证后使用「AI 重分类」按钮重试。',
        );
      } else if (successes.length > 0) {
        useToastStore.getState().success(
          `${successes.length} 个文档上传成功`,
        );
      }
      set({ uploading: false });
      // 刷新列表
      await get().refreshAll();
    } catch (err) {
      set({ uploading: false });
      useToastStore.getState().error(
        '上传文档失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 重试失败文档 ─────────────────────────────────────────
  retryDocument: async (name) => {
    try {
      const result = await trpc.kb.retry.mutate({ name });
      if (result.ok) {
        useToastStore.getState().success(`已重试: ${name}`);
        await get().refreshAll();
      } else {
        useToastStore.getState().error(
          `重试失败: ${name}`,
          result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
        );
      }
    } catch (err) {
      useToastStore.getState().error(
        `重试失败: ${name}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 删除文档 ─────────────────────────────────────────────
  deleteDocument: async (name) => {
    try {
      await trpc.kb.delete.mutate({ name });
      useToastStore.getState().success(`已删除: ${name}`);
      await get().refreshAll();
    } catch (err) {
      useToastStore.getState().error(
        `删除失败: ${name}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 注册知识库 ───────────────────────────────────────────
  registerKb: async (name, path, asCopy) => {
    try {
      const result = await trpc.kb.register.mutate({ name, path, ...(asCopy ? { asCopy: true } : {}) });
      if (result.ok) {
        useToastStore.getState().success(`已注册知识库: ${name}`);
        await get().loadKbList();
        return { ok: true };
      }
      useToastStore.getState().error(
        '注册知识库失败',
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return { ok: false, errorCode: result.error.code, message: result.error.message };
    } catch (err) {
      useToastStore.getState().error(
        '注册知识库失败',
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  // ── 注销知识库 ───────────────────────────────────────────
  unregisterKb: async (kbId) => {
    try {
      const result = await trpc.kb.unregister.mutate({ kbId });
      if (result.ok) {
        useToastStore.getState().success('已注销知识库');
        await get().loadKbList();
        return true;
      }
      useToastStore.getState().error(
        '注销知识库失败',
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '注销知识库失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── 挂载知识库 ───────────────────────────────────────────
  mountKb: async (kbId) => {
    try {
      const result = await trpc.kb.mount.mutate({ kbId });
      if (result.ok) {
        useToastStore.getState().success('已挂载知识库');
        // 事务恢复报告（wiki 库重开时执行）
        if (result.recovery) {
          const { cleaned, rolledForward, rolledBack, failures } = result.recovery;
          if (failures.length > 0) {
            useToastStore.getState().warning(
              '挂载时发现未完成事务，部分无法自动恢复（现场已保留）',
              failures.join('\n'),
            );
          } else if (rolledForward > 0 || rolledBack > 0) {
            useToastStore.getState().success(
              `挂载时恢复未完成事务：${rolledForward} 个继续完成，${rolledBack} 个回滚到旧版`,
            );
          } else if (cleaned > 0) {
            useToastStore.getState().success(`挂载时清理了 ${cleaned} 个已完成事务`);
          }
        }
        await get().refreshAll();
        await get().loadKbList();
        return true;
      }
      useToastStore.getState().error(
        '挂载知识库失败',
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '挂载知识库失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── 卸载知识库 ───────────────────────────────────────────
  unmountKb: async (kbId) => {
    try {
      const result = await trpc.kb.unmount.mutate({ kbId });
      if (result.ok) {
        useToastStore.getState().success('已卸载知识库');
        set({
          kbStatus: null,
          categories: [],
          documents: [],
          selectedCategory: null,
        });
        await get().loadKbList();
        return true;
      }
      useToastStore.getState().error(
        '卸载知识库失败',
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '卸载知识库失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── 库注册/挂载对话框 ───────────────────────────────────
  setKbModalOpen: (open) => set({ kbModalOpen: open }),

  // ── 处理文档状态事件（kb:docStatus） ─────────────────────
  handleDocStatusEvent: (event) => {
    const { documents, uploading } = get();
    const idx = documents.findIndex((d) => d.name === event.name);
    if (idx === -1) {
      // 新文档，添加到列表
      const newDoc: KbDocument = {
        name: event.name,
        sourceExt: '',
        sourcePath: '',
        markdownPath: '',
        category: event.category ?? '',
        sourceSize: 0,
        markdownSize: 0,
        assetCount: 0,
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        aiDegraded: event.aiDegraded,
        aiError: event.aiError,
      };
      set({ documents: [...documents, newDoc] });
    } else {
      // 更新现有文档状态
      const updated = [...documents];
      updated[idx] = {
        ...updated[idx],
        status: event.status,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        category: event.category ?? updated[idx].category,
        aiDegraded: event.aiDegraded ?? updated[idx].aiDegraded,
        aiError: event.aiError ?? updated[idx].aiError,
      };
      set({ documents: updated });
    }

    // 挂载时自动扫描的后台上传（非用户主动上传流程）AI 降级 → 明确提示
    if (event.status === 'done' && event.aiDegraded && !uploading) {
      useToastStore.getState().warning(
        `文档「${event.name}」AI 分类/摘要失败，已归入「未分类」`,
        event.aiError
          ? `${event.aiError}。修复后可用列表行内的「AI 重分类」按钮重试。`
          : '请在配置 LLM 凭证后使用「AI 重分类」按钮重试。',
      );
    }

    // done/failed 状态时刷新分类树和文档列表（获取完整数据）。
    // 防抖合并：批量上传的连续 done 事件只触发一次 refreshAll
    if (event.status === 'done' || event.status === 'failed') {
      scheduleDebouncedRefresh();
    }
  },

  // ── 刷新全部数据 ─────────────────────────────────────────
  refreshAll: async () => {
    await Promise.all([
      get().loadKbStatus(),
      get().loadCategories(),
      get().loadDocuments(),
    ]);
  },

  // ── Tab 切换 ─────────────────────────────────────────────
  setActiveTab: (tab) => set({ activeTab: tab }),

  // ── 打开预览 ─────────────────────────────────────────────
  openPreview: (docName) => {
    set({ previewDocName: docName, activeTab: 'preview' });
    void get().loadPreview(docName);
  },

  // ── 加载 index.md ───────────────────────────────────────
  loadIndex: async () => {
    set({ indexLoading: true });
    try {
      const result = await trpc.kb.index.mutate({});
      set({ indexContent: result.content, indexLoading: false });
    } catch (err) {
      set({ indexLoading: false });
      useToastStore.getState().error(
        '加载索引失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 保存 index.md ───────────────────────────────────────
  saveIndex: async (content) => {
    set({ indexSaving: true });
    try {
      await trpc.kb.index.mutate({ content });
      set({ indexContent: content, indexEditing: false, indexSaving: false });
      useToastStore.getState().success('索引已保存');
    } catch (err) {
      set({ indexSaving: false, indexEditing: true });
      useToastStore.getState().error(
        '保存索引失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 索引编辑模式 ───────────────────────────────────────
  setIndexEditing: (editing) => set({ indexEditing: editing }),

  // ── 加载预览文档 ───────────────────────────────────────
  loadPreview: async (docName) => {
    set({ previewLoading: true, previewDocName: docName });
    try {
      const result = await trpc.kb.preview.query({ name: docName });
      set({ previewContent: result.content, previewLoading: false });
    } catch (err) {
      set({ previewLoading: false, previewContent: null });
      useToastStore.getState().error(
        '加载文档预览失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  // ── 移动分类 ─────────────────────────────────────────────
  moveCategory: async (docName, category) => {
    try {
      const result = await trpc.kb.moveCategory.mutate({ name: docName, category });
      if (result.ok) {
        useToastStore.getState().success(`已移动到「${category}」`);
        await get().refreshAll();
        return true;
      }
      useToastStore.getState().error(
        `移动分类失败`,
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '移动分类失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── 重命名分类 ─────────────────────────────────────────────
  renameCategory: async (oldName, newName) => {
    try {
      const result = await trpc.kb.renameCategory.mutate({ oldName, newName });
      if (result.ok) {
        useToastStore.getState().success(`已重命名为「${newName}」`);
        await get().refreshAll();
        await get().loadIndex();
        return true;
      }
      useToastStore.getState().error(
        '重命名分类失败',
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '重命名分类失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── AI 重新分类/摘要 ─────────────────────────────────────
  reclassifyDocument: async (name) => {
    try {
      const result = await trpc.kb.reclassify.mutate({ name });
      if (result.ok) {
        useToastStore.getState().success(
          `已重新分类到「${result.category}」`,
          result.moved ? '文档已移动到新分类目录' : '分类未变化，摘要与关键词已更新',
        );
        await get().refreshAll();
        await get().loadIndex();
        return true;
      }
      useToastStore.getState().error(
        `AI 重新分类失败: ${name}`,
        result.ok === false ? result.error.message : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        `AI 重新分类失败: ${name}`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── 深度重建（Issue #7）─────────────────────────────────
  deepReindex: async () => {
    if (get().deepReindexing) return; // 防止重复触发
    set({ deepReindexing: true, deepReindexProgress: null });
    try {
      const result = await trpc.kb.deepReindex.mutate({});
      if (result.ok) {
        useToastStore.getState().success(
          `深度重建完成（${result.documentCount} 篇文档）`,
        );
        // 刷新索引内容
        await get().loadIndex();
        await get().refreshAll();
      } else {
        useToastStore.getState().error(
          '深度重建失败',
          result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
        );
      }
    } catch (err) {
      useToastStore.getState().error(
        '深度重建失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      set({ deepReindexing: false, deepReindexProgress: null });
    }
  },

  // ── 处理深度重建进度事件（kb:deepReindex）────────────────────
  handleDeepReindexEvent: (event) => {
    if (event.phase === 'processing') {
      set({
        deepReindexing: true,
        deepReindexProgress: {
          current: event.current ?? 0,
          total: event.total ?? 0,
          message: event.message,
        },
      });
    } else if (event.phase === 'completed') {
      set({ deepReindexing: false, deepReindexProgress: null });
    } else if (event.phase === 'failed') {
      set({ deepReindexing: false, deepReindexProgress: null });
    }
  },

  // ── 知识库设置 ─────────────────────────────────────────
  loadKbSettings: async () => {
    set({ kbSettingsLoading: true });
    try {
      const result = await trpc.kb.getSettings.query({});
      set({ kbSettings: result.settings, kbEngines: result.engines, kbSettingsLoading: false });
    } catch (err) {
      set({ kbSettingsLoading: false });
      useToastStore.getState().error(
        '加载知识库设置失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  updateKbSettings: async (settings) => {
    try {
      const result = await trpc.kb.updateSettings.mutate(settings);
      set({ kbSettings: result.settings });
      useToastStore.getState().success('知识库设置已保存');
      return true;
    } catch (err) {
      useToastStore.getState().error(
        '保存知识库设置失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },

  // ── 旧格式处置记录 ──────────────────────────────────────
  loadDisposals: async () => {
    try {
      const result = await trpc.kb.disposals.query({});
      set({ kbDisposals: result });
    } catch {
      set({ kbDisposals: [] });
    }
  },

  dismissDisposal: async (disposalId) => {
    try {
      const result = await trpc.kb.dismissDisposal.mutate({ disposalId });
      if (result.ok) {
        await get().loadDisposals();
        return true;
      }
      useToastStore.getState().error(
        '移除处置记录失败',
        result.ok === false ? result.error.message : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '移除处置记录失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  },
}));
