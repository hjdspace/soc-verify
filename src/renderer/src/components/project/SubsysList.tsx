import { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown, Cpu, CircleDot, Play, X, RefreshCw, Settings, FileText } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useEnvStore } from '@renderer/stores/env';

interface SubsysData {
  name: string;
  path: string;
  caseCount?: number;
  description?: string;
}

interface CaseData {
  id?: string;
  name: string;
  subsys: string;
  path: string;
  status?: string;
  duration?: number;
  description?: string;
  baseCase?: string;
  filePath?: string;
  base?: string;
  block?: string;
}

const STATUS_COLORS: Record<string, string> = {
  pass: 'text-status-pass-foreground',
  fail: 'text-status-fail-foreground',
  running: 'text-status-running-foreground animate-pulse',
  pending: 'text-status-pending-foreground',
  error: 'text-status-fail-foreground',
  aborted: 'text-status-aborted-foreground',
};

const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'pending', label: '待运行' },
];

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  caseData: CaseData | null;
}

// ─── Case ID helpers ────────────────────────────────────

/**
 * 生成用例的唯一标识符。
 *
 * `path` 在同一 file group 下可能不唯一（多个 case 共享同一文件路径），
 * 因此用 `path + name` 组合确保唯一性；如果 `id` 存在则优先使用。
 */
function getCaseId(caseData: CaseData): string {
  return caseData.id ?? `${caseData.path}::${caseData.name}`;
}

// ─── Case Tree Types ─────────────────────────────────────

interface CaseTreeNode {
  type: 'file' | 'case';
  name: string;
  path: string;
  caseData?: CaseData;
  children: CaseTreeNode[];
}

/**
 * 从扁平用例列表构建用例树。
 *
 * 树结构：
 *   文件节点（按 filePath 分组）
 *     ├─ 根用例（无 baseCase）
 *     │   ├─ 子用例（baseCase 指向根用例）
 *     │   └─ ...
 *     └─ ...
 *
 * 如果用例没有 filePath 信息，回退为扁平结构（每个用例直接作为根节点）。
 */
function buildCaseTree(cases: CaseData[]): CaseTreeNode[] {
  // 检查是否有树结构信息
  const hasTreeInfo = cases.some((c) => c.filePath);

  if (!hasTreeInfo) {
    // 无树信息，回退为扁平列表
    return cases.map((c) => ({
      type: 'case' as const,
      name: c.name,
      path: c.path,
      caseData: c,
      children: [],
    }));
  }

  // 按 filePath 分组
  const fileGroups = new Map<string, CaseData[]>();
  for (const c of cases) {
    const fp = c.filePath ?? c.path;
    if (!fileGroups.has(fp)) {
      fileGroups.set(fp, []);
    }
    fileGroups.get(fp)!.push(c);
  }

  const tree: CaseTreeNode[] = [];

  for (const [filePath, fileCases] of fileGroups) {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const fileNode: CaseTreeNode = {
      type: 'file',
      name: fileName,
      path: filePath,
      children: [],
    };

    // 用例名 → 树节点映射（用于查找父节点）
    const caseMap = new Map<string, CaseTreeNode>();

    // 第一遍：创建根用例（无 baseCase）
    for (const c of fileCases) {
      if (!c.baseCase) {
        const node: CaseTreeNode = {
          type: 'case',
          name: c.name,
          path: c.path,
          caseData: c,
          children: [],
        };
        caseMap.set(c.name, node);
        fileNode.children.push(node);
      }
    }

    // 第二遍：添加子用例
    for (const c of fileCases) {
      if (c.baseCase) {
        let parentNode = caseMap.get(c.baseCase);
        if (!parentNode) {
          // 父用例不存在，创建占位节点
          parentNode = {
            type: 'case',
            name: c.baseCase,
            path: '',
            caseData: { ...c, name: c.baseCase, baseCase: undefined },
            children: [],
          };
          caseMap.set(c.baseCase, parentNode);
          fileNode.children.push(parentNode);
        }
        const childNode: CaseTreeNode = {
          type: 'case',
          name: c.name,
          path: c.path,
          caseData: c,
          children: [],
        };
        caseMap.set(c.name, childNode);
        parentNode.children.push(childNode);
      }
    }

    tree.push(fileNode);
  }

  return tree;
}

// ─── Recursive Case Tree Item ────────────────────────────

interface CaseTreeItemProps {
  node: CaseTreeNode;
  level: number;
  expandedFiles: Set<string>;
  expandedCases: Set<string>;
  toggleFile: (path: string) => void;
  toggleCase: (id: string) => void;
  batchMode: boolean;
  selectedCases: Set<string>;
  selectedCaseId: string | null;
  toggleCaseSelection: (path: string) => void;
  onCaseSelect: (caseData: CaseData) => void;
  onContextMenu: (e: React.MouseEvent, caseData: CaseData) => void;
  onRunCase: (caseData: CaseData) => void;
}

function CaseTreeItem({
  node,
  level,
  expandedFiles,
  expandedCases,
  toggleFile,
  toggleCase,
  batchMode,
  selectedCases,
  selectedCaseId,
  toggleCaseSelection,
  onCaseSelect,
  onContextMenu,
  onRunCase,
}: CaseTreeItemProps) {
  const paddingLeft = level * 12 + 8;

  if (node.type === 'file') {
    const isExpanded = expandedFiles.has(node.path);
    return (
      <div>
        <button
          onClick={() => toggleFile(node.path)}
          className="flex w-full items-center gap-1 rounded py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50"
          style={{ paddingLeft: `${paddingLeft}px` }}
        >
          {isExpanded ? (
            <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-50" />
          ) : (
            <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-50" />
          )}
          <FileText className="h-2.5 w-2.5 shrink-0 opacity-40" />
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 text-[9px] opacity-50">{node.children.length}</span>
        </button>
        {isExpanded &&
          node.children.map((child) => (
            <CaseTreeItem
              key={child.caseData?.id || child.path || child.name}
              node={child}
              level={level + 1}
              expandedFiles={expandedFiles}
              expandedCases={expandedCases}
              toggleFile={toggleFile}
              toggleCase={toggleCase}
              batchMode={batchMode}
              selectedCases={selectedCases}
              selectedCaseId={selectedCaseId}
              toggleCaseSelection={toggleCaseSelection}
              onCaseSelect={onCaseSelect}
              onContextMenu={onContextMenu}
              onRunCase={onRunCase}
            />
          ))}
      </div>
    );
  }

  // Case node
  const caseId = node.caseData ? getCaseId(node.caseData) : node.name;
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedCases.has(caseId);
  const isSelected = batchMode && selectedCases.has(caseId);
  const isActiveCase = !batchMode && selectedCaseId === caseId;

  return (
    <div>
      <div
        className={cn(
          'group relative flex items-center gap-1 rounded py-0.5 text-xs transition-colors',
          isActiveCase
            ? 'bg-primary/15 text-primary'
            : isSelected
              ? 'bg-primary/20 text-foreground'
              : 'text-foreground/70 hover:bg-foreground/10',
          (batchMode || (!batchMode && node.caseData)) && 'cursor-pointer',
        )}
        style={{ paddingLeft: `${paddingLeft}px` }}
        onClick={() => {
          if (batchMode) {
            if (node.caseData) toggleCaseSelection(caseId);
          } else if (node.caseData) {
            onCaseSelect(node.caseData);
          }
        }}
        onContextMenu={(e) => !batchMode && node.caseData && onContextMenu(e, node.caseData)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleCase(caseId);
            }}
            className="shrink-0"
          >
            {isExpanded ? (
              <ChevronDown className="h-2.5 w-2.5 opacity-50" />
            ) : (
              <ChevronRight className="h-2.5 w-2.5 opacity-50" />
            )}
          </button>
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
        {batchMode && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleCaseSelection(caseId)}
            className="h-2.5 w-2.5 shrink-0"
          />
        )}
        <CircleDot
          className={cn('h-2.5 w-2.5 shrink-0', STATUS_COLORS[node.caseData?.status ?? 'pending'])}
        />
        <span className="truncate">{node.name}</span>
        {node.caseData?.baseCase && (
          <span
            className={cn(
              'shrink-0 text-[9px]',
              isActiveCase ? 'opacity-60' : 'opacity-40',
            )}
          >
            :{node.caseData.baseCase}
          </span>
        )}
        {!batchMode && node.caseData && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRunCase(node.caseData!);
            }}
            className="ml-auto shrink-0 rounded p-0.5 opacity-40 transition-opacity hover:bg-foreground/10 hover:opacity-100"
            title="运行仿真"
          >
            <Play className="h-3 w-3 text-primary" />
          </button>
        )}
        {isActiveCase && (
          <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l bg-primary" />
        )}
      </div>
      {hasChildren &&
        isExpanded &&
        node.children.map((child) => (
          <CaseTreeItem
            key={child.caseData?.id || child.path || child.name}
            node={child}
            level={level + 1}
            expandedFiles={expandedFiles}
            expandedCases={expandedCases}
            toggleFile={toggleFile}
            toggleCase={toggleCase}
            batchMode={batchMode}
            selectedCases={selectedCases}
            selectedCaseId={selectedCaseId}
            toggleCaseSelection={toggleCaseSelection}
            onCaseSelect={onCaseSelect}
            onContextMenu={onContextMenu}
            onRunCase={onRunCase}
          />
        ))}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────

export function SubsysList() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);
  const setSelectedSubsys = useProjectStore((s) => s.setSelectedSubsys);
  const caseStatusFilter = useProjectStore((s) => s.caseStatusFilter);
  const setCaseStatusFilter = useProjectStore((s) => s.setCaseStatusFilter);
  const plugins = useProjectStore((s) => s.plugins);
  const startCaseRun = useSimulationStore((s) => s.startCaseRun);
  const startCaseRuns = useSimulationStore((s) => s.startCaseRuns);
  const selectCase = useSimulationStore((s) => s.selectCase);
  const configuredProjRtl = useEnvStore((s) => s.config?.envVars.PROJ_RTL);
  const loadEnvConfig = useEnvStore((s) => s.loadConfig);
  const setWizardOpen = useEnvStore((s) => s.setWizardOpen);
  const setWizardStep = useEnvStore((s) => s.setWizardStep);

  const [subsystems, setSubsystems] = useState<SubsysData[]>([]);
  const [loadingSubsystems, setLoadingSubsystems] = useState(false);
  const [subsystemError, setSubsystemError] = useState<string | null>(null);
  const [scanVersion, setScanVersion] = useState(0);
  const [expandedSubsys, setExpandedSubsys] = useState<string | null>(null);
  const [cases, setCases] = useState<CaseData[]>([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    caseData: null,
  });
  const [selectedCases, setSelectedCases] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
      .then((data) => {
        if (!cancelled) setSubsystems(data as SubsysData[]);
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

  // Load cases when subsys is expanded
  useEffect(() => {
    if (!currentProjectId || !expandedSubsys) {
      setCases([]);
      return;
    }
    let cancelled = false;
    setLoadingCases(true);
    trpc.project.getCases
      .query({
        projectId: currentProjectId,
        subsys: expandedSubsys,
        status: caseStatusFilter === 'all' ? undefined : caseStatusFilter,
      })
      .then((data) => {
        if (!cancelled) {
          setCases(data as CaseData[]);
          // Auto-expand all file nodes when cases are loaded
          const filePaths = new Set<string>();
          for (const c of data as CaseData[]) {
            if (c.filePath) filePaths.add(c.filePath);
          }
          if (filePaths.size > 0) {
            setExpandedFiles(filePaths);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setCases([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCases(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, expandedSubsys, caseStatusFilter]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handler = () => setContextMenu((s) => ({ ...s, visible: false }));
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu.visible]);

  const toggleSubsys = (name: string) => {
    const newExpanded = expandedSubsys === name ? null : name;
    setExpandedSubsys(newExpanded);
    setSelectedSubsys(newExpanded);
    // Reset expanded states when switching subsystems
    setExpandedFiles(new Set());
    setExpandedCases(new Set());
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
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, caseData });
  };

  /**
   * Handle case selection (clicking on a case in the tree, not the run button).
   *
   * Auto-fills base/block/case into the simulation options (OptionDock),
   * matching the behavior of Python runsim_r3p0's `on_case_selected`:
   *   1. Set case name
   *   2. Fill base/block from case data (parsed by case-parser plugin)
   *   3. Clear case-specific options (rundir, seed, etc.) but preserve base/block
   */
  const handleCaseSelect = (caseData: CaseData) => {
    const caseId = getCaseId(caseData);
    setSelectedCaseId(caseId);
    selectCase(caseData);
  };

  const handleRunCase = async (caseData: CaseData) => {
    if (!currentProjectId) return;
    await startCaseRun(currentProjectId, caseData);
  };

  const handleBatchRun = async () => {
    if (!currentProjectId || selectedCases.size === 0) return;
    const selected = Array.from(selectedCases)
      .map((casePath) => cases.find((candidate) => getCaseId(candidate) === casePath))
      .filter((candidate): candidate is CaseData => !!candidate);
    await startCaseRuns(currentProjectId, selected);
    setSelectedCases(new Set());
    setBatchMode(false);
  };

  const toggleCaseSelection = (path: string) => {
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Build case tree from flat list
  const caseTree = useMemo(() => buildCaseTree(cases), [cases]);

  const subsystemPlugins = plugins.filter((plugin) => plugin.kind === 'subsys-discoverer');
  const pluginError = subsystemPlugins.find((plugin) => plugin.error)?.error;
  const hasDiscoverer = subsystemPlugins.some((plugin) => plugin.enabled && !plugin.error);

  const handleConfigureProjRtl = async () => {
    if (!currentProjectId) return;
    await loadEnvConfig(currentProjectId);
    setWizardOpen(true);
    setWizardStep('envvars');
  };

  if (!currentProjectId) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">
        请先打开项目
      </div>
    );
  }

  if (loadingSubsystems) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
        <RefreshCw className="h-3 w-3 animate-spin" />
        正在扫描子系统...
      </div>
    );
  }

  if (subsystemError) {
    return (
      <div className="px-2 py-2 text-xs">
        <div className="font-medium text-destructive">子系统查询失败</div>
        <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{subsystemError}</div>
        <button
          onClick={() => setScanVersion((version) => version + 1)}
          className="mt-2 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-primary transition-colors hover:bg-accent"
        >
          <RefreshCw className="h-3 w-3" />
          重新扫描
        </button>
      </div>
    );
  }

  if (subsystems.length === 0 && pluginError) {
    return (
      <div className="px-2 py-2 text-xs">
        <div className="font-medium text-destructive">子系统插件加载失败</div>
        <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{pluginError}</div>
      </div>
    );
  }

  if (subsystems.length === 0 && !hasDiscoverer) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">
        未加载子系统发现插件
      </div>
    );
  }

  if (subsystems.length === 0) {
    return (
      <div className="px-2 py-2 text-xs">
        <div className="font-medium text-foreground">未发现子系统</div>
        <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
          检查 PROJ_RTL 后重新扫描
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            onClick={() => setScanVersion((version) => version + 1)}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-primary transition-colors hover:bg-accent"
          >
            <RefreshCw className="h-3 w-3" />
            重新扫描
          </button>
          <button
            onClick={handleConfigureProjRtl}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Settings className="h-3 w-3" />
            配置 PROJ_RTL
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5" ref={containerRef}>
      {/* Status filter + batch mode toggle */}
      <div className="mb-1 flex items-center justify-between gap-0.5 px-1">
        <div className="flex gap-0.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setCaseStatusFilter(f.value)}
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

      {/* Batch action bar */}
      {batchMode && selectedCases.size > 0 && (
        <div className="mb-1 flex items-center gap-1 rounded border border-border/50 bg-secondary/30 px-2 py-1">
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

      {/* Subsystem list */}
      {subsystems.map((subsys) => (
        <div key={subsys.name}>
          <button
            onClick={() => toggleSubsys(subsys.name)}
            className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-accent"
          >
            {expandedSubsys === subsys.name ? (
              <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
            )}
            <Cpu className="h-3 w-3 shrink-0 text-primary/70" />
            <span className="truncate font-medium">{subsys.name}</span>
            {subsys.caseCount !== undefined && subsys.caseCount > 0 && (
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                {subsys.caseCount}
              </span>
            )}
          </button>

          {/* Cases under subsystem — tree view */}
          {expandedSubsys === subsys.name && (
            <div className="pb-1">
              {loadingCases ? (
                <div className="px-4 py-1 text-[10px] text-muted-foreground">加载中...</div>
              ) : caseTree.length === 0 ? (
                <div className="px-4 py-1 text-[10px] text-muted-foreground">无用例</div>
              ) : (
                <div>
                  {caseTree.map((node) => (
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
                      onRunCase={handleRunCase}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Context menu */}
      {contextMenu.visible && contextMenu.caseData && (
        <div
          className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover shadow-xl"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              handleRunCase(contextMenu.caseData!);
              setContextMenu((s) => ({ ...s, visible: false }));
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          >
            <Play className="h-3 w-3 text-primary" />
            运行仿真
          </button>
        </div>
      )}
    </div>
  );
}
