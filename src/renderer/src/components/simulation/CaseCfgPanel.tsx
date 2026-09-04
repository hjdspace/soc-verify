/**
 * 自定义用例 cfg 管理面板。
 *
 * 参考 Python `case_panel.py` 的用例管理面板：
 * - "解析环境" 按钮：扫描 $PROJ_ENV 下的子系统，多选后加载 .cfg 文件
 * - "加载用例" 按钮：打开文件选择对话框，选择 .cfg/.txt 文件
 * - 用例树：展示已加载的 cfg 文件及其用例树（文件分组 + base/child 层级）
 * - 右键菜单：删除用例、刷新
 * - 选中用例 → selectCase 联动 SimOptionPanel
 *
 * 与 CaseTreePanel 的差异：
 * - CaseTreePanel 从子系统插件发现用例（全量），按子系统分组
 * - CaseCfgPanel 从用户自定义加载的 cfg 文件解析用例，按文件分组
 * - 两者共用 buildCaseTree / CaseTreeItem 渲染树结构
 */

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  FolderOpen,
  RefreshCw,
  Trash2,
  X,
  Search,
  Loader2,
  Play,
  Zap,
  Copy,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useEnvStore } from '@renderer/stores/env';
import { useToastStore } from '@renderer/stores/toast';
import {
  buildCaseTree,
  CaseTreeItem,
  getCaseId,
  type CaseData,
  type CaseTreeNode,
} from '@renderer/components/project/case-tree-utils';

type CaseFileData = {
  name: string;
  fullPath: string;
  nodes: string[];
  childCases: Array<{ case: string; base: string }>;
  base: string;
  block: string;
};

type SubsysInfo = {
  name: string;
  path: string;
};

type UdtbDirInfo = {
  relPath: string;
  fullPath: string;
};

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  caseData: CaseData | null;
  fileNode: CaseTreeNode | null;
}

/** UDTB 二级弹窗状态：逐个处理选中的子系统 */
interface UdtbDialogState {
  visible: boolean;
  /** 当前正在处理的子系统名 */
  currentSubsys: string;
   /** 还未处理的子系统列表 */
  remainingSubsystems: string[];
  /** 扫描到的 UDTB 子目录列表 */
  dirs: UdtbDirInfo[];
  /** 用户选中的 UDTB 子目录 */
  selectedDirs: Set<string>;
  /** 所有子系统收集到的 UDTB 目录（最终传给 loadFromEnv） */
  collectedDirs: string[];
  /** 是否正在扫描 UDTB 目录 */
  scanning: boolean;
}

export function CaseCfgPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectCase = useSimulationStore((s) => s.selectCase);
  const startCaseRuns = useSimulationStore((s) => s.startCaseRuns);
  const configProjEnv = useEnvStore((s) => s.config?.envVars.PROJ_ENV);
  const systemEnvVars = useEnvStore((s) => s.systemEnvVars);
  const loadSystemEnv = useEnvStore((s) => s.loadSystemEnv);
  const loadConfig = useEnvStore((s) => s.loadConfig);

  // Merge: config env vars (user-saved) take priority, fall back to system-detected.
  // This ensures the "解析环境" button is enabled as soon as $PROJ_ENV is
  // detected from the login shell — without requiring the user to open the
  // Env Manager dialog.
  const projEnv = configProjEnv ?? systemEnvVars['PROJ_ENV'] ?? undefined;

  // Auto-load system env vars on mount (and when project changes) so the
  // button state is correct without requiring Env Manager to be opened.
  useEffect(() => {
    void loadSystemEnv();
    if (currentProjectId) void loadConfig(currentProjectId);
  }, [loadSystemEnv, loadConfig, currentProjectId]);

  const [loadedFiles, setLoadedFiles] = useState<CaseFileData[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    caseData: null,
    fileNode: null,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CaseData[]>([]);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [showSubsysDialog, setShowSubsysDialog] = useState(false);
  const [subsystems, setSubsystems] = useState<SubsysInfo[]>([]);
  const [selectedSubsystems, setSelectedSubsystems] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [udtbDialog, setUdtbDialog] = useState<UdtbDialogState>({
    visible: false,
    currentSubsys: '',
    remainingSubsystems: [],
    dirs: [],
    selectedDirs: new Set(),
    collectedDirs: [],
    scanning: false,
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Load persisted files on mount
  const loadFiles = useCallback(async () => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      const result = await trpc.caseCfg.getLoadedFiles.query({
        projectId: currentProjectId,
      });
      setLoadedFiles(result.files as CaseFileData[]);
      // Auto-expand all loaded files
      const paths = new Set<string>();
      for (const f of result.files) {
        paths.add(f.fullPath);
      }
      setExpandedFiles(paths);
    } catch (err) {
      useToastStore.getState().error(
        '加载失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, [currentProjectId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handler = () => setContextMenu((s) => ({ ...s, visible: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu.visible]);

  // Build CaseData[] from loaded files for tree rendering
  const allCases: CaseData[] = useMemo(() => {
    const cases: CaseData[] = [];
    for (const file of loadedFiles) {
      // Root cases (nodes)
      for (const caseName of file.nodes) {
        cases.push({
          name: caseName,
          subsys: file.block || '',
          path: file.fullPath,
          filePath: file.fullPath,
          base: file.base || undefined,
          block: file.block || undefined,
          baseCase: undefined,
        });
      }
      // Child cases
      for (const child of file.childCases) {
        cases.push({
          name: child.case,
          subsys: file.block || '',
          path: file.fullPath,
          filePath: file.fullPath,
          base: file.base || undefined,
          block: file.block || undefined,
          baseCase: child.base,
        });
      }
    }
    return cases;
  }, [loadedFiles]);

  // Build tree from all cases
  const caseTree = useMemo(() => buildCaseTree(allCases), [allCases]);

  // Local search (no backend call needed — data is already in memory)
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const lower = trimmed.toLowerCase();
    const results = allCases.filter((c) =>
      c.name.toLowerCase().includes(lower) || c.subsys.toLowerCase().includes(lower),
    );
    setSearchResults(results);
    setSearching(false);
  }, [searchQuery, allCases]);

  const searchTree = useMemo(() => buildCaseTree(searchResults), [searchResults]);
  const searchExpandedFiles = useMemo(() => {
    const paths = new Set<string>();
    for (const node of searchTree) {
      if (node.type === 'file') paths.add(node.path);
    }
    return paths;
  }, [searchTree]);

  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleCase = useCallback((id: string) => {
    setExpandedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCaseSelection = useCallback((id: string) => {
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** 展开全部：所有文件节点 + 所有含子用例的根用例 */
  const expandAllNodes = useCallback(() => {
    const files = new Set<string>();
    const cases = new Set<string>();
    const walk = (nodes: CaseTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === 'file') files.add(node.path);
        if (node.type === 'case' && node.children.length > 0) {
          cases.add(node.caseData ? getCaseId(node.caseData) : node.name);
        }
        walk(node.children);
      }
    };
    walk(caseTree);
    setExpandedFiles(files);
    setExpandedCases(cases);
  }, [caseTree]);

  /** 折叠全部：清空文件与用例的展开集合（保留根用例折叠为文件行） */
  const collapseAllNodes = useCallback(() => {
    setExpandedFiles(new Set());
    setExpandedCases(new Set());
  }, []);

  /** 批量运行选中用例（与 CaseTreePanel.handleBatchRun 同语义） */
  const handleBatchRun = useCallback(async () => {
    if (!currentProjectId || selectedCases.size === 0) return;
    const selected = allCases.filter((c) => selectedCases.has(getCaseId(c)));
    await startCaseRuns(currentProjectId, selected);
    setSelectedCases(new Set());
    setBatchMode(false);
  }, [currentProjectId, selectedCases, allCases, startCaseRuns]);

  const handleCaseSelect = (caseData: CaseData) => {
    const caseId = getCaseId(caseData);
    setSelectedCaseId(caseId);
    selectCase(caseData);
  };

  const handleRunCase = async (caseData: CaseData) => {
    if (!currentProjectId) return;
    selectCase(caseData);
    const { startCaseRun } = useSimulationStore.getState();
    await startCaseRun(currentProjectId, caseData);
  };

  const handleCaseContextMenu = (e: React.MouseEvent, caseData: CaseData) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, caseData, fileNode: null });
  };

  const handleTogglePostSim = async (caseData: CaseData) => {
    if (!currentProjectId) return;
    setContextMenu((s) => ({ ...s, visible: false }));
    try {
      await trpc.project.setCasePostSim.mutate({
        projectId: currentProjectId,
        caseName: caseData.name,
        subsys: caseData.subsys,
        postSim: !caseData.postSim,
      });
      // Refresh loaded files to get updated postSim state
      await loadFiles();
      useToastStore.getState().success(caseData.postSim ? '已取消后仿标记' : '已标记需要后仿');
    } catch (err) {
      useToastStore.getState().error('后仿标记更新失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyCasePath = async (caseData: CaseData) => {
    setContextMenu((s) => ({ ...s, visible: false }));
    try {
      await navigator.clipboard.writeText(caseData.filePath ?? caseData.path);
      useToastStore.getState().success('已复制路径');
    } catch {
      useToastStore.getState().error('复制失败', '无法访问剪贴板');
    }
  };

  const handleFileContextMenu = (e: React.MouseEvent, fileNode: CaseTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, caseData: null, fileNode });
  };

  const handleParseEnv = async () => {
    if (!currentProjectId || !projEnv) {
      useToastStore.getState().warning('缺少环境', '请先设置 $PROJ_ENV 环境变量');
      return;
    }
    setScanning(true);
    try {
      const subsysList = await trpc.caseCfg.scanEnv.query({
        projectId: currentProjectId,
        projEnv,
      });
      setSubsystems(subsysList as SubsysInfo[]);
      setSelectedSubsystems(new Set());
      setShowSubsysDialog(true);
    } catch (err) {
      useToastStore.getState().error(
        '扫描失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setScanning(false);
    }
  };

  /**
   * 子系统选择弹窗「下一步」按钮：
   * 关闭一级弹窗，开始逐个处理选中子系统的 UDTB 目录扫描。
   */
  const handleSubsysNext = async () => {
    if (!currentProjectId || !projEnv || selectedSubsystems.size === 0) return;
    setShowSubsysDialog(false);

    const subsysList = Array.from(selectedSubsystems);
    // Start UDTB dialog flow from first subsystem
    await startUdtbFlow(subsysList[0], subsysList.slice(1), []);
  };

  /**
   * 开始处理某个子系统的 UDTB 目录扫描。
   * 调用 scanUdtbDirs 获取子目录列表，如果为空则跳过该子系统。
   */
  const startUdtbFlow = async (
    subsys: string,
    remaining: string[],
    collected: string[],
  ) => {
    if (!currentProjectId || !projEnv) return;
    setUdtbDialog({
      visible: true,
      currentSubsys: subsys,
      remainingSubsystems: remaining,
      dirs: [],
      selectedDirs: new Set(),
      collectedDirs: collected,
      scanning: true,
    });
    try {
      const udtbDirs = await trpc.caseCfg.scanUdtbDirs.query({
        projectId: currentProjectId,
        projEnv,
        subsys,
      });
      if (udtbDirs.length === 0) {
        // No UDTB dirs for this subsystem, move to next or finish
        await proceedToNextUdtbOrLoad(subsys, remaining, collected, []);
      } else {
        setUdtbDialog((s) => ({
          ...s,
          dirs: udtbDirs as UdtbDirInfo[],
          scanning: false,
        }));
      }
    } catch (err) {
      useToastStore.getState().error(
        'UDTB 扫描失败',
        err instanceof Error ? err.message : String(err),
      );
      // Skip this subsystem on error
      await proceedToNextUdtbOrLoad(subsys, remaining, collected, []);
    }
  };

  /**
   * UDTB 弹窗「确定」按钮：收集当前选中目录，处理下一个子系统或完成加载。
   */
  const handleUdtbConfirm = async () => {
    const { currentSubsys, remainingSubsystems, collectedDirs, selectedDirs } =
      udtbDialog;
    const newlyCollected = Array.from(selectedDirs);
    await proceedToNextUdtbOrLoad(
      currentSubsys,
      remainingSubsystems,
      collectedDirs,
      newlyCollected,
    );
  };

  /**
   * UDTB 弹窗「跳过」按钮：不选任何 UDTB 目录，直接处理下一个。
   */
  const handleUdtbSkip = async () => {
    const { currentSubsys, remainingSubsystems, collectedDirs } = udtbDialog;
    await proceedToNextUdtbOrLoad(
      currentSubsys,
      remainingSubsystems,
      collectedDirs,
      [],
    );
  };

  /**
   * 处理下一个子系统的 UDTB 扫描，或当所有子系统处理完毕后执行最终加载。
   */
  const proceedToNextUdtbOrLoad = async (
    _currentSubsys: string,
    remaining: string[],
    collected: string[],
    newlyCollected: string[],
  ) => {
    const allCollected = [...collected, ...newlyCollected];

    if (remaining.length > 0) {
      // Process next subsystem
      const next = remaining[0];
      const rest = remaining.slice(1);
      await startUdtbFlow(next, rest, allCollected);
    } else {
      // All subsystems processed, call loadFromEnv
      setUdtbDialog((s) => ({ ...s, visible: false }));
      await loadFromEnvFinal(allCollected);
    }
  };

  /**
   * 最终加载：调用 loadFromEnv 传入子系统和 UDTB 目录。
   */
  const loadFromEnvFinal = async (udtbDirs: string[]) => {
    if (!currentProjectId || !projEnv || selectedSubsystems.size === 0) return;
    setLoading(true);
    try {
      const result = await trpc.caseCfg.loadFromEnv.mutate({
        projectId: currentProjectId,
        projEnv,
        subsystems: Array.from(selectedSubsystems),
        udtbDirs,
      });
      setLoadedFiles(result.files as CaseFileData[]);
      const paths = new Set<string>();
      for (const f of result.files) paths.add(f.fullPath);
      setExpandedFiles(paths);
      useToastStore.getState().success(
        `已加载 ${result.files.length} 个用例文件`,
      );
    } catch (err) {
      useToastStore.getState().error(
        '加载失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleLoadFiles = async () => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      // Use Electron dialog to pick files
      const result = await trpc.project.pickFiles.mutate({
        projectId: currentProjectId,
      });
      if ('canceled' in result && result.canceled) return;
      const filePaths = (result as { files: Array<{ path: string }> }).files.map(
        (f) => f.path,
      );
      if (filePaths.length === 0) return;

      const loadResult = await trpc.caseCfg.loadFiles.mutate({
        projectId: currentProjectId,
        filePaths,
      });
      setLoadedFiles(loadResult.files as CaseFileData[]);
      const paths = new Set<string>();
      for (const f of loadResult.files) paths.add(f.fullPath);
      setExpandedFiles(paths);
      useToastStore.getState().success(`已加载 ${filePaths.length} 个文件`);
    } catch (err) {
      useToastStore.getState().error(
        '加载失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveFile = async (filePath: string) => {
    if (!currentProjectId) return;
    setContextMenu((s) => ({ ...s, visible: false }));
    try {
      const result = await trpc.caseCfg.removeFile.mutate({
        projectId: currentProjectId,
        filePath,
      });
      setLoadedFiles(result.files as CaseFileData[]);
      useToastStore.getState().success('已删除用例文件');
    } catch (err) {
      useToastStore.getState().error(
        '删除失败',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const handleRefresh = async () => {
    if (!currentProjectId) return;
    setContextMenu((s) => ({ ...s, visible: false }));
    setRefreshing(true);
    try {
      const result = await trpc.caseCfg.refresh.mutate({
        projectId: currentProjectId,
      });
      setLoadedFiles(result.files as CaseFileData[]);
      const paths = new Set<string>();
      for (const f of result.files) paths.add(f.fullPath);
      setExpandedFiles(paths);
      useToastStore.getState().success('用例已刷新');
    } catch (err) {
      useToastStore.getState().error(
        '刷新失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const toggleSubsystem = (name: string) => {
    setSelectedSubsystems((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleUdtbDir = (fullPath: string) => {
    setUdtbDialog((prev) => {
      const next = new Set(prev.selectedDirs);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return { ...prev, selectedDirs: next };
    });
  };

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div
      className="flex h-full flex-col"
      data-testid="case-cfg-panel"
      ref={containerRef}
    >
      {/* ── Header: title + buttons ─────────────────────── */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-foreground">自定义用例</span>
        <div className="flex items-center gap-0.5">
          {loadedFiles.length > 0 && (
            <>
              <button
                onClick={expandAllNodes}
                title="展开全部"
                disabled={batchMode}
                className={cn(
                  'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  batchMode && 'cursor-not-allowed opacity-50',
                )}
              >
                <ChevronsUpDown className="h-3 w-3" />
              </button>
              <button
                onClick={collapseAllNodes}
                title="折叠全部"
                disabled={batchMode}
                className={cn(
                  'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  batchMode && 'cursor-not-allowed opacity-50',
                )}
              >
                <ChevronsDownUp className="h-3 w-3" />
              </button>
              <button
                onClick={() => void handleRefresh()}
                disabled={refreshing || loading}
                className={cn(
                  'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  (refreshing || loading) && 'cursor-not-allowed opacity-50',
                )}
                title="刷新全部自定义用例"
              >
                <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
              </button>
            </>
          )}
          <button
            onClick={() => {
              setBatchMode(!batchMode);
              setSelectedCases(new Set());
            }}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] transition-colors',
              batchMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent',
            )}
            title="批量选择模式"
          >
            批量
          </button>
          <button
            onClick={() => void handleParseEnv()}
            disabled={scanning || !projEnv}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
              'text-primary hover:bg-primary/10',
              (scanning || !projEnv) && 'cursor-not-allowed opacity-50',
            )}
            title="扫描 $PROJ_ENV 下的子系统并加载用例"
            data-testid="case-cfg-parse-env"
          >
            {scanning ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <FolderOpen className="h-2.5 w-2.5" />
            )}
            解析环境
          </button>
          <button
            onClick={() => void handleLoadFiles()}
            disabled={loading}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
              'text-primary hover:bg-primary/10',
              loading && 'cursor-not-allowed opacity-50',
            )}
            title="选择用例文件加载"
            data-testid="case-cfg-load-files"
          >
            <FileText className="h-2.5 w-2.5" />
            加载用例
          </button>
        </div>
      </div>

      {/* ── Search input ──────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索用例..."
            className="w-full rounded border border-border/50 bg-background/60 py-1 pl-7 pr-6 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
          {!searching && searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="清除搜索"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* ── Batch action bar ─────────────────────────── */}
      {batchMode && selectedCases.size > 0 && (
        <div className="mx-2 mb-1 flex items-center gap-1 rounded border border-border/50 bg-secondary/30 px-2 py-1">
          <span className="text-[10px] text-muted-foreground">已选 {selectedCases.size} 个</span>
          <button
            onClick={() => void handleBatchRun()}
            className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/20"
          >
            <Play className="h-2.5 w-2.5" />
            运行
          </button>
          <button
            onClick={() => setSelectedCases(new Set())}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      )}

      {/* ── Scrollable content area ───────────────────── */}
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {loading ? (
          <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            正在加载...
          </div>
        ) : loadedFiles.length === 0 && !isSearching ? (
          <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            未加载用例文件
            <div className="mt-1 text-[10px]">点击"解析环境"或"加载用例"</div>
          </div>
        ) : isSearching ? (
          <div className="flex flex-col gap-0.5">
            {searchResults.length === 0 && !searching && (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                未找到匹配的用例
              </div>
            )}
            {searchTree.map((node, idx) => (
              <CaseTreeItem
                key={`${node.path}::${node.name}::${idx}`}
                node={node}
                level={0}
                expandedFiles={searchExpandedFiles}
                expandedCases={expandedCases}
                toggleFile={toggleFile}
                toggleCase={toggleCase}
                batchMode={batchMode}
                selectedCases={selectedCases}
                selectedCaseId={selectedCaseId}
                toggleCaseSelection={toggleCaseSelection}
                onCaseSelect={handleCaseSelect}
                onContextMenu={handleCaseContextMenu}
                onFileContextMenu={handleFileContextMenu}
                onRunCase={handleRunCase}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {caseTree.map((node, idx) => (
              <CaseTreeItem
                key={`${node.path}::${node.name}::${idx}`}
                node={node}
                level={0}
                expandedFiles={expandedFiles}
                expandedCases={expandedCases}
                toggleFile={toggleFile}
                toggleCase={toggleCase}
                batchMode={batchMode}
                selectedCases={selectedCases}
                selectedCaseId={selectedCaseId}
                toggleCaseSelection={toggleCaseSelection}
                onCaseSelect={handleCaseSelect}
                onContextMenu={handleCaseContextMenu}
                onFileContextMenu={handleFileContextMenu}
                onRunCase={handleRunCase}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Subsystem selection dialog (一级弹窗) ─────────── */}
      {showSubsysDialog && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40"
          onClick={() => setShowSubsysDialog(false)}
        >
          <div
                       className="w-96 max-h-80 overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-medium text-foreground">选择子系统</span>
              <button
                onClick={() => setShowSubsysDialog(false)}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto py-1">
              {subsystems.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground">未发现子系统</div>
              ) : (
                subsystems.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => toggleSubsystem(s.name)}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1 text-[11px] transition-colors hover:bg-accent',
                      selectedSubsystems.has(s.name) && 'bg-primary/15 text-primary',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSubsystems.has(s.name)}
                      readOnly
                      className="h-2.5 w-2.5"
                    />
                    <span className="truncate">{s.name}</span>
                  </button>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border px-3 py-2">
              <span className="text-[10px] text-muted-foreground">
                {selectedSubsystems.size > 0
                  ? `已选 ${selectedSubsystems.size} 个`
                  : '未选择'}
              </span>
              <button
                onClick={() => void handleSubsysNext()}
                disabled={selectedSubsystems.size === 0}
                className={cn(
                  'rounded px-2 py-1 text-[10px] font-medium text-primary-foreground transition-colors',
                  selectedSubsystems.size === 0
                    ? 'cursor-not-allowed bg-muted'
                    : 'bg-primary hover:opacity-90',
                )}
              >
                下一步
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── UDTB directory selection dialog (二级弹窗) ──── */}
      {udtbDialog.visible && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40"
        >
          <div
            className="w-96 max-h-96 overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <div className="flex flex-col">
                <span className="text-xs font-medium text-foreground">
                  选择 UDTB 目录
                </span>
                <span className="text-[10px] text-muted-foreground">
                  子系统: {udtbDialog.currentSubsys}
                </span>
              </div>
              <button
                onClick={() => void handleUdtbSkip()}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {udtbDialog.scanning ? (
              <div className="flex items-center gap-1.5 px-3 py-3 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                扫描 UDTB 目录...
              </div>
            ) : (
              <>
                <div className="max-h-56 overflow-y-auto py-1">
                  {udtbDialog.dirs.length === 0 ? (
                    <div className="px-3 py-2 text-[11px] text-muted-foreground">
                      未发现 UDTB 目录
                    </div>
                  ) : (
                    udtbDialog.dirs.map((d) => (
                      <button
                        key={d.fullPath}
                        onClick={() => toggleUdtbDir(d.fullPath)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1 text-[11px] transition-colors hover:bg-accent',
                          udtbDialog.selectedDirs.has(d.fullPath) &&
                            'bg-primary/15 text-primary',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={udtbDialog.selectedDirs.has(d.fullPath)}
                          readOnly
                          className="h-2.5 w-2.5"
                        />
                        <span className="truncate" title={d.fullPath}>
                          {d.relPath}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between border-t border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {udtbDialog.selectedDirs.size > 0
                        ? `已选 ${udtbDialog.selectedDirs.size} 个`
                        : '未选择'}
                    </span>
                    {udtbDialog.remainingSubsystems.length > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        剩余 {udtbDialog.remainingSubsystems.length} 个子系统
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void handleUdtbSkip()}
                      className="rounded px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent"
                    >
                      跳过
                    </button>
                    <button
                      onClick={() => void handleUdtbConfirm()}
                      disabled={udtbDialog.selectedDirs.size === 0}
                      className={cn(
                        'rounded px-2 py-1 text-[10px] font-medium text-primary-foreground transition-colors',
                        udtbDialog.selectedDirs.size === 0
                          ? 'cursor-not-allowed bg-muted'
                          : 'bg-primary hover:opacity-90',
                      )}
                    >
                      确定
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Context menu — case node */}
      {contextMenu.visible &&
        contextMenu.caseData &&
        createPortal(
          <div
            className="fixed z-[9999] min-w-40 overflow-hidden rounded-md border border-border bg-popover shadow-xl"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                void handleRunCase(contextMenu.caseData!);
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent"
            >
              <Play className="h-3 w-3 text-primary" />
              运行仿真
            </button>
            <div className="border-t border-border/50" />
            <button
              onClick={() => void handleTogglePostSim(contextMenu.caseData!)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent"
            >
              <Zap className="h-3 w-3 text-amber-500" />
              {contextMenu.caseData.postSim ? '取消后仿标记' : '标记需要后仿'}
            </button>
            <div className="border-t border-border/50" />
            <button
              onClick={() => void handleCopyCasePath(contextMenu.caseData!)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <Copy className="h-3 w-3 text-muted-foreground" />
              <span>复制路径</span>
            </button>
          </div>,
          document.body,
        )}

      {/* Context menu — file node */}
      {contextMenu.visible &&
        contextMenu.fileNode &&
        createPortal(
          <div
            className="fixed z-[9999] min-w-44 overflow-hidden rounded-md border border-border bg-popover shadow-xl"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => {
                const fp = contextMenu.fileNode!.path;
                setExpandedFiles((prev) => {
                  const next = new Set(prev);
                  if (next.has(fp)) next.delete(fp);
                  else next.add(fp);
                  return next;
                });
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              {contextMenu.fileNode && expandedFiles.has(contextMenu.fileNode.path) ? (
                <ChevronsDownUp className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
              )}
              <span>
                {contextMenu.fileNode && expandedFiles.has(contextMenu.fileNode.path)
                  ? '折叠'
                  : '展开'}
              </span>
            </button>
            <button
              onClick={() => {
                expandAllNodes();
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
              <span>展开全部</span>
            </button>
            <button
              onClick={() => {
                collapseAllNodes();
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <ChevronsDownUp className="h-3 w-3 text-muted-foreground" />
              <span>折叠全部</span>
            </button>
            <div className="border-t border-border/50" />
            <button
              onClick={handleRefresh}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className={cn('h-3 w-3 text-muted-foreground', refreshing && 'animate-spin')} />
              <span>刷新</span>
            </button>
            <div className="border-t border-border/50" />
            <button
              onClick={() => void handleRemoveFile(contextMenu.fileNode!.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-accent"
            >
              <Trash2 className="h-3 w-3" />
              <span>删除用例</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
