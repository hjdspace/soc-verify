/**
 * 仿真视图左侧用例树面板（Issue #2 / #5）。
 *
 * 复用共享的 buildCaseTree / CaseTreeItem，内嵌子系统列表（展开/折叠 +
 * 用例计数）、用例树（文件分组 + baseCase 层级 + 状态点 + 后仿标记）、
 * 状态筛选器（全部/通过/失败/运行中/待运行/后仿）、搜索框（防抖 + 全局跨
 * 子系统）、批量模式（勾选用例 + 一键运行）、右键菜单（运行仿真/标记后仿）、
 * 刷新（全局 + 单子系统）。用例选中时调用 simulation.selectCase() 联动
 * Option 面板填充 base/block/case。用例树行内运行按钮直接启动仿真。
 * 面板宽度由 simLeftPanelWidth 控制，内容区域可滚动。
 *
 * 与 SubsysList 的差异：去掉搜索范围下拉、全局刷新改为顶部按钮，
 * 不使用外层 Drawer padding。
 */

import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  ChevronDown,
  Cpu,
  X,
  RefreshCw,
  Copy,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderOpen,
  Search,
  Loader2,
  Zap,
  Play,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';
import { useOverviewStore } from '@renderer/stores/overview';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useEnvStore } from '@renderer/stores/env';
import { useToastStore } from '@renderer/stores/toast';
import { useDashboardStore } from '@renderer/stores/dashboard';
import {
  buildCaseTree,
  CaseTreeItem,
  getCaseId,
  type CaseData,
  type CaseTreeNode,
} from '@renderer/components/project/case-tree-utils';

interface SubsysData {
  name: string;
  path: string;
  caseCount?: number;
  description?: string;
}

const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'pending', label: '待运行' },
  { value: 'postSim', label: '后仿' },
];

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  caseData: CaseData | null;
  fileNode: CaseTreeNode | null;
}

export function CaseTreePanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const setSelectedSubsys = useProjectStore((s) => s.setSelectedSubsys);
  const caseStatusFilter = useProjectStore((s) => s.caseStatusFilter);
  const setCaseStatusFilter = useProjectStore((s) => s.setCaseStatusFilter);
  const plugins = useProjectStore((s) => s.plugins);
  const startCaseRun = useSimulationStore((s) => s.startCaseRun);
  const startCaseRuns = useSimulationStore((s) => s.startCaseRuns);
  const selectCase = useSimulationStore((s) => s.selectCase);
  const configuredProjRtl = useEnvStore((s) => s.config?.envVars.PROJ_RTL);

  const [subsystems, setSubsystems] = useState<SubsysData[]>([]);
  const [loadingSubsystems, setLoadingSubsystems] = useState(false);
  const [subsystemError, setSubsystemError] = useState<string | null>(null);
  const [scanVersion, setScanVersion] = useState(0);
  const [expandedSubsys, setExpandedSubsys] = useState<Set<string>>(new Set());
  const [casesBySubsys, setCasesBySubsys] = useState<Map<string, CaseData[]>>(new Map());
  const [loadingSubsysCases, setLoadingSubsysCases] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    caseData: null,
    fileNode: null,
  });
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingSubsys, setRefreshingSubsys] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Search state ────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CaseData[]>([]);
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load subsystems
  useEffect(() => {
    if (!currentProjectId) {
      setSubsystems([]);
      setLoadingSubsystems(false);
      setSubsystemError(null);
      return;
    }
    let cancelled = false;
    setLoadingSubsystems(true);
    setSubsystemError(null);
    trpc.project.getSubsystems
      .query({ projectId: currentProjectId })
      .then((data: SubsysData[]) => {
        if (!cancelled) setSubsystems(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSubsystems([]);
          setSubsystemError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSubsystems(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, configuredProjRtl, scanVersion]);

  // Clear cases and expanded state when project changes
  useEffect(() => {
    setExpandedSubsys(new Set());
    setCasesBySubsys(new Map());
    setExpandedFiles(new Set());
    setExpandedCases(new Set());
  }, [currentProjectId]);

  const loadSubsysCases = useCallback(
    async (subsysName: string, statusOverride?: string) => {
      if (!currentProjectId) return;
      const effectiveStatus = statusOverride ?? caseStatusFilter;
      setLoadingSubsysCases((prev) => {
        const next = new Set(prev);
        next.add(subsysName);
        return next;
      });
      try {
        const data = await trpc.project.getCases.query({
          projectId: currentProjectId,
          subsys: subsysName,
          postSim: effectiveStatus === 'postSim' ? true : undefined,
          status:
            effectiveStatus === 'all' || effectiveStatus === 'postSim'
              ? undefined
              : effectiveStatus,
        });
        const cases = data as CaseData[];
        setCasesBySubsys((prev) => {
          const next = new Map(prev);
          next.set(subsysName, cases);
          return next;
        });
        // 自动展开新加载的文件节点，让用例直接可见
        const filePaths = new Set<string>();
        for (const c of cases) {
          const fp = c.filePath ?? c.path;
          if (fp) filePaths.add(fp);
        }
        if (filePaths.size > 0) {
          setExpandedFiles((prev) => {
            const next = new Set(prev);
            for (const fp of filePaths) next.add(fp);
            return next;
          });
        }
      } catch {
        setCasesBySubsys((prev) => {
          const next = new Map(prev);
          next.set(subsysName, []);
          return next;
        });
      } finally {
        setLoadingSubsysCases((prev) => {
          const next = new Set(prev);
          next.delete(subsysName);
          return next;
        });
      }
    },
    [currentProjectId, caseStatusFilter],
  );

  // ── Search: debounced query (global, cross-subsystem) ──
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    if (!currentProjectId) return;

    setSearching(true);
    const timer = setTimeout(() => {
      trpc.project.searchCases
        .query({
          projectId: currentProjectId,
          query: trimmed,
          limit: 200,
        })
        .then((data: CaseData[]) => {
          setSearchResults(data);
        })
        .catch(() => {
          setSearchResults([]);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, currentProjectId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handler = () => setContextMenu((s) => ({ ...s, visible: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu.visible]);

  const toggleSubsys = (name: string) => {
    setExpandedSubsys((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
        void loadSubsysCases(name);
      }
      return next;
    });
    setSelectedSubsys(name);
  };

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

  const handleCaseContextMenu = (e: React.MouseEvent, caseData: CaseData) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, caseData, fileNode: null });
  };

  const handleFileContextMenu = (e: React.MouseEvent, fileNode: CaseTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, caseData: null, fileNode });
  };

  const handleOpenCaseFile = async () => {
    const fileNode = contextMenu.fileNode;
    if (!fileNode) return;
    try {
      await trpc.project.openInSystem.mutate({ path: fileNode.path, type: 'file' });
    } catch (err) {
      useToastStore.getState().error('打开文件失败', err instanceof Error ? err.message : String(err));
    }
    setContextMenu((s) => ({ ...s, visible: false }));
  };

  const handleCopyCaseFilePath = async () => {
    const fileNode = contextMenu.fileNode;
    if (!fileNode) return;
    try {
      await navigator.clipboard.writeText(fileNode.path);
      useToastStore.getState().success('已复制路径');
    } catch {
      useToastStore.getState().error('复制失败', '无法访问剪贴板');
    }
    setContextMenu((s) => ({ ...s, visible: false }));
  };

  const handleCaseSelect = (caseData: CaseData) => {
    const caseId = getCaseId(caseData);
    setSelectedCaseId(caseId);
    selectCase(caseData);
  };

  const handleRunCase = async (caseData: CaseData) => {
    if (!currentProjectId) return;
    await startCaseRun(currentProjectId, caseData);
  };

  const handleTogglePostSim = async (caseData: CaseData) => {
    if (!currentProjectId) return;
    try {
      await trpc.project.setCasePostSim.mutate({
        projectId: currentProjectId,
        caseName: caseData.name,
        subsys: caseData.subsys,
        postSim: !caseData.postSim,
      });
      await loadSubsysCases(caseData.subsys);
      useDashboardStore.getState().loadMilestones(currentProjectId);
      useToastStore.getState().success(caseData.postSim ? '已取消后仿标记' : '已标记需要后仿');
    } catch (err) {
      useToastStore.getState().error('后仿标记更新失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleBatchRun = async () => {
    if (!currentProjectId || selectedCases.size === 0) return;
    const allCases: CaseData[] = [];
    for (const subsysCases of casesBySubsys.values()) {
      allCases.push(...subsysCases);
    }
    const selected = Array.from(selectedCases)
      .map((casePath) => allCases.find((candidate) => getCaseId(candidate) === casePath))
      .filter((candidate): candidate is CaseData => !!candidate);
    await startCaseRuns(currentProjectId, selected);
    setSelectedCases(new Set());
    setBatchMode(false);
  };

  const handleRefresh = async () => {
    if (!currentProjectId || refreshing) return;
    setRefreshing(true);
    try {
      await trpc.project.refreshCases.mutate({ projectId: currentProjectId });
      setCasesBySubsys(new Map());
      setScanVersion((version) => version + 1);
      useOverviewStore.getState().invalidate();
      useToastStore.getState().success('用例树已刷新');
      for (const subsys of expandedSubsys) {
        void loadSubsysCases(subsys);
      }
    } catch (err) {
      useToastStore.getState().error('刷新失败', err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const handleSubsysRefresh = async (subsysName: string) => {
    if (!currentProjectId || refreshingSubsys) return;
    setRefreshingSubsys(subsysName);
    try {
      await trpc.project.refreshCases.mutate({ projectId: currentProjectId, subsys: subsysName });
      useOverviewStore.getState().invalidate();
      if (expandedSubsys.has(subsysName)) {
        await loadSubsysCases(subsysName);
      }
      useToastStore.getState().success(`子系统 ${subsysName} 已刷新`);
    } catch (err) {
      useToastStore.getState().error('刷新失败', err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingSubsys(null);
    }
  };

  const toggleCaseSelection = (path: string) => {
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const caseTreeBySubsys = useMemo(() => {
    const trees = new Map<string, CaseTreeNode[]>();
    for (const [subsys, subsysCases] of casesBySubsys) {
      trees.set(subsys, buildCaseTree(subsysCases));
    }
    return trees;
  }, [casesBySubsys]);

  const searchGrouped = useMemo<
    Array<{ subsys: string; tree: CaseTreeNode[]; caseCount: number }>
  >(() => {
    if (searchResults.length === 0) return [];
    const bySubsys = new Map<string, CaseData[]>();
    for (const c of searchResults) {
      if (!bySubsys.has(c.subsys)) bySubsys.set(c.subsys, []);
      bySubsys.get(c.subsys)!.push(c);
    }
    const groups: Array<{ subsys: string; tree: CaseTreeNode[]; caseCount: number }> = [];
    for (const [subsys, subsysCases] of bySubsys) {
      groups.push({ subsys, tree: buildCaseTree(subsysCases), caseCount: subsysCases.length });
    }
    return groups;
  }, [searchResults]);

  const searchExpandedFiles = useMemo(() => {
    const paths = new Set<string>();
    for (const { tree } of searchGrouped) {
      for (const node of tree) {
        if (node.type === 'file') paths.add(node.path);
      }
    }
    return paths;
  }, [searchGrouped]);

  const [searchCollapsedFiles, setSearchCollapsedFiles] = useState<Set<string>>(new Set());
  const [searchCollapsedSubsys, setSearchCollapsedSubsys] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSearchCollapsedFiles(new Set());
    setSearchCollapsedSubsys(new Set());
  }, [searchQuery]);

  const searchEffectiveExpandedFiles = useMemo(() => {
    if (searchCollapsedFiles.size === 0) return searchExpandedFiles;
    const result = new Set<string>();
    for (const path of searchExpandedFiles) {
      if (!searchCollapsedFiles.has(path)) result.add(path);
    }
    return result;
  }, [searchExpandedFiles, searchCollapsedFiles]);

  const toggleSearchFile = useCallback((path: string) => {
    setSearchCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleSearchSubsys = useCallback((subsys: string) => {
    setSearchCollapsedSubsys((prev) => {
      const next = new Set(prev);
      if (next.has(subsys)) next.delete(subsys);
      else next.add(subsys);
      return next;
    });
  }, []);

  const expandAllFiles = useCallback(() => {
    const allPaths = new Set<string>();
    for (const tree of caseTreeBySubsys.values()) {
      tree.forEach((node) => {
        if (node.type === 'file') allPaths.add(node.path);
      });
    }
    setExpandedFiles(allPaths);
  }, [caseTreeBySubsys]);

  const collapseAllFiles = useCallback(() => {
    setExpandedFiles(new Set());
  }, []);

  const subsystemPlugins = plugins.filter((plugin) => plugin.kind === 'subsys-discoverer');
  const pluginError = subsystemPlugins.find((plugin) => plugin.error)?.error;
  const hasDiscoverer = subsystemPlugins.some((plugin) => plugin.enabled && !plugin.error);

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div
      className="flex h-full flex-col"
      data-testid="case-tree-panel"
      ref={containerRef}
    >
      {/* ── Header: title + refresh + batch ─────────────── */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-foreground">用例树</span>
        <div className="flex items-center gap-0.5">
          {caseTreeBySubsys.size > 0 && !isSearching && (
            <>
              <button
                onClick={expandAllFiles}
                title="展开全部"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronsUpDown className="h-3 w-3" />
              </button>
              <button
                onClick={collapseAllFiles}
                title="折叠全部"
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ChevronsDownUp className="h-3 w-3" />
              </button>
            </>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={cn(
              'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              refreshing && 'cursor-not-allowed opacity-50',
            )}
            title="刷新全部用例树"
          >
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          </button>
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
        </div>
      </div>

      {/* ── Search input ─────────────────────────────── */}
      <div className="relative px-2 py-1.5">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索用例..."
          className="w-full rounded border border-border/50 bg-background/60 py-1 pl-7 pr-6 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        />
        {searching && (
          <Loader2 className="absolute right-4 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        {!searching && searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="清除搜索"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* ── Status filters (hidden in search mode) ─────── */}
      {!isSearching && (
        <div className="flex gap-0.5 px-2 pb-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => {
                setCaseStatusFilter(f.value);
                for (const subsys of expandedSubsys) {
                  void loadSubsysCases(subsys, f.value);
                }
              }}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                caseStatusFilter === f.value
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Batch action bar ──────────────────────────── */}
      {batchMode && selectedCases.size > 0 && (
        <div className="mx-2 mb-1 flex items-center gap-1 rounded border border-border/50 bg-secondary/30 px-2 py-1">
          <span className="text-[10px] text-muted-foreground">已选 {selectedCases.size} 个</span>
          <button
            onClick={handleBatchRun}
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
        {loadingSubsystems ? (
          <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            正在扫描子系统...
          </div>
        ) : subsystemError ? (
          <div className="px-2 py-2 text-xs">
            <div className="font-medium text-destructive">子系统查询失败</div>
            <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{subsystemError}</div>
            <button
              onClick={() => setScanVersion((v) => v + 1)}
              className="mt-2 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-primary transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-3 w-3" />
              重新扫描
            </button>
          </div>
        ) : subsystems.length === 0 && pluginError ? (
          <div className="px-2 py-2 text-xs">
            <div className="font-medium text-destructive">子系统插件加载失败</div>
            <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{pluginError}</div>
          </div>
        ) : subsystems.length === 0 && !hasDiscoverer ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">未加载子系统发现插件</div>
        ) : subsystems.length === 0 ? (
          <div className="px-2 py-2 text-xs">
            <div className="font-medium text-foreground">未发现子系统</div>
            <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              检查 PROJ_RTL 后重新扫描
            </div>
          </div>
        ) : isSearching ? (
          <div className="flex flex-col gap-0.5">
            {searchResults.length === 0 && !searching && (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                未找到匹配的用例
              </div>
            )}
            {searchResults.length === 0 && searching && (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                搜索中...
              </div>
            )}
            {searchResults.length > 0 && (
              <>
                <div className="mb-0.5 px-1 text-[10px] text-muted-foreground">
                  找到 {searchResults.length} 个用例
                </div>
                {searchGrouped.map(({ subsys, tree, caseCount }) => {
                  const subsysCollapsed = searchCollapsedSubsys.has(subsys);
                  return (
                    <div key={subsys}>
                      <button
                        onClick={() => toggleSearchSubsys(subsys)}
                        className="flex w-full items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-accent/50"
                      >
                        {subsysCollapsed ? (
                          <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                        ) : (
                          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                        )}
                        <Cpu className="h-3 w-3 shrink-0 text-primary/70" />
                        <span className="truncate font-medium text-xs">{subsys}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{caseCount}</span>
                      </button>
                      {!subsysCollapsed &&
                        tree.map((node) => (
                          <CaseTreeItem
                            key={node.path || node.name}
                            node={node}
                            level={0}
                            expandedFiles={searchEffectiveExpandedFiles}
                            expandedCases={expandedCases}
                            toggleFile={toggleSearchFile}
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
                  );
                })}
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {subsystems.map((subsys) => {
              const isExpanded = expandedSubsys.has(subsys.name);
              const subsysCases = casesBySubsys.get(subsys.name);
              const subsysTree = caseTreeBySubsys.get(subsys.name) ?? [];
              const isLoading = loadingSubsysCases.has(subsys.name);
              return (
                <div key={subsys.name}>
                  <div className="flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent">
                    <button
                      onClick={() => toggleSubsys(subsys.name)}
                      className="flex flex-1 items-center gap-1 text-left text-xs transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                      ) : (
                        <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                      )}
                      <Cpu className="h-3 w-3 shrink-0 text-primary/70" />
                      <span className="truncate font-medium">{subsys.name}</span>
                      {subsys.caseCount !== undefined && subsys.caseCount > 0 && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {subsys.caseCount}
                        </span>
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleSubsysRefresh(subsys.name);
                      }}
                      disabled={refreshingSubsys === subsys.name}
                      className={cn(
                        'shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground',
                        refreshingSubsys === subsys.name && 'cursor-not-allowed opacity-50',
                      )}
                      title={`刷新 ${subsys.name} 用例`}
                    >
                      <RefreshCw
                        className={cn(
                          'h-2.5 w-2.5',
                          refreshingSubsys === subsys.name && 'animate-spin',
                        )}
                      />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="pb-1">
                      {isLoading && !subsysCases ? (
                        <div className="px-4 py-1 text-[10px] text-muted-foreground">加载中...</div>
                      ) : subsysTree.length === 0 ? (
                        <div className="px-4 py-1 text-[10px] text-muted-foreground">无用例</div>
                      ) : (
                        <div>
                          {subsysTree.map((node) => (
                            <CaseTreeItem
                              key={node.path || node.name}
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
              onClick={() => {
                void handleTogglePostSim(contextMenu.caseData!);
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              data-testid="case-tree-menu-toggle-postsim"
            >
              <Zap className="h-3 w-3 text-amber-500" />
              {contextMenu.caseData.postSim ? '取消后仿标记' : '标记需要后仿'}
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
              onClick={handleOpenCaseFile}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <FolderOpen className="h-3 w-3 text-muted-foreground" />
              <span>打开用例文件</span>
            </button>
            <button
              onClick={handleCopyCaseFilePath}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <Copy className="h-3 w-3 text-muted-foreground" />
              <span>复制路径</span>
            </button>
            <div className="border-t border-border/50" />
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
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              )}
              <span>
                {contextMenu.fileNode && expandedFiles.has(contextMenu.fileNode.path)
                  ? '折叠'
                  : '展开'}
              </span>
            </button>
            <button
              onClick={() => {
                expandAllFiles();
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />
              <span>展开全部</span>
            </button>
            <button
              onClick={() => {
                collapseAllFiles();
                setContextMenu((s) => ({ ...s, visible: false }));
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
            >
              <ChevronsDownUp className="h-3 w-3 text-muted-foreground" />
              <span>折叠全部</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
