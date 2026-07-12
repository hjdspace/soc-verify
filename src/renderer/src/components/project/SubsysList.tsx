import { useEffect, useState, useRef } from 'react';
import { ChevronRight, ChevronDown, Cpu, CircleDot, Play, X } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';

interface SubsysData {
  name: string;
  path: string;
  caseCount?: number;
  description?: string;
}

interface CaseData {
  name: string;
  subsys: string;
  path: string;
  status?: string;
  duration?: number;
  description?: string;
}

const STATUS_COLORS: Record<string, string> = {
  pass: 'text-green-500',
  fail: 'text-red-500',
  running: 'text-blue-500 animate-pulse',
  pending: 'text-muted-foreground',
  error: 'text-red-500',
  aborted: 'text-orange-500',
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

export function SubsysList() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);
  const setSelectedSubsys = useProjectStore((s) => s.setSelectedSubsys);
  const caseStatusFilter = useProjectStore((s) => s.caseStatusFilter);
  const setCaseStatusFilter = useProjectStore((s) => s.setCaseStatusFilter);
  const runSimulation = useSimulationStore((s) => s.runSimulation);
  const simOptions = useSimulationStore((s) => s.simOptions);

  const [subsystems, setSubsystems] = useState<SubsysData[]>([]);
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
  const containerRef = useRef<HTMLDivElement>(null);

  // Load subsystems
  useEffect(() => {
    if (!currentProjectId) {
      setSubsystems([]);
      return;
    }
    let cancelled = false;
    trpc.project.getSubsystems
      .query({ projectId: currentProjectId })
      .then((data) => {
        if (!cancelled) setSubsystems(data as SubsysData[]);
      })
      .catch(() => {
        if (!cancelled) setSubsystems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

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
        if (!cancelled) setCases(data as CaseData[]);
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
    setExpandedSubsys(expandedSubsys === name ? null : name);
    setSelectedSubsys(expandedSubsys === name ? null : name);
  };

  const handleCaseContextMenu = (e: React.MouseEvent, caseData: CaseData) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, caseData });
  };

  const handleRunCase = async (caseData: CaseData) => {
    if (!currentProjectId) return;
    await runSimulation(currentProjectId, caseData.name, caseData.name, caseData.subsys, simOptions);
  };

  const handleBatchRun = async () => {
    if (!currentProjectId || selectedCases.size === 0) return;
    for (const casePath of selectedCases) {
      const caseData = cases.find((c) => c.path === casePath);
      if (caseData) {
        await runSimulation(currentProjectId, caseData.name, caseData.name, caseData.subsys, simOptions);
      }
    }
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

  if (!currentProjectId) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">
        请先打开项目
      </div>
    );
  }

  if (subsystems.length === 0) {
    return (
      <div className="px-2 py-1 text-xs text-muted-foreground">
        未发现子系统（需 subsys-discoverer 插件）
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

          {/* Cases under subsystem */}
          {expandedSubsys === subsys.name && (
            <div className="pb-1">
              {loadingCases ? (
                <div className="px-4 py-1 text-[10px] text-muted-foreground">加载中...</div>
              ) : cases.length === 0 ? (
                <div className="px-4 py-1 text-[10px] text-muted-foreground">无用例</div>
              ) : (
                cases.map((c) => (
                  <div
                    key={c.path}
                    className={cn(
                      'flex items-center gap-1 px-4 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 rounded cursor-pointer',
                      batchMode && selectedCases.has(c.path) && 'bg-primary/10',
                    )}
                    onClick={() => batchMode && toggleCaseSelection(c.path)}
                    onContextMenu={(e) => !batchMode && handleCaseContextMenu(e, c)}
                  >
                    {batchMode && (
                      <input
                        type="checkbox"
                        checked={selectedCases.has(c.path)}
                        onChange={() => toggleCaseSelection(c.path)}
                        className="h-2.5 w-2.5"
                      />
                    )}
                    <CircleDot className={cn('h-2.5 w-2.5 shrink-0', STATUS_COLORS[c.status ?? 'pending'])} />
                    <span className="truncate">{c.name}</span>
                    {!batchMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRunCase(c);
                        }}
                        className="ml-auto rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
                        title="运行仿真"
                      >
                        <Play className="h-2.5 w-2.5 text-primary" />
                      </button>
                    )}
                  </div>
                ))
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
