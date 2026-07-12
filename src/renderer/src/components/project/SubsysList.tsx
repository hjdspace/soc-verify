import { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown, Cpu, CircleDot } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';

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
};

const STATUS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'pass', label: '通过' },
  { value: 'fail', label: '失败' },
  { value: 'running', label: '运行中' },
  { value: 'pending', label: '待运行' },
];

export function SubsysList() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);
  const setSelectedSubsys = useProjectStore((s) => s.setSelectedSubsys);
  const caseStatusFilter = useProjectStore((s) => s.caseStatusFilter);
  const setCaseStatusFilter = useProjectStore((s) => s.setCaseStatusFilter);

  const [subsystems, setSubsystems] = useState<SubsysData[]>([]);
  const [expandedSubsys, setExpandedSubsys] = useState<string | null>(null);
  const [cases, setCases] = useState<CaseData[]>([]);
  const [loadingCases, setLoadingCases] = useState(false);

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

  const toggleSubsys = (name: string) => {
    setExpandedSubsys(expandedSubsys === name ? null : name);
    setSelectedSubsys(expandedSubsys === name ? null : name);
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
    <div className="flex flex-col gap-0.5">
      {/* Status filter */}
      <div className="mb-1 flex gap-0.5 px-1">
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
                    className="flex items-center gap-1 px-4 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 rounded"
                  >
                    <CircleDot className={cn('h-2.5 w-2.5 shrink-0', STATUS_COLORS[c.status ?? 'pending'])} />
                    <span className="truncate">{c.name}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
