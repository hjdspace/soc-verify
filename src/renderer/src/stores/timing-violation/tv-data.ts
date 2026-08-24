/**
 * TV Data Store — 违例列表 / 筛选 / 排序 / 分页 / 数据管理 / 配置 / 选择状态。
 *
 * 从原 timing-violation.ts 中提取的 data 领域。
 * 其他子 store：
 * - tv-confirmations: 确认流程 + AI 建议
 * - tv-patterns: Pattern CRUD
 * - tv-scan: 回归扫描 + 批量处理
 *
 * refreshAll 在本 store 中，其他 store 通过延迟 import 调用。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';
import type {
  ViolationWithConfirmation,
  ViolationStatistics,
  ViolationMetadata,
  ParseResult,
  TvConfig,
  CaseCornerInfo,
  AllCaseCorners,
  ConfirmationStatus,
  SortField,
  SortOrder,
} from './tv-types';

type TvDataState = {
  // ── 数据 ──────────────────────────────────────────────
  violations: ViolationWithConfirmation[];
  total: number;
  statistics: ViolationStatistics | null;
  metadata: ViolationMetadata;

  // ── 分页 ──────────────────────────────────────────────
  page: number;
  pageSize: number;

  // ── 筛选 ──────────────────────────────────────────────
  filterCaseName: string | null;
  filterCorner: string | null;
  filterStatus: ConfirmationStatus | null;
  filterSubsys: string | null;
  searchText: string;

  // ── 排序 ──────────────────────────────────────────────
  sortField: SortField;
  sortOrder: SortOrder;

  // ── 解析状态 ──────────────────────────────────────────
  parsing: boolean;
  parseResult: ParseResult | null;
  parseProgress: { processedLines: number; foundViolations: number } | null;

  // ── 加载状态 ──────────────────────────────────────────
  loadingViolations: boolean;
  loadingStatistics: boolean;
  loadingMetadata: boolean;

  // ── 选择状态（违例表格多选，用于批量确认） ──────────
  selectedViolationIds: Set<number>;

  // ── 配置状态 ──────────────────────────────────────────
  tvConfig: TvConfig | null;
  loadingConfig: boolean;
  savingConfig: boolean;

  // ── 数据管理状态 ──────────────────────────────────────
  managingData: boolean;

  // ── 用例 Corner 信息（更新 corner 对话框使用） ────────
  caseCorners: CaseCornerInfo[];
  loadingCaseCorners: boolean;

  // ── 全量用例 Corner 信息（数据管理下拉列表使用） ──────
  allCaseCorners: AllCaseCorners | null;

  // ── 子系统刷新状态 ────────────────────────────────────
  refreshingSubsys: boolean;

  // ── Actions ─────────────────────────────────────────────
  pickAndParse: (projectId: string) => Promise<void>;
  parseFile: (projectId: string, filePath: string, caseName?: string, corner?: string) => Promise<void>;
  setParseProgress: (progress: { processedLines: number; foundViolations: number } | null) => void;
  loadViolations: (projectId: string) => Promise<void>;
  loadStatistics: (projectId: string) => Promise<void>;
  loadMetadata: (projectId: string) => Promise<void>;
  refreshAll: (projectId: string) => Promise<void>;
  clearAllData: (projectId: string) => Promise<void>;
  clearCaseData: (projectId: string, caseName: string, corner?: string) => Promise<void>;
  updateCorner: (projectId: string, caseName: string, newCorner: string, oldCorner?: string) => Promise<void>;
  loadCaseCorners: (projectId: string, caseName: string) => Promise<void>;
  refreshSubsys: (projectId: string) => Promise<void>;
  loadAllCaseCorners: (projectId: string) => Promise<void>;

  setFilterCaseName: (v: string | null) => void;
  setFilterCorner: (v: string | null) => void;
  setFilterStatus: (v: ConfirmationStatus | null) => void;
  setFilterSubsys: (v: string | null) => void;
  setSearchText: (v: string) => void;
  setSort: (field: SortField) => void;
  setPage: (page: number) => void;
  resetFilters: () => void;

  toggleViolationSelection: (id: number) => void;
  selectAllVisibleViolations: () => void;
  clearSelection: () => void;

  loadTvConfig: (projectId: string) => Promise<void>;
  saveTvConfig: (projectId: string, config: TvConfig) => Promise<void>;
};

export const useTvDataStore = create<TvDataState>((set, get) => ({
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

  sortField: 'num',
  sortOrder: 'asc',

  parsing: false,
  parseResult: null,
  parseProgress: null,

  loadingViolations: false,
  loadingStatistics: false,
  loadingMetadata: false,

  selectedViolationIds: new Set(),

  tvConfig: null,
  loadingConfig: false,
  savingConfig: false,

  managingData: false,

  caseCorners: [],
  loadingCaseCorners: false,

  allCaseCorners: null,

  refreshingSubsys: false,

  pickAndParse: async (projectId) => {
    set({ parsing: true, parseResult: null, parseProgress: null });
    try {
      const fileResult = await trpc.violation.pickFile.mutate({ defaultPath: undefined });
      if (fileResult.canceled || !fileResult.filePath) {
        set({ parsing: false, parseProgress: null });
        return;
      }
      await get().parseFile(projectId, fileResult.filePath);
    } catch (err) {
      getToast().error('选择文件失败', err instanceof Error ? err.message : String(err));
      set({ parsing: false, parseProgress: null });
    }
  },

  parseFile: async (projectId, filePath, caseName, corner) => {
    set({ parsing: true, parseResult: null, parseProgress: null });
    try {
      const result = await trpc.violation.parseLog.mutate({
        projectId,
        filePath,
        caseName,
        corner,
      });
      set({ parseResult: result, parsing: false, parseProgress: null });
      const detailParts: string[] = [];
      if (result.appliedHistorical && result.appliedHistorical > 0) {
        detailParts.push(`历史确认自动应用 ${result.appliedHistorical} 条`);
      }
      if (result.errors.length > 0) {
        detailParts.push(`${result.errors.length} 个错误`);
      }
      getToast().success(
        `解析完成：${result.inserted} 条新增，${result.skipped} 条跳过`,
        detailParts.length > 0 ? detailParts.join('，') : undefined,
      );
      // 刷新数据
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('解析日志失败', err instanceof Error ? err.message : String(err));
      set({ parsing: false, parseProgress: null });
    }
  },

  setParseProgress: (progress) => set({ parseProgress: progress }),

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
      getToast().error('加载统计信息失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadMetadata: async (projectId) => {
    set({ loadingMetadata: true });
    try {
      const meta = await trpc.violation.getMetadata.query({ projectId });
      set({ metadata: meta as ViolationMetadata, loadingMetadata: false });
    } catch (err) {
      set({ loadingMetadata: false });
      getToast().error('加载元数据失败', err instanceof Error ? err.message : String(err));
    }
  },

  refreshAll: async (projectId) => {
    await Promise.all([
      get().loadViolations(projectId),
      get().loadStatistics(projectId),
      get().loadMetadata(projectId),
    ]);
  },

  clearAllData: async (projectId) => {
    try {
      const result = await trpc.violation.clearAllData.mutate({ projectId });
      getToast().success(`已清空 ${result.deleted} 条违例数据`);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('清空数据失败', err instanceof Error ? err.message : String(err));
    }
  },

  clearCaseData: async (projectId, caseName, corner) => {
    set({ managingData: true });
    try {
      const result = await trpc.violation.clearCaseData.mutate({ projectId, caseName, corner });
      const msg = corner
        ? `已清除 ${caseName} (${corner}) 的 ${result.deleted} 条数据`
        : `已清除 ${caseName} 的 ${result.deleted} 条数据`;
      getToast().success(msg);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('清除数据失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ managingData: false });
    }
  },

  updateCorner: async (projectId, caseName, newCorner, oldCorner) => {
    set({ managingData: true });
    try {
      const result = await trpc.violation.updateCorner.mutate({ projectId, caseName, newCorner, oldCorner });
      getToast().success(`已更新 ${result.updated} 条记录的 corner`);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('更新 corner 失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ managingData: false });
    }
  },

  loadCaseCorners: async (projectId, caseName) => {
    set({ loadingCaseCorners: true });
    try {
      const result = await trpc.violation.getCaseCorners.query({ projectId, caseName });
      set({ caseCorners: result as CaseCornerInfo[], loadingCaseCorners: false });
    } catch (err) {
      set({ loadingCaseCorners: false, caseCorners: [] });
      getToast().error('加载用例 Corner 信息失败', err instanceof Error ? err.message : String(err));
    }
  },

  refreshSubsys: async (projectId) => {
    set({ refreshingSubsys: true });
    try {
      const result = await trpc.violation.refreshSubsys.mutate({ projectId });
      if (result.updated > 0) {
        getToast().success(`子系统刷新完成：${result.updated} 条记录已更新`);
      } else {
        getToast().info('没有需要刷新的子系统信息');
      }
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('刷新子系统失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ refreshingSubsys: false });
    }
  },

  loadAllCaseCorners: async (projectId) => {
    try {
      const result = await trpc.violation.getAllCaseCorners.query({ projectId });
      set({ allCaseCorners: result as AllCaseCorners });
    } catch (err) {
      set({ allCaseCorners: null });
      getToast().error('加载用例 Corner 信息失败', err instanceof Error ? err.message : String(err));
    }
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

  toggleViolationSelection: (id) => {
    set((s) => {
      const next = new Set(s.selectedViolationIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedViolationIds: next };
    });
  },

  selectAllVisibleViolations: () => {
    set((s) => {
      const allIds = new Set(s.violations.map((v) => v.id));
      return { selectedViolationIds: allIds };
    });
  },

  clearSelection: () => set({ selectedViolationIds: new Set() }),

  loadTvConfig: async (projectId) => {
    set({ loadingConfig: true });
    try {
      const config = await trpc.settings.getTvConfig.query({ projectId });
      set({ tvConfig: config as TvConfig, loadingConfig: false });
    } catch (err) {
      set({ loadingConfig: false });
      getToast().error('加载配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  saveTvConfig: async (projectId, config) => {
    set({ savingConfig: true });
    try {
      await trpc.settings.updateTvConfig.mutate({ projectId, config });
      set({ tvConfig: config, savingConfig: false });
      getToast().success('配置已保存');
    } catch (err) {
      set({ savingConfig: false });
      getToast().error('保存配置失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
