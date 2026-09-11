/**
 * Coverage Core Store — 会话生命周期 / 树数据 / 导入 / 调试 / 深度分析 / 视图路由。
 *
 * 从原 coverage.ts 中提取的 core 领域。其他子 store：
 * - coverage-gaps: 目标/缺口/分诊/排除/delta/trend
 * - coverage-closure: 闭包/Test Promotion
 * - coverage-export: 报告导出
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '../toast';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageSummary,
  EdaToolConfig,
  CoverageMetric,
  TestContribution,
  UncoveredItem,
} from '@shared/types';
import type {
  CoverageView,
  ImportProgressEvent,
  ImportStepLogEntry,
  DetailProgressEvent,
  DetailParseStepLogEntry,
} from './coverage-types';

// ─── 跨 store 引用（延迟 import 避免循环） ──────────────────────
// loadTree 完成后需要更新 gaps store 的 targets（getFullView 批量返回）
// deleteSession 需要清空 gaps store 的 gaps/triages/exclusions
import { useCoverageGapsStore } from './coverage-gaps';

type ImportLog = {
  edaLog: string | null;
  parserLog: string | null;
  reportDir: string;
  files: string[];
} | null;

type CoverageCoreState = {
  // ─── Session & Tree ──────────────────────────────────────
  /** 所有 Coverage Merge Session（按创建时间倒序） */
  sessions: CoverageMergeSession[];
  /** 当前选中的 session ID（共享主键，其他 store 必须 explicit 传入） */
  currentSessionId: string | null;
  /** 当前 session 的完整 CoverageData（层级树） */
  tree: CoverageData | null;
  /** 扁平摘要（root 8 metric 百分比），由 tree 派生 */
  overview: CoverageSummary | null;
  /** 项目级 EDA Tool Configuration */
  edaConfig: EdaToolConfig | null;
  loading: boolean;
  importing: boolean;

  // ─── 视图路由 ──────────────────────────────────────────────
  /** 当前 UI 视图：树表格 / 仪表盘 / 闭环详情（Issue 06） */
  view: CoverageView;

  // ─── Debug 信息（导入日志） ────────────────────────────────
  /** 最近一次导入的警告信息 */
  importWarnings: string[];
  /** 最近一次导入的报告目录路径 */
  importReportDir: string | null;
  /** 导入日志内容（EDA 命令日志 + 解析器日志） */
  importLog: ImportLog;
  /** 是否显示 debug 面板 */
  showDebugPanel: boolean;

  // ─── 导入进度（实时推送） ────────────────────────────────
  /** 当前导入进度百分比 0-100 */
  importProgress: number;
  /** 当前导入步骤描述 */
  importStep: string;
  /** 导入步骤历史日志 */
  importStepLog: ImportStepLogEntry[];
  /** 是否显示导入进度面板 */
  showImportProgress: boolean;
  /** coverage:import-progress 监听器是否已注册 */
  importProgressListenerRegistered: boolean;

  // ─── 按需详细解析状态（分层解析） ────────────────────────────
  /** 是否正在解析详细报告 */
  detailParsing: boolean;
  /** 详细解析进度百分比 0-100 */
  detailParseProgress: number;
  /** 详细解析步骤描述 */
  detailParseStep: string;
  /** 详细解析步骤历史日志 */
  detailParseStepLog: DetailParseStepLogEntry[];
  /** 是否显示详细解析进度面板 */
  showDetailParseProgress: boolean;
  /** coverage:detail-progress 监听器是否已注册 */
  detailProgressListenerRegistered: boolean;
  /** 当前 session 是否已解析详细报告（summaryOnly=false） */
  detailParsed: boolean;
  /** 当前 session 是否已解析 detail.txt（instance 级 blocks/branches/statements） */
  detailMetricsParsed: boolean;
  /** 是否正在解析 detail.txt */
  detailMetricsParsing: boolean;

  // ─── 覆盖率深度分析（urg-grade / imc functional detail / CSV） ─
  /** 测试用例贡献度排名 */
  testContributions: TestContribution[];
  /** 未覆盖项列表（按 metric 分组） */
  uncoveredItems: Partial<Record<CoverageMetric, UncoveredItem[]>>;
  /** CSV 原始覆盖率数据 */
  csvData: string | null;

  // ─── Actions ──────────────────────────────────────────────
  setView: (view: CoverageView) => void;
  loadSessions: (projectId: string) => Promise<void>;
  loadTree: (projectId: string, sessionId?: string) => Promise<void>;
  loadEdaConfig: (projectId: string) => Promise<void>;
  setEdaConfig: (projectId: string, config: EdaToolConfig) => Promise<void>;
  importCoverage: (
    projectId: string,
    covMergeDir: string,
    edaConfig?: EdaToolConfig,
  ) => Promise<string | null>;
  browseDirectory: (defaultPath?: string) => Promise<string | null>;
  setSessionId: (sessionId: string | null) => void;
  deleteSession: (projectId: string, sessionId: string) => Promise<boolean>;

  // ─── Debug 操作 ────────────────────────────────────────────
  loadImportLog: (projectId: string, sessionId: string) => Promise<void>;
  toggleDebugPanel: () => void;
  clearImportWarnings: () => void;

  // ─── 导入进度操作 ────────────────────────────────────────────
  registerImportProgressListener: () => void;
  handleImportProgress: (event: ImportProgressEvent) => void;
  clearImportProgress: () => void;

  // ─── 按需详细解析动作（分层解析） ────────────────────────────
  parseDetails: (projectId: string, sessionId: string) => Promise<boolean>;
  registerDetailProgressListener: () => void;
  handleDetailProgress: (event: DetailProgressEvent) => void;
  clearDetailParseProgress: () => void;

  // ─── detail.txt 解析动作（instance 级 blocks/branches/statements） ──
  parseDetailMetrics: (projectId: string, sessionId: string) => Promise<boolean>;

  // ─── 覆盖率深度分析动作 ────────────────────────────────────
  loadTestContributions: (projectId: string, sessionId?: string) => Promise<void>;
  loadUncovered: (projectId: string, sessionId?: string, metric?: CoverageMetric) => Promise<void>;
  loadCsvData: (projectId: string, sessionId?: string) => Promise<void>;
};

export const useCoverageCoreStore = create<CoverageCoreState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  tree: null,
  overview: null,
  edaConfig: null,
  loading: false,
  importing: false,
  view: 'tree-table',

  // ─── Debug 信息初始状态 ────────────────────────────────────
  importWarnings: [],
  importReportDir: null,
  importLog: null,
  showDebugPanel: false,

  // ─── 导入进度初始状态 ────────────────────────────────────
  importProgress: 0,
  importStep: '',
  importStepLog: [],
  showImportProgress: false,
  importProgressListenerRegistered: false,

  // ─── 按需详细解析初始状态 ────────────────────────────────
  detailParsing: false,
  detailParseProgress: 0,
  detailParseStep: '',
  detailParseStepLog: [],
  showDetailParseProgress: false,
  detailProgressListenerRegistered: false,
  detailParsed: false,
  detailMetricsParsed: false,
  detailMetricsParsing: false,

  // ─── 覆盖率深度分析初始状态 ────────────────────────────────
  testContributions: [],
  uncoveredItems: {},
  csvData: null,

  setView: (view) => set({ view }),

  loadSessions: async (projectId) => {
    try {
      const sessions = await trpc.coverage.listSessions.query({ projectId });
      set({ sessions });
      // 若无选中 session 且有 session 列表，默认选第一个
      if (!get().currentSessionId && sessions.length > 0) {
        set({ currentSessionId: sessions[0].sessionId });
      }
    } catch (err) {
      useToastStore.getState().error('加载覆盖率 session 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadTree: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    // 无 session 时静默返回，不请求后端（避免 "No coverage session available" toast 报错）
    if (!sid && get().sessions.length === 0) {
      set({ loading: false, tree: null, overview: null });
      return;
    }
    set({ loading: true });
    try {
      // 批量端点：一次返回 tree + summary + targets，消除 getTree → getOverview 的顺序调用
      const result = await trpc.coverage.getFullView.query({ projectId, sessionId: sid });
      set({
        tree: result.tree,
        overview: result.summary,
        currentSessionId: result.sessionId,
        loading: false,
        // 根据 summaryOnly 标记判断是否已解析详细报告
        detailParsed: result.tree.summaryOnly === false,
        // detail.txt 摘要标记（解析过 detail.txt 才存在）
        detailMetricsParsed: result.tree.detail !== undefined,
      });
      // 跨 store：targets 属于 coverage-gaps store
      useCoverageGapsStore.getState().setTargetsState(result.targets);
    } catch (err) {
      set({ loading: false, tree: null, overview: null });
      // "No coverage session available" 属于正常无数据场景，不弹 toast
      const msg = err instanceof Error ? err.message : String(err);
      if (/no.*coverage.*session/i.test(msg)) return;
      useToastStore.getState().error('加载覆盖率数据失败', msg);
    }
  },

  loadEdaConfig: async (projectId) => {
    try {
      const config = await trpc.coverage.getEdaConfig.query({ projectId });
      set({ edaConfig: config });
    } catch {
      // Best-effort
    }
  },

  setEdaConfig: async (projectId, config) => {
    try {
      const saved = await trpc.coverage.setEdaConfig.mutate({ projectId, config });
      set({ edaConfig: saved });
    } catch (err) {
      useToastStore.getState().error('保存 EDA 配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  importCoverage: async (projectId, covMergeDir, edaConfig) => {
    set({
      importing: true,
      importWarnings: [],
      importReportDir: null,
      importProgress: 0,
      importStep: '正在开始导入...',
      importStepLog: [],
      showImportProgress: true,
    });
    try {
      const result = await trpc.coverage.import.mutate({
        projectId,
        covMergeDir,
        edaConfig,
      });
      set({
        importing: false,
        currentSessionId: result.sessionId,
        overview: result.summary,
        importWarnings: result.warnings ?? [],
        importReportDir: result.reportDir ?? null,
      });
      // 导入后刷新 session 列表和树
      await get().loadSessions(projectId);
      await get().loadTree(projectId, result.sessionId);

      // 如果有警告，显示 warning toast
      if (result.warnings && result.warnings.length > 0) {
        useToastStore.getState().warning(
          '覆盖率导入完成（但有警告）',
          result.warnings.join('\n'),
        );
      } else {
        useToastStore.getState().success('覆盖率导入成功', `Session: ${result.sessionId}`);
      }
      return result.sessionId;
    } catch (err) {
      set({ importing: false, showImportProgress: false });
      useToastStore.getState().error('覆盖率导入失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  setSessionId: (sessionId) => set({ currentSessionId: sessionId }),

  browseDirectory: async (defaultPath) => {
    try {
      const result = await trpc.coverage.browseDirectory.mutate({ defaultPath });
      if (result.canceled || !result.path) return null;
      return result.path;
    } catch (err) {
      useToastStore.getState().error('选择目录失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  deleteSession: async (projectId, sessionId) => {
    try {
      await trpc.coverage.deleteSession.mutate({ projectId, sessionId });
      // 切换当前 session 到剩余的第一个（若有）
      const remaining = get().sessions.filter((s) => s.sessionId !== sessionId);
      const wasCurrent = get().currentSessionId === sessionId;
      set({
        sessions: remaining,
        currentSessionId: wasCurrent ? (remaining[0]?.sessionId ?? null) : get().currentSessionId,
        tree: wasCurrent ? null : get().tree,
        overview: wasCurrent ? null : get().overview,
      });
      // 跨 store：清空 gaps store 相关状态
      if (wasCurrent) {
        useCoverageGapsStore.getState().clearSessionData();
      }
      useToastStore.getState().success('Session 已删除');
      return true;
    } catch (err) {
      useToastStore.getState().error('删除 session 失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  // ─── Debug 操作实现 ────────────────────────────────────────

  loadImportLog: async (projectId, sessionId) => {
    try {
      const log = await trpc.coverage.getImportLog.query({ projectId, sessionId });
      set({ importLog: log, showDebugPanel: true });
    } catch (err) {
      useToastStore.getState().error('加载导入日志失败', err instanceof Error ? err.message : String(err));
    }
  },

  toggleDebugPanel: () => set((s) => ({ showDebugPanel: !s.showDebugPanel })),

  clearImportWarnings: () => set({ importWarnings: [], importReportDir: null }),

  // ─── 导入进度实现 ────────────────────────────────────────────

  registerImportProgressListener: () => {
    if (get().importProgressListenerRegistered) return;
    if (!window.eventBridge) return;
    set({ importProgressListenerRegistered: true });
    window.eventBridge.onCoverageImportProgress((event) => {
      get().handleImportProgress(event);
    });
  },

  handleImportProgress: (event) => {
    const logEntry = {
      step: event.step,
      message: event.message,
      timestamp: Date.now(),
      durationMs: event.durationMs,
    };
    set((s) => ({
      importProgress: event.percent ?? s.importProgress,
      importStep: event.message,
      showImportProgress: true,
      importStepLog: [...s.importStepLog, logEntry],
    }));
    // 导入完成时自动隐藏进度面板（延迟 3 秒）
    if (event.step === 'done') {
      setTimeout(() => {
        set({ showImportProgress: false });
      }, 3000);
    }
  },

  clearImportProgress: () => set({
    importProgress: 0,
    importStep: '',
    importStepLog: [],
    showImportProgress: false,
  }),

  // ─── 按需详细解析实现（分层解析） ────────────────────────────

  parseDetails: async (projectId, sessionId) => {
    set({
      detailParsing: true,
      detailParseProgress: 0,
      detailParseStep: '正在开始详细解析...',
      detailParseStepLog: [],
      showDetailParseProgress: true,
    });
    try {
      await trpc.coverage.parseDetails.mutate({ projectId, sessionId });
      set({
        detailParsing: false,
        detailParsed: true,
      });
      // 详细解析完成后刷新树和深度分析数据
      await get().loadTree(projectId, sessionId);
      // 自动加载深度分析数据
      await Promise.all([
        get().loadTestContributions(projectId, sessionId),
        get().loadUncovered(projectId, sessionId),
        get().loadCsvData(projectId, sessionId),
      ]);
      useToastStore.getState().success('详细覆盖率解析完成', `Session: ${sessionId}`);
      return true;
    } catch (err) {
      set({ detailParsing: false });
      useToastStore.getState().error('详细覆盖率解析失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  registerDetailProgressListener: () => {
    if (get().detailProgressListenerRegistered) return;
    if (!window.eventBridge) return;
    set({ detailProgressListenerRegistered: true });
    window.eventBridge.onCoverageDetailProgress((event) => {
      get().handleDetailProgress(event);
    });
  },

  handleDetailProgress: (event) => {
    const logEntry = {
      step: event.step,
      message: event.message,
      timestamp: Date.now(),
      durationMs: event.durationMs,
    };
    set((s) => ({
      detailParseProgress: event.percent ?? s.detailParseProgress,
      detailParseStep: event.message,
      showDetailParseProgress: true,
      detailParseStepLog: [...s.detailParseStepLog, logEntry],
    }));
    // 详细解析完成时自动隐藏进度面板（延迟 3 秒）
    if (event.step === 'done') {
      setTimeout(() => {
        set({ showDetailParseProgress: false });
      }, 3000);
    }
  },

  clearDetailParseProgress: () => set({
    detailParseProgress: 0,
    detailParseStep: '',
    detailParseStepLog: [],
    showDetailParseProgress: false,
  }),

  // ─── detail.txt 解析实现（instance 级 blocks/branches/statements） ──

  parseDetailMetrics: async (projectId, sessionId) => {
    set({ detailMetricsParsing: true });
    try {
      const result = await trpc.coverage.parseDetailMetrics.mutate({ projectId, sessionId });
      set({ detailMetricsParsing: false, detailMetricsParsed: true });
      // detail 数据已合并进树缓存（statements→line / branches→branch），刷新树
      await get().loadTree(projectId, sessionId);
      useToastStore.getState().success(
        'detail 覆盖率解析完成',
        `${result.instanceCount} 个 instance（blocks/branches/statements 已合并进树）`,
      );
      return true;
    } catch (err) {
      set({ detailMetricsParsing: false });
      useToastStore.getState().error('detail 覆盖率解析失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  // ─── 覆盖率深度分析动作实现 ────────────────────────────────
  loadTestContributions: async (projectId, sessionId) => {
    try {
      const sid = sessionId ?? get().currentSessionId ?? undefined;
      const result = await trpc.coverage.getTestContributions.query({ projectId, sessionId: sid });
      set({ testContributions: result.contributions });
    } catch (err) {
      useToastStore.getState().error('加载测试用例贡献度失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadUncovered: async (projectId, sessionId, metric) => {
    try {
      const sid = sessionId ?? get().currentSessionId ?? undefined;
      const result = await trpc.coverage.getUncovered.query({ projectId, sessionId: sid, metric });
      set({ uncoveredItems: result.uncovered });
    } catch (err) {
      useToastStore.getState().error('加载未覆盖项失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadCsvData: async (projectId, sessionId) => {
    try {
      const sid = sessionId ?? get().currentSessionId ?? undefined;
      const result = await trpc.coverage.getCsvData.query({ projectId, sessionId: sid });
      set({ csvData: result.csvData });
    } catch (err) {
      useToastStore.getState().error('加载 CSV 数据失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
