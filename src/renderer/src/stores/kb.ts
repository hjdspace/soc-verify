/**
 * Knowledge Base Store — 知识库前端状态管理。
 *
 * 管理库列表、当前挂载库、分类树、文档列表、上传状态。
 * 通过 tRPC kb-router 调用主进程 API，通过 eventBridge 订阅 kb:docStatus 事件。
 *
 * @see ADR 0021 — anydoc 文档知识库
 * @see Issue #5 — 知识库 UI 列表 Tab
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';

// ── 类型（从 tRPC 自动推导，这里显式声明供组件使用） ─────────

export type KbTab = 'list' | 'index' | 'preview';

export type KbListEntry = {
  id: string;
  name: string;
  path: string;
  registeredAt: number;
  documentCount: number;
  categoryCount: number;
  isMounted: boolean;
};

export type KbStatus = {
  mounted: (KbMount & { name: string; path: string }) | null;
  health: {
    hasSources: boolean;
    hasDocs: boolean;
    hasIndex: boolean;
  };
};

export type KbMount = {
  kbId: string;
  mountedAt: number;
};

export type KbDocument = {
  name: string;
  sourceExt: string;
  sourcePath: string;
  markdownPath: string;
  category: string;
  sourceSize: number;
  markdownSize: number;
  assetCount: number;
  status: 'queued' | 'converting' | 'classifying' | 'done' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  convertedAt?: number;
  classifiedAt?: number;
};

export type KbCategory = {
  name: string;
  count: number;
};

export type KbDocStatusEvent = {
  name: string;
  status: 'queued' | 'converting' | 'classifying' | 'done' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  category?: string;
};

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
  retryDocument: (name: string) => Promise<void>;
  deleteDocument: (name: string) => Promise<void>;
  registerKb: (name: string, path: string) => Promise<boolean>;
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
  previewDocName: null,
  previewContent: null,
  previewLoading: false,

  // ── 加载库列表 ───────────────────────────────────────────
  loadKbList: async () => {
    set({ kbListLoading: true });
    try {
      const result = await trpc.kb.list.query({});
      set({ kbList: result, kbListLoading: false });
    } catch (err) {
      set({ kbListLoading: false });
      useToastStore.getState().error(
        '加载知识库列表失败',
        err instanceof Error ? err.message : String(err),
      );
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
      // 静默失败：未挂载时主进程返回 PRECONDITION_FAILED
      if (err instanceof Error && !err.message.includes('未挂载')) {
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
      if (successes.length > 0) {
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
  registerKb: async (name, path) => {
    try {
      const result = await trpc.kb.register.mutate({ name, path });
      if (result.ok) {
        useToastStore.getState().success(`已注册知识库: ${name}`);
        await get().loadKbList();
        return true;
      }
      useToastStore.getState().error(
        '注册知识库失败',
        result.ok === false ? `${result.error.code}: ${result.error.message}` : '',
      );
      return false;
    } catch (err) {
      useToastStore.getState().error(
        '注册知识库失败',
        err instanceof Error ? err.message : String(err),
      );
      return false;
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
    const { documents } = get();
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
      };
      set({ documents: updated });
    }

    // done 状态时刷新分类树和文档列表（获取完整数据）
    if (event.status === 'done' || event.status === 'failed') {
      void get().refreshAll();
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
}));
