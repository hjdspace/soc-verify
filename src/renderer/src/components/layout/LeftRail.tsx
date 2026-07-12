import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Cpu, FileText, LayoutDashboard } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { trpc } from '@renderer/lib/trpc';
import { FileTree } from '../project/FileTree';
import { SubsysList } from '../project/SubsysList';
import { cn } from '@renderer/lib/utils';

type Tab = 'files' | 'subsystems' | 'overview';

export function LeftRail() {
  const [tab, setTab] = useState<Tab>('files');

  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const fileTree = useProjectStore((s) => s.fileTree);
  const fileTreeLoading = useProjectStore((s) => s.fileTreeLoading);
  const openProjectDialog = useProjectStore((s) => s.openProjectDialog);
  const loadFileTree = useProjectStore((s) => s.loadFileTree);
  const closeProject = useProjectStore((s) => s.closeProject);
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const setSelectedFile = useUiStore((s) => s.setSelectedFile);
  const setActiveCenterTab = useUiStore((s) => s.setActiveCenterTab);

  const currentProject = projects.find((p) => p.id === currentProjectId);

  // Listen for file tree updates via IPC
  useEffect(() => {
    if (!window.eventBridge) return;
    const unlisten = window.eventBridge.onFileTreeUpdate(() => {
      refreshFileTree();
    });
    return unlisten;
  }, [refreshFileTree]);

  // Restore projects on mount
  useEffect(() => {
    const restore = async () => {
      await useProjectStore.getState().restoreState();
    };
    restore();
  }, []);

  const handleSelectFile = (path: string, name: string) => {
    setSelectedFile(path, name);
    setActiveCenterTab(`file:${name}`);
  };

  const tabs: Array<{ id: Tab; label: string; icon: typeof FileText }> = [
    { id: 'files', label: '文件', icon: FileText },
    { id: 'subsystems', label: '子系统', icon: Cpu },
    { id: 'overview', label: '概览', icon: LayoutDashboard },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar">
      {/* ── 项目切换栏 ──────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border/50 px-2 py-1.5">
        <select
          value={currentProjectId ?? ''}
          onChange={(e) => {
            if (e.target.value) {
              useProjectStore.setState({ currentProjectId: e.target.value });
              loadFileTree(e.target.value);
            }
          }}
          className="flex-1 rounded bg-transparent px-1 py-0.5 text-xs text-sidebar-foreground outline-none"
        >
          {projects.length === 0 && <option value="">未打开项目</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id} className="bg-background text-foreground">
              {p.name}
            </option>
          ))}
        </select>
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
    <div className="flex flex-col gap-2 px-1">
      <div className="rounded-md border border-border/50 bg-background/50 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          子系统
        </div>
        <div className="text-lg font-bold text-foreground">{overview.subsystemCount}</div>
      </div>
      <div className="rounded-md border border-border/50 bg-background/50 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          用例总数
        </div>
        <div className="text-lg font-bold text-foreground">{overview.caseCount}</div>
      </div>
      <div className="rounded-md border border-border/50 bg-background/50 p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          通过率
        </div>
        <div className="text-lg font-bold text-foreground">
          {overview.passRate.toFixed(1)}%
        </div>
      </div>
    </div>
  );
}
