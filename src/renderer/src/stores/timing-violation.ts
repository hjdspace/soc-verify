/**
 * Timing Violation Zustand store
 *
 * 管理时序违例模块的筛选/排序/搜索状态、违例列表数据、统计信息和元数据。
 * 筛选状态在切换 Destination 后恢复（持久化在 store 内存中）。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';

// ── 类型 ──────────────────────────────────────────────────

export type ConfirmationStatus = 'pending' | 'confirmed' | 'ignored';

export type SortField = 'time_fs' | 'num' | 'hier' | 'created_at';
export type SortOrder = 'asc' | 'desc';

export type ViolationWithConfirmation = {
  id: number;
  caseName: string;
  corner: string | null;
  seed: string | null;
  subsys: string | null;
  num: number;
  hier: string;
  timeFs: number;
  timeDisplay: string;
  checkInfo: string;
  filePath: string;
  createdAt: string;
  status: ConfirmationStatus;
  confirmer: string | null;
  result: string | null;
  reason: string | null;
  isAutoConfirmed: boolean;
  confirmedAt: string | null;
};

export type ViolationStatistics = {
  total: number;
  confirmed: number;
  pending: number;
  ignored: number;
  bySubsys: Record<string, number>;
  byCorner: Record<string, number>;
  byCase: Record<string, number>;
};

export type ViolationMetadata = {
  corners: string[];
  cases: string[];
  subsys: string[];
};

export type ParseResult = {
  success: boolean;
  total: number;
  inserted: number;
  skipped: number;
  errors: string[];
};

// ── Store 类型 ─────────────────────────────────────────────

interface TimingViolationState {
  // 数据
  violations: ViolationWithConfirmation[];
  total: number;
  statistics: ViolationStatistics | null;
  metadata: ViolationMetadata;

  // 分页
  page: number;
  pageSize: number;

  // 筛选
  filterCaseName: string | null;
  filterCorner: string | null;
  filterStatus: ConfirmationStatus | null;
  filterSubsys: string | null;
  searchText: string;

  // 排序
  sortField: SortField;
  sortOrder: SortOrder;

  // 解析状态
  parsing: boolean;
  parseResult: ParseResult | null;

  // 加载状态
  loadingViolations: boolean;
  loadingStatistics: boolean;
  loadingMetadata: boolean;

  // ── Actions ─────────────────────────────
  pickAndParse: (projectId: string) => Promise<void>;
  parseFile: (projectId: string, filePath: string, caseName?: string, corner?: string) => Promise<void>;
  loadViolations: (projectId: string) => Promise<void>;
  loadStatistics: (projectId: string) => Promise<void>;
  loadMetadata: (projectId: string) => Promise<void>;
  refreshAll: (projectId: string) => Promise<void>;

  setFilterCaseName: (v: string | null) => void;
  setFilterCorner: (v: string | null) => void;
  setFilterStatus: (v: ConfirmationStatus | null) => void;
  setFilterSubsys: (v: string | null) => void;
  setSearchText: (v: string) => void;
  setSort: (field: SortField) => void;
  setPage: (page: number) => void;

  resetFilters: () => void;
}

// ── 实现 ──────────────────────────────────────────────────

export const useTimingViolationStore = create<TimingViolationState>((set, get) => ({
  violations: [],
  total: 0,
  statistics: null,
  metadata: { corners: [], cases: [], subsys: [] },

  page: 1,
  pageSize: 200,

  filterCaseName: null,
  filterCorner: null,
  filterStatus: null,
  filterSubsys: null,
  searchText: '',

  sortField: 'time_fs',
  sortOrder: 'asc',

  parsing: false,
  parseResult: null,

  loadingViolations: false,
  loadingStatistics: false,
  loadingMetadata: false,

  pickAndParse: async (projectId) => {
    set({ parsing: true, parseResult: null });
    try {
      const fileResult = await trpc.violation.pickFile.mutate({ defaultPath: undefined });
      if (fileResult.canceled || !fileResult.filePath) {
        set({ parsing: false });
        return;
      }
      await get().parseFile(projectId, fileResult.filePath);
    } catch (err) {
      getToast().error('选择文件失败', err instanceof Error ? err.message : String(err));
      set({ parsing: false });
    }
  },

  parseFile: async (projectId, filePath, caseName, corner) => {
    set({ parsing: true, parseResult: null });
    try {
      const result = await trpc.violation.parseLog.mutate({
        projectId,
        filePath,
        caseName,
        corner,
      });
      set({ parseResult: result, parsing: false });
      getToast().success(
        `解析完成：${result.inserted} 条新增，${result.skipped} 条跳过`,
        result.errors.length > 0 ? `${result.errors.length} 个错误` : undefined,
      );
      // 刷新数据
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('解析日志失败', err instanceof Error ? err.message : String(err));
      set({ parsing: false });
    }
  },

  loadViolations: async (projectId) => {
    set({ loadingViolations: true });
    try {
      const s = get();
      const result = await trpc.violation.queryViolations.query({
        projectId,
        page: s.page,
        pageSize: s.pageSize,
        caseName: s.filterCaseName ?? undefined,
        corner: s.filterCorner ?? undefined,
        status: s.filterStatus ?? undefined,
        subsys: s.filterSubsys ?? undefined,
        searchText: s.searchText || undefined,
        sortField: s.sortField,
        sortOrder: s.sortOrder,
      });
      set({ violations: result.items as ViolationWithConfirmation[], total: result.total, loadingViolations: false });
    } catch (err) {
      set({ loadingViolations: false });
      getToast().error('加载违例列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadStatistics: async (projectId) => {
    set({ loadingStatistics: true });
    try {
      const s = get();
      const stats = await trpc.violation.getStatistics.query({
        projectId,
        caseName: s.filterCaseName ?? undefined,
        corner: s.filterCorner ?? undefined,
      });
      set({ statistics: stats as ViolationStatistics, loadingStatistics: false });
    } catch (err) {
      set({ loadingStatistics: false });
    }
  },

  loadMetadata: async (projectId) => {
    set({ loadingMetadata: true });
    try {
      const meta = await trpc.violation.getMetadata.query({ projectId });
      set({ metadata: meta as ViolationMetadata, loadingMetadata: false });
    } catch {
      set({ loadingMetadata: false });
    }
  },

  refreshAll: async (projectId) => {
    await Promise.all([
      get().loadViolations(projectId),
      get().loadStatistics(projectId),
      get().loadMetadata(projectId),
    ]);
  },

  setFilterCaseName: (v) => { set({ filterCaseName: v, page: 1 }); },
  setFilterCorner: (v) => { set({ filterCorner: v, page: 1 }); },
  setFilterStatus: (v) => { set({ filterStatus: v, page: 1 }); },
  setFilterSubsys: (v) => { set({ filterSubsys: v, page: 1 }); },
  setSearchText: (v) => { set({ searchText: v, page: 1 }); },

  setSort: (field) => {
    const current = get();
    if (current.sortField === field) {
      set({ sortOrder: current.sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      set({ sortField: field, sortOrder: 'asc' });
    }
  },

  setPage: (page) => set({ page }),

  resetFilters: () => set({
    filterCaseName: null,
    filterCorner: null,
    filterStatus: null,
    filterSubsys: null,
    searchText: '',
    page: 1,
  }),
}));
