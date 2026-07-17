import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, Cpu, FileText, LayoutDashboard, ChevronDown, Plus, Folder } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { trpc } from '@renderer/lib/trpc';
import { FileTree } from '../project/FileTree';
import { SubsysList } from '../project/SubsysList';
import { cn } from '@renderer/lib/utils';

type Tab = 'files' | 'subsystems' | 'overview';

interface LeftRailProps {
  width: number;
}

export function LeftRail({ width }: LeftRailProps) {
  const [tab, setTab] = useState<Tab>('files');
  const [showProjectList, setShowProjectList] = useState(false);

  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const fileTree = useProjectStore((s) => s.fileTree);
  const fileTreeLoading = useProjectStore((s) => s.fileTreeLoading);
  const openProjectDialog = useProjectStore((s) => s.openProjectDialog);
  const loadFileTree = useProjectStore((s) => s.loadFileTree);
  const closeProject = useProjectStore((s) => s.closeProject);
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const openDestination = useWorkbenchStore((s) => s.open);

  const currentProject = projects.find((p) => p.id === currentProjectId);

  // Listen for file tree updates via IPC
  useEffect(() => {
    if (!window.eventBridge) return;
    const unlisten = window.eventBridge.onFileTreeUpdate(() => {
      refreshFileTree();
    });
    return unlisten;
  }, [refreshFileTree]);

  // Restore projects on mount (guarded against StrictMode double-execution)
  const restoreDone = useRef(false);
  useEffect(() => {
    if (restoreDone.current) return;
    restoreDone.current = true;
    const restore = async () => {
      await useProjectStore.getState().restoreState();
    };
    restore();
  }, []);

  const handleSelectFile = (path: string, name: string) => {
    openDestination({ type: 'file', path, name });
  };

  const handleSelectProject = (projectId: string) => {
    useProjectStore.setState({ currentProjectId: projectId });
    loadFileTree(projectId);
    setShowProjectList(false);
  };

  const tabs: Array<{ id: Tab; label: string; icon: typeof FileText }> = [
    { id: 'files', label: '文件', icon: FileText },
    { id: 'subsystems', label: '子系统', icon: Cpu },
    { id: 'overview', label: '概览', icon: LayoutDashboard },
  ];

  return (
    <aside
      className="flex shrink-0 flex-col border-r bg-sidebar"
      style={{ width: `${width}px` }}
    >
      {/* ── 项目切换栏 ──────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border/50 px-2 py-1.5">
        {/* 自定义项目下拉 */}
        <div className="relative flex-1">
          <button
            onClick={() => setShowProjectList(!showProjectList)}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-xs text-sidebar-foreground transition-colors hover:bg-accent"
          >
            <Folder className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <span className="flex-1 truncate text-left">
              {currentProject?.name ?? '未打开项目'}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>

          {showProjectList && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowProjectList(false)}
              />
              <div className="absolute left-0 top-7 z-50 w-full min-w-48 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                {projects.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    暂无已打开的项目
                  </div>
                ) : (
                  projects.map((p) => (
                    <div
                      key={p.id}
                      onClick={() => handleSelectProject(p.id)}
                      className={cn(
                        'flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent cursor-pointer',
                        p.id === currentProjectId && 'bg-accent/50',
                      )}
                    >
                      <Folder className="h-3 w-3 shrink-0 opacity-60" />
                      <span className="flex-1 truncate">{p.name}</span>
                    </div>
                  ))
                )}
                <div className="border-t border-border/50 p-1">
                  <button
                    onClick={() => {
                      setShowProjectList(false);
                      openProjectDialog();
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-primary transition-colors hover:bg-accent"
                  >
                    <Plus className="h-3 w-3" />
                    打开项目目录
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <button
          onClick={openProjectDialog}
          title="打开项目"
          className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Tab 切换 ────────────────────────────────── */}
      <div className="flex border-b border-border/50">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1 py-1.5 text-[10px] font-medium transition-colors',
              tab === t.id
                ? 'border-b border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="h-3 w-3" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 内容区 ──────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-1.5 py-1">
        {!currentProject ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">点击上方按钮打开项目</p>
            <button
              onClick={openProjectDialog}
              className="rounded-md bg-primary/10 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/20"
            >
              打开项目目录
            </button>
          </div>
        ) : tab === 'files' ? (
          <div className="flex flex-col gap-0.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                文件树
              </span>
              <button
                onClick={refreshFileTree}
                title="刷新"
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className={cn('h-3 w-3', fileTreeLoading && 'animate-spin')} />
              </button>
            </div>
            {fileTree ? (
              <FileTree
                node={fileTree}
                onSelectFile={handleSelectFile}
              />
            ) : (
              <div className="px-2 py-1 text-xs text-muted-foreground">
                {fileTreeLoading ? '加载中...' : '无文件'}
              </div>
            )}
          </div>
        ) : tab === 'subsystems' ? (
          <div className="flex flex-col gap-0.5">
            <span className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              子系统 / 用例
            </span>
            <SubsysList />
          </div>
        ) : (
          <ProjectOverview projectId={currentProject.id} />
        )}
      </div>

      {/* ── 项目操作 ────────────────────────────────── */}
      {currentProject && (
        <div className="border-t border-border/50 px-2 py-1">
          <button
            onClick={() => closeProject(currentProject.id)}
            className="text-[10px] text-muted-foreground transition-colors hover:text-destructive"
          >
            关闭项目
          </button>
        </div>
      )}
    </aside>
  );
}

// ── 项目概览组件 ───────────────────────────────────────
// 内联统计行，避免相同卡片网格（hero-metric 模板）

function ProjectOverview({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<{
    subsystemCount: number;
    caseCount: number;
    passRate: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.project.getOverview.query({ projectId }).then((data) => {
      if (!cancelled) setOverview(data);
    }).catch(() => {
      if (!cancelled) setOverview({ subsystemCount: 0, caseCount: 0, passRate: 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!overview) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="px-1.5 py-1">
      {/* 标题 */}
      <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        项目概览
      </div>

      {/* 内联统计行：单行展示，数字与单位分明 */}
      <div className="rounded-md border border-border/50 bg-background/40 px-2.5 py-2">
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs">
          <span className="font-semibold text-foreground">{overview.subsystemCount}</span>
          <span className="text-muted-foreground">子系统</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-semibold text-foreground">{overview.caseCount}</span>
          <span className="text-muted-foreground">用例</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="font-semibold text-foreground">{overview.passRate.toFixed(1)}%</span>
          <span className="text-muted-foreground">通过率</span>
        </div>
      </div>

      {/* 子系统列表入口提示 */}
      <div className="mt-2 px-1 text-[11px] text-muted-foreground">
        切换到「子系统」标签查看用例列表
      </div>
    </div>
  );
}
