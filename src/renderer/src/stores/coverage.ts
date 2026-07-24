import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useProjectStore } from './project';
import type {
  CoverageData,
  CoverageMergeSession,
  CoverageSummary,
  EdaToolConfig,
  CoverageMetric,
  CoverageGap,
  CoverageDelta,
  CoverageTriage,
  CoverageExclusion,
  TriageCause,
  TriageConfidence,
  ExclusionStatus,
  PromotionQueueItem,
  ClosureSummary,
  TestContribution,
  UncoveredItem,
} from '@shared/types';

// ─── Closure 相关类型（从主进程闭包包导入的等价类型） ────────────
// 这些类型与 src/main/coverage/closure-manager.ts 中的定义保持一致，
// 但因渲染进程无法直接导入主进程模块，这里重新声明（结构兼容）。

type ClosureStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
type GapIterationStatus = 'pending' | 'running' | 'completed' | 'failed';
type ClosureGapStatus = 'pending' | 'in_progress' | 'closed' | 'escalated' | 'failed';

type GapIteration = {
  round: number;
  generatedTests: string[];
  deltaBefore?: CoverageSummary;
  deltaAfter?: CoverageSummary;
  deltas?: CoverageDelta[];
  status: GapIterationStatus;
  error?: string;
};

type ClosureGap = {
  id: string;
  gap: CoverageGap;
  iterations: GapIteration[];
  status: ClosureGapStatus;
  escalationReason?: string;
};

type ClosureSession = {
  id: string;
  sessionId: string;
  createdAt: number;
  status: ClosureStatus;
  gaps: ClosureGap[];
  maxRounds: number;
  escalationThreshold: number;
  workspaceDir: string;
};

// ─── 实时事件进度（由 closure:event IPC 推送） ────────────────────
type ClosureLiveProgress = {
  /** 当前是否正在运行 */
  running: boolean;
  /** 当前正在处理的 gapId 和 round（如有） */
  activeGapId?: string;
  activeRound?: number;
  /** 最近一次 agent 状态 */
  agentSessionId?: string;
  agentPhase?: 'prompting' | 'ended';
  /** 最近一轮 delta */
  lastDeltaOverall?: number;
  /** 最近一次错误（gap_failed / closure:error） */
  lastError?: string;
  /** 最近一轮扫描到的测试文件 */
  lastGeneratedTests?: string[];
};

// ─── 报告导出（Slice 7 / Issue #9） ──────────────────────────────
// 这些类型与 src/main/coverage/coverage-exporter.ts 中的定义结构兼容，
// 但因渲染进程不直接导入主进程模块，这里重新声明。
type ExportFormat = 'html' | 'json';
type ExportScope = 'current' | 'compare';

interface CoverageStoreState {
  /** 所有 Coverage Merge Session（按创建时间倒序） */
  sessions: CoverageMergeSession[];
  /** 当前选中的 session ID */
  currentSessionId: string | null;
  /** 当前 session 的完整 CoverageData（层级树） */
  tree: CoverageData | null;
  /** 扁平摘要（root 8 metric 百分比），由 tree 派生 */
  overview: CoverageSummary | null;
  /** 项目级 EDA Tool Configuration */
  edaConfig: EdaToolConfig | null;
  /** 当前 session 的覆盖率目标（与默认值合并后的有效目标） */
  targets: Partial<Record<CoverageMetric, number>>;
  /** 当前 session 的 Gap 列表 */
  gaps: CoverageGap[];
  /** 当前 session 的 Triage 列表 */
  triages: CoverageTriage[];
  /** 当前 session 的 Exclusion 列表 */
  exclusions: CoverageExclusion[];
  /** 两个 session 之间的 Delta（手动计算后填充） */
  delta: { before: CoverageSummary; after: CoverageSummary; deltas: CoverageDelta[] } | null;
  /** 覆盖率趋势数据（按 session 时间序列） */
  trend: Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }>;
  loading: boolean;
  importing: boolean;

  /** 当前 UI 视图：树表格 / 仪表盘 */
  view: 'tree-table' | 'dashboard';
  setView: (view: 'tree-table' | 'dashboard') => void;

  // ─── Closure 相关状态（Slice 6b） ────────────────────────────
  /** 所有 Closure Session 列表 */
  closures: ClosureSession[];
  /** 当前选中的 closureId */
  currentClosureId: string | null;
  /** 当前选中的 ClosureSession 完整数据 */
  currentClosure: ClosureSession | null;
  /** 实时进度（由 closure:event 事件流更新） */
  closureLive: ClosureLiveProgress;
  /** closure 事件监听器是否已注册 */
  closureListenerRegistered: boolean;

  // ─── 报告导出状态（Slice 7） ────────────────────────────────
  /** 导出对话框是否打开 */
  exportDialogOpen: boolean;
  /** 导出格式 */
  exportFormat: ExportFormat;
  /** 导出范围：当前 session / 两个 session 对比 */
  exportScope: ExportScope;
  /** 对比范围时的 After session（Before 固定为当前 session） */
  exportCompareSessionId: string | null;
  /** 导出文件保存路径 */
  exportOutputPath: string;
  /** 是否正在执行导出（异步，非阻塞 UI） */
  exporting: boolean;

  // ─── Test Promotion 状态（Slice 8） ────────────────────────
  /** Test Promotion 审阅队列 */
  promotionQueue: PromotionQueueItem[];
  /** Closure 闭环结果摘要 */
  closureSummary: ClosureSummary | null;
  /** 是否正在执行 Test Promotion 提升 */
  promoting: boolean;

  // ─── Debug 信息（导入日志） ────────────────────────────────
  /** 最近一次导入的警告信息 */
  importWarnings: string[];
  /** 最近一次导入的报告目录路径 */
  importReportDir: string | null;
  /** 导入日志内容（EDA 命令日志 + 解析器日志） */
  importLog: { edaLog: string | null; parserLog: string | null; reportDir: string; files: string[] } | null;
  /** 是否显示 debug 面板 */
  showDebugPanel: boolean;

  // ─── 覆盖率深度分析（urg -grade / imc report -bins / CSV） ──────
  /** 测试用例贡献度排名 */
  testContributions: TestContribution[];
  /** 未覆盖项列表（按 metric 分组） */
  uncoveredItems: Partial<Record<CoverageMetric, UncoveredItem[]>>;
  /** CSV 原始覆盖率数据 */
  csvData: string | null;

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

  // ─── Closure 操作（Slice 6b） ────────────────────────────────
  startClosure: (
    projectId: string,
    sessionId: string,
    gaps?: CoverageGap[],
    maxRounds?: number,
  ) => Promise<string | null>;
  abortClosure: (projectId: string, closureId: string) => Promise<void>;
  loadClosures: (projectId: string) => Promise<void>;
  loadClosure: (projectId: string, closureId: string) => Promise<void>;
  setCurrentClosure: (closureId: string | null) => void;
  /** 注册 closure:event IPC 监听器（幂等，全局只需注册一次） */
  registerClosureEventListener: () => void;
  /** 处理 closure:event 事件（内部使用） */
  handleClosureEvent: (event: { type: string; [key: string]: unknown }) => void;

  // ─── Slice 2 新增 ──────────────────────────────────────────
  loadTargets: (projectId: string, sessionId?: string) => Promise<void>;
  setTargets: (
    projectId: string,
    sessionId: string,
    targets: Partial<Record<CoverageMetric, number>>,
  ) => Promise<void>;
  loadGaps: (projectId: string, sessionId?: string) => Promise<void>;
  loadDelta: (
    projectId: string,
    sessionIdBefore: string,
    sessionIdAfter: string,
  ) => Promise<void>;
  loadTrend: (projectId: string, limit?: number) => Promise<void>;
  loadTriages: (projectId: string, sessionId?: string) => Promise<void>;
  addTriage: (
    projectId: string,
    input: {
      sessionId: string;
      nodePath: string;
      metric: CoverageMetric;
      gap: CoverageGap;
      cause?: TriageCause;
      confidence?: TriageConfidence;
      note?: string;
      triagedBy?: string;
    },
  ) => Promise<void>;
  deleteTriage: (projectId: string, id: string) => Promise<void>;
  loadExclusions: (
    projectId: string,
    sessionId?: string,
    status?: ExclusionStatus,
  ) => Promise<void>;
  requestExclusion: (
    projectId: string,
    input: {
      sessionId: string;
      nodePath: string;
      metric: CoverageMetric;
      reason: string;
      requestedBy: string;
    },
  ) => Promise<void>;
  approveExclusion: (projectId: string, id: string, approver: string) => Promise<void>;
  rejectExclusion: (
    projectId: string,
    id: string,
    approver: string,
    reason: string,
  ) => Promise<void>;
  deleteSession: (projectId: string, sessionId: string) => Promise<boolean>;

  // ─── 报告导出动作（Slice 7） ────────────────────────────────
  /** 打开导出对话框（重置为默认状态，Before 固定为当前 session） */
  openExportDialog: () => void;
  /** 关闭导出对话框 */
  closeExportDialog: () => void;
  /** 设置导出格式（HTML / JSON） */
  setExportFormat: (format: ExportFormat) => void;
  /** 设置导出范围（current / compare） */
  setExportScope: (scope: ExportScope) => void;
  /** 设置对比范围的 After session */
  setExportCompareSessionId: (sessionId: string | null) => void;
  /** 设置导出文件保存路径 */
  setExportOutputPath: (path: string) => void;
  /** 调用主进程原生保存对话框选择导出路径 */
  pickExportPath: () => Promise<void>;
  /** 执行导出（异步，非阻塞 UI，完成发 toast 通知） */
  runExport: (projectId: string) => Promise<boolean>;

  // ─── Test Promotion 动作（Slice 8） ────────────────────────
  /** 加载 Test Promotion 审阅队列 */
  loadPromotionQueue: (projectId: string, closureId: string) => Promise<void>;
  /** 执行 Test Promotion：接受的复制到正式目录，拒绝的丢弃 */
  promoteTests: (
    projectId: string,
    closureId: string,
    accepted: string[],
    rejected: string[],
  ) => Promise<void>;
  /** 加载 Closure 闭环结果摘要 */
  loadClosureSummary: (projectId: string, closureId: string) => Promise<void>;
  /** 清理 Closure Workspace 临时目录 */
  cleanupClosure: (projectId: string, closureId: string) => Promise<void>;

  // ─── Debug 操作 ────────────────────────────────────────────
  /** 加载指定 session 的导入日志 */
  loadImportLog: (projectId: string, sessionId: string) => Promise<void>;
  /** 切换 debug 面板显示 */
  toggleDebugPanel: () => void;
  /** 清除导入警告 */
  clearImportWarnings: () => void;

  // ─── 覆盖率深度分析动作 ────────────────────────────────────
  /** 加载测试用例贡献度排名 */
  loadTestContributions: (projectId: string, sessionId?: string) => Promise<void>;
  /** 加载未覆盖项列表 */
  loadUncovered: (projectId: string, sessionId?: string, metric?: CoverageMetric) => Promise<void>;
  /** 加载 CSV 原始覆盖率数据 */
  loadCsvData: (projectId: string, sessionId?: string) => Promise<void>;
}

export const useCoverageStore = create<CoverageStoreState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  tree: null,
  overview: null,
  edaConfig: null,
  targets: {},
  gaps: [],
  triages: [],
  exclusions: [],
  delta: null,
  trend: [],
  loading: false,
  importing: false,
  view: 'tree-table',
  closures: [],
  currentClosureId: null,
  currentClosure: null,
  closureLive: { running: false },
  closureListenerRegistered: false,

  // ─── 报告导出初始状态（Slice 7） ────────────────────────────
  exportDialogOpen: false,
  exportFormat: 'html',
  exportScope: 'current',
  exportCompareSessionId: null,
  exportOutputPath: '',
  exporting: false,

  // ─── Test Promotion 初始状态（Slice 8） ────────────────────
  promotionQueue: [],
  closureSummary: null,
  promoting: false,

  // ─── Debug 信息初始状态 ────────────────────────────────────
  importWarnings: [],
  importReportDir: null,
  importLog: null,
  showDebugPanel: false,

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
    set({ loading: true });
    try {
      const tree = await trpc.coverage.getTree.query({ projectId, sessionId: sid });
      const overview = await trpc.coverage.getOverview.query({ projectId, sessionId: sid });
      set({
        tree,
        overview: overview.summary,
        currentSessionId: overview.sessionId,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, tree: null, overview: null });
      useToastStore.getState().error('加载覆盖率数据失败', err instanceof Error ? err.message : String(err));
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
    set({ importing: true, importWarnings: [], importReportDir: null });
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
      set({ importing: false });
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

  // ─── Closure 实现（Slice 6b） ─────────────────────────────

  startClosure: async (projectId, sessionId, gaps, maxRounds) => {
    try {
      const session = await trpc.coverage.startClosure.mutate({
        projectId,
        sessionId,
        gaps,
        maxRounds,
      });
      set({
        currentClosureId: session.id,
        currentClosure: session,
        closureLive: { running: true },
        closures: [...get().closures, session],
      });
      useToastStore.getState().success('AI Closure 已启动', `${session.gaps.length} 个 Gap`);
      return session.id;
    } catch (err) {
      useToastStore.getState().error('启动 AI Closure 失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  abortClosure: async (projectId, closureId) => {
    try {
      await trpc.coverage.abortClosure.mutate({ projectId, closureId });
      set({ closureLive: { running: false } });
      // 刷新当前 closure 状态（应变为 aborted）
      await get().loadClosure(projectId, closureId);
      useToastStore.getState().info('AI Closure 已中止');
    } catch (err) {
      useToastStore.getState().error('中止 AI Closure 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadClosures: async (projectId) => {
    try {
      const closures = await trpc.coverage.listClosures.query({ projectId });
      set({ closures });
    } catch (err) {
      useToastStore.getState().error('加载 Closure 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadClosure: async (projectId, closureId) => {
    try {
      const closure = await trpc.coverage.getClosure.query({ projectId, closureId });
      set({
        currentClosureId: closureId,
        currentClosure: closure,
        // 若 closure 已进入终态，同步关闭 live 运行标志
        closureLive: closure && ['completed', 'aborted', 'failed'].includes(closure.status)
          ? { running: false }
          : get().closureLive,
      });
    } catch (err) {
      useToastStore.getState().error('加载 Closure 详情失败', err instanceof Error ? err.message : String(err));
    }
  },

  setCurrentClosure: (closureId) => {
    if (closureId === null) {
      set({ currentClosureId: null, currentClosure: null });
      return;
    }
    const found = get().closures.find((c) => c.id === closureId) ?? null;
    set({ currentClosureId: closureId, currentClosure: found });
  },

  registerClosureEventListener: () => {
    if (get().closureListenerRegistered) return;
    if (!window.eventBridge) return;
    set({ closureListenerRegistered: true });
    window.eventBridge.onClosureEvent((event) => {
      get().handleClosureEvent(event);
    });
  },

  handleClosureEvent: (event) => {
    const type = event.type;
    const closureId = typeof event.closureId === 'string' ? event.closureId : undefined;
    if (!closureId) return;

    const current = get().currentClosureId;
    const isCurrent = current === closureId;

    // 根据事件类型更新 closureLive（仅当事件属于当前关注的 closure）
    if (isCurrent) {
      const live = { ...get().closureLive };
      live.running = true;

      switch (type) {
        case 'closure:started':
          live.running = true;
          break;
        case 'closure:gap_started':
          live.activeGapId = typeof event.gapId === 'string' ? event.gapId : live.activeGapId;
          live.activeRound = typeof event.round === 'number' ? event.round : live.activeRound;
          live.agentPhase = undefined;
          break;
        case 'closure:agent_prompting':
          live.agentSessionId = typeof event.sessionId === 'string' ? event.sessionId : live.agentSessionId;
          live.agentPhase = 'prompting';
          break;
        case 'closure:agent_ended':
          live.agentPhase = 'ended';
          break;
        case 'closure:tests_scanned':
          live.lastGeneratedTests = Array.isArray(event.files) ? (event.files as string[]) : live.lastGeneratedTests;
          break;
        case 'closure:iteration_done':
          live.lastDeltaOverall = typeof event.deltaOverall === 'number' ? event.deltaOverall : live.lastDeltaOverall;
          live.agentPhase = undefined;
          break;
        case 'closure:gap_closed':
        case 'closure:gap_escalated':
          live.activeGapId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:gap_failed':
          live.lastError = typeof event.error === 'string' ? event.error : 'Gap 失败';
          live.activeGapId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:completed':
        case 'closure:aborted':
          live.running = false;
          live.activeGapId = undefined;
          live.activeRound = undefined;
          live.agentPhase = undefined;
          break;
        case 'closure:error':
          live.running = false;
          live.lastError = typeof event.error === 'string' ? event.error : 'Closure 错误';
          break;
        default:
          break;
      }
      set({ closureLive: live });
    }

    // 异步刷新当前 closure 完整数据（兜底 IPC 推送，确保状态一致）
    if (isCurrent) {
      const projectId = useProjectStore.getState().currentProjectId;
      if (projectId) {
        void get().loadClosure(projectId, closureId);
      }
    }
  },

  // ─── Slice 2 实现 ──────────────────────────────────────────

  loadTargets: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    try {
      const targets = await trpc.coverage.getTarget.query({ projectId, sessionId: sid });
      set({ targets });
    } catch (err) {
      useToastStore.getState().error('加载覆盖率目标失败', err instanceof Error ? err.message : String(err));
    }
  },

  setTargets: async (projectId, sessionId, targets) => {
    try {
      const merged = await trpc.coverage.setTarget.mutate({ projectId, sessionId, targets });
      set({ targets: merged });
      // 目标变化后 Gap 也要刷新
      await get().loadGaps(projectId, sessionId);
      useToastStore.getState().success('覆盖率目标已保存');
    } catch (err) {
      useToastStore.getState().error('保存覆盖率目标失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadGaps: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    try {
      const result = await trpc.coverage.listGaps.query({ projectId, sessionId: sid });
      set({ gaps: result.gaps, currentSessionId: result.sessionId });
    } catch (err) {
      useToastStore.getState().error('加载覆盖率缺口失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadDelta: async (projectId, sessionIdBefore, sessionIdAfter) => {
    try {
      const delta = await trpc.coverage.getDelta.query({
        projectId,
        sessionIdBefore,
        sessionIdAfter,
      });
      set({ delta });
    } catch (err) {
      useToastStore.getState().error('计算覆盖率变化失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadTrend: async (projectId, limit) => {
    try {
      const result = await trpc.coverage.getTrend.query({ projectId, limit: limit ?? 20 });
      set({ trend: result });
    } catch (err) {
      useToastStore.getState().error('加载覆盖率趋势失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadTriages: async (projectId, sessionId) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    try {
      const triages = await trpc.coverage.listTriage.query({ projectId, sessionId: sid });
      set({ triages });
    } catch (err) {
      useToastStore.getState().error('加载 Triage 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  addTriage: async (projectId, input) => {
    try {
      await trpc.coverage.addTriage.mutate({ projectId, ...input });
      await get().loadTriages(projectId, input.sessionId);
      useToastStore.getState().success('Triage 已添加');
    } catch (err) {
      useToastStore.getState().error('添加 Triage 失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteTriage: async (projectId, id) => {
    try {
      await trpc.coverage.deleteTriage.mutate({ projectId, id });
      await get().loadTriages(projectId);
      useToastStore.getState().success('Triage 已删除');
    } catch (err) {
      useToastStore.getState().error('删除 Triage 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadExclusions: async (projectId, sessionId, status) => {
    const sid = sessionId ?? get().currentSessionId ?? undefined;
    try {
      const exclusions = await trpc.coverage.listExclusions.query({
        projectId,
        sessionId: sid,
        status,
      });
      set({ exclusions });
    } catch (err) {
      useToastStore.getState().error('加载排除项列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  requestExclusion: async (projectId, input) => {
    try {
      await trpc.coverage.requestExclusion.mutate({ projectId, ...input });
      await get().loadExclusions(projectId, input.sessionId);
      useToastStore.getState().success('排除请求已提交，等待审批');
    } catch (err) {
      useToastStore.getState().error('提交排除请求失败', err instanceof Error ? err.message : String(err));
    }
  },

  approveExclusion: async (projectId, id, approver) => {
    try {
      await trpc.coverage.approveExclusion.mutate({ projectId, id, approver });
      await get().loadExclusions(projectId);
      useToastStore.getState().success('排除项已通过审批');
    } catch (err) {
      useToastStore.getState().error('审批失败', err instanceof Error ? err.message : String(err));
    }
  },

  rejectExclusion: async (projectId, id, approver, reason) => {
    try {
      await trpc.coverage.rejectExclusion.mutate({ projectId, id, approver, reason });
      await get().loadExclusions(projectId);
      useToastStore.getState().success('排除请求已驳回');
    } catch (err) {
      useToastStore.getState().error('驳回失败', err instanceof Error ? err.message : String(err));
    }
  },

  deleteSession: async (projectId, sessionId) => {
    try {
      await trpc.coverage.deleteSession.mutate({ projectId, sessionId });
      // 切换当前 session 到剩余的第一个（若有）
      const remaining = get().sessions.filter((s) => s.sessionId !== sessionId);
      set({
        sessions: remaining,
        currentSessionId: get().currentSessionId === sessionId
          ? (remaining[0]?.sessionId ?? null)
          : get().currentSessionId,
        tree: get().currentSessionId === sessionId ? null : get().tree,
        overview: get().currentSessionId === sessionId ? null : get().overview,
        gaps: get().currentSessionId === sessionId ? [] : get().gaps,
        triages: get().currentSessionId === sessionId ? [] : get().triages,
        exclusions: get().currentSessionId === sessionId ? [] : get().exclusions,
      });
      useToastStore.getState().success('Session 已删除');
      return true;
    } catch (err) {
      useToastStore.getState().error('删除 session 失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  // ─── 报告导出实现（Slice 7） ───────────────────────────────

  openExportDialog: () => {
    // 打开时重置为默认值；Before 固定为当前 session，After 留空待选
    const current = get().currentSessionId;
    set({
      exportDialogOpen: true,
      exportFormat: 'html',
      exportScope: 'current',
      exportCompareSessionId: null,
      exportOutputPath: '',
      exporting: false,
    });
    // 默认文件名带当前 session 前缀（仅用于建议，不强制）
    if (current) {
      set({ exportOutputPath: '' });
    }
  },

  closeExportDialog: () => set({ exportDialogOpen: false, exporting: false }),

  setExportFormat: (format) => {
    set({ exportFormat: format });
    // 切换格式时清空旧路径扩展名不匹配的情况——保留路径但提示用户重新选择
    const cur = get().exportOutputPath;
    if (cur) {
      const ext = format === 'html' ? '.html' : '.json';
      const oldExt = format === 'html' ? '.json' : '.html';
      if (cur.endsWith(oldExt)) {
        set({ exportOutputPath: cur.slice(0, -oldExt.length) + ext });
      }
    }
  },

  setExportScope: (scope) => set({ exportScope: scope }),

  setExportCompareSessionId: (sessionId) => set({ exportCompareSessionId: sessionId }),

  setExportOutputPath: (path) => set({ exportOutputPath: path }),

  pickExportPath: async () => {
    const format = get().exportFormat;
    const current = get().currentSessionId;
    const defaultName = current ? `coverage-${current}.${format}` : `coverage-report.${format}`;
    try {
      const result = await trpc.coverage.pickExportPath.mutate({ format, defaultName });
      if (result.outputPath) {
        set({ exportOutputPath: result.outputPath });
      }
      // 用户取消时保持原路径不变
    } catch (err) {
      useToastStore.getState().error('选择导出路径失败', err instanceof Error ? err.message : String(err));
    }
  },

  runExport: async (projectId) => {
    const { exportFormat, exportScope, exportCompareSessionId, exportOutputPath, currentSessionId } = get();
    if (!exportOutputPath.trim()) {
      useToastStore.getState().warning('请先选择导出文件保存路径');
      return false;
    }
    if (exportScope === 'compare') {
      if (!currentSessionId || !exportCompareSessionId) {
        useToastStore.getState().warning('对比导出需要选择 Before 和 After 两个 session');
        return false;
      }
      if (currentSessionId === exportCompareSessionId) {
        useToastStore.getState().warning('对比导出的两个 session 不能相同');
        return false;
      }
    }
    set({ exporting: true });
    try {
      const result = await trpc.coverage.exportReport.mutate({
        projectId,
        scope: exportScope,
        sessionId: exportScope === 'compare' ? currentSessionId ?? undefined : currentSessionId ?? undefined,
        compareSessionId: exportScope === 'compare' ? exportCompareSessionId ?? undefined : undefined,
        format: exportFormat,
        outputPath: exportOutputPath,
      });
      set({ exporting: false, exportDialogOpen: false });
      const fmtLabel = exportFormat === 'html' ? 'HTML' : 'JSON';
      const scopeLabel = exportScope === 'compare' ? '对比' : '';
      useToastStore.getState().success(
        `${scopeLabel}覆盖率报告已导出（${fmtLabel}）`,
        result.outputPath,
      );
      return true;
    } catch (err) {
      set({ exporting: false });
      useToastStore.getState().error('导出覆盖率报告失败', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  // ─── Test Promotion 实现（Slice 8） ────────────────────────

  loadPromotionQueue: async (projectId, closureId) => {
    try {
      const queue = await trpc.coverage.getPromotionQueue.query({ projectId, closureId });
      set({ promotionQueue: queue });
    } catch (err) {
      useToastStore.getState().error('加载 Test Promotion 队列失败', err instanceof Error ? err.message : String(err));
    }
  },

  promoteTests: async (projectId, closureId, accepted, rejected) => {
    set({ promoting: true });
    try {
      const result = await trpc.coverage.promoteTests.mutate({
        projectId,
        closureId,
        accepted,
        rejected,
      });
      set({ promoting: false });
      // 刷新队列状态和摘要
      await get().loadPromotionQueue(projectId, closureId);
      await get().loadClosureSummary(projectId, closureId);
      useToastStore.getState().success(
        'Test Promotion 完成',
        `已提升 ${result.promoted} 个测试，拒绝 ${result.rejected} 个`,
      );
    } catch (err) {
      set({ promoting: false });
      useToastStore.getState().error('Test Promotion 失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadClosureSummary: async (projectId, closureId) => {
    try {
      const summary = await trpc.coverage.getClosureSummary.query({ projectId, closureId });
      set({ closureSummary: summary });
    } catch (err) {
      useToastStore.getState().error('加载 Closure 摘要失败', err instanceof Error ? err.message : String(err));
    }
  },

  cleanupClosure: async (projectId, closureId) => {
    try {
      await trpc.coverage.cleanupClosure.mutate({ projectId, closureId });
      // 清理后清空本地队列与摘要
      set({ promotionQueue: [], closureSummary: null });
      useToastStore.getState().success('Closure Workspace 已清理');
    } catch (err) {
      useToastStore.getState().error('清理 Closure Workspace 失败', err instanceof Error ? err.message : String(err));
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
