import { useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  FolderOpen,
  RefreshCw,
  ChevronDown,
  Plus,
  Folder,
  Star,
  Trash2,
  FolderInput,
  Pencil,
  Check,
  X,
  History,
} from 'lucide-react';
import { useProjectStore, type RecentFileEntry } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { useDiffReviewStore } from '@renderer/stores/diff-review';
import { FileTree } from '../project/FileTree';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import { tRPCError, getToast } from '@renderer/lib/trpc-utils';
import type { DirGroup, ExtraDirEntry, FileTreeNode, ProjectInfo } from '@shared/types';
import { Drawer } from './Drawer';

/** 原型：文件抽屉宽 330px */
const FILE_DRAWER_WIDTH = 330;

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 左侧文件抽屉（Issue #7）：文件树 / 子系统双 Tab + 底部「最近打开」。
 * 内容复用原 LeftRail 的项目切换、多目录文件树与子系统列表，功能无降级；
 * overview 已由总览视图吸收，plugins 走 workspace Tab 打开方式。
 */
export function FileDrawer() {
  const open = useUiStore((s) => s.leftDrawerOpen);
  const closeDrawers = useUiStore((s) => s.closeDrawers);
  const [showProjectList, setShowProjectList] = useState(false);

  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const fileTree = useProjectStore((s) => s.fileTree);
  const fileTreeLoading = useProjectStore((s) => s.fileTreeLoading);
  const openProjectDialog = useProjectStore((s) => s.openProjectDialog);
  const switchProject = useProjectStore((s) => s.switchProject);
  const closeProject = useProjectStore((s) => s.closeProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const refreshFileTree = useProjectStore((s) => s.refreshFileTree);
  const loadExtraDirs = useProjectStore((s) => s.loadExtraDirs);
  const extraDirs = useProjectStore((s) => s.extraDirs);
  const dirFileTrees = useProjectStore((s) => s.dirFileTrees);
  const dirFileTreeLoading = useProjectStore((s) => s.dirFileTreeLoading);
  const loadDirFileTree = useProjectStore((s) => s.loadDirFileTree);
  const addDir = useProjectStore((s) => s.addDir);
  const removeDir = useProjectStore((s) => s.removeDir);

  const currentProject = projects.find((p) => p.id === currentProjectId);

  // Listen for file tree updates via IPC
  useEffect(() => {
    if (!window.eventBridge) return;
    const unlisten = window.eventBridge.onFileTreeUpdate(() => {
      refreshFileTree();
    });
    return unlisten;
  }, [refreshFileTree]);

  const handleSelectFile = (path: string, name: string) => {
    openReviewAwareFile(path, name);
  };

  const handleSelectProject = (projectId: string) => {
    setShowProjectList(false);
    void switchProject(projectId);
  };

  // ── 项目重命名 ──────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  /** 获取项目的显示名：优先 projectLabel，回退到 name（目录名）。 */
  const displayLabel = (p: { projectLabel?: string; name: string }) => p.projectLabel ?? p.name;

  const handleStartRename = (projectId: string, currentLabel: string) => {
    setRenamingId(projectId);
    setRenameValue(currentLabel);
  };

  const handleCancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const handleSubmitRename = async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      getToast().warning('项目标记名不能为空');
      return;
    }
    await renameProject(renamingId, trimmed);
    handleCancelRename();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSubmitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelRename();
    }
  };

  // ── 多目录操作 ──────────────────────────────────────
  /** 「+」按钮：弹出系统文件夹选择对话框，选择后调用 addDir。 */
  const handleAddDir = async (group: DirGroup) => {
    try {
      const result = await trpc.project.pickDirDialog.mutate();
      if (result.canceled) return;
      await addDir(result.path, group);
    } catch (err) {
      getToast().error('添加目录失败', tRPCError(err));
    }
  };

  /** 拖拽文件夹到抽屉区域：提取路径后调用 addDir。 */
  const handleDropDir = async (e: React.DragEvent, group: DirGroup) => {
    e.preventDefault();
    e.stopPropagation();
    // Try to get file path from DataTransfer items (Electron exposes path on File objects)
    const dt = e.dataTransfer;
    if (!dt) return;

    let droppedPath: string | null = null;

    // Electron extends File with a `path` property for dropped files/folders
    if (dt.files && dt.files.length > 0) {
      const file = dt.files[0] as File & { path?: string };
      if (file.path) {
        droppedPath = file.path;
      }
    }

    // Fallback: try items API
    if (!droppedPath && dt.items && dt.items.length > 0) {
      const item = dt.items[0];
      if (item.kind === 'file') {
        const file = item.getAsFile() as File & { path?: string } | null;
        if (file?.path) {
          droppedPath = file.path;
        }
      }
    }

    if (!droppedPath) {
      getToast().warning('无法获取拖拽的目录路径', '请拖拽文件系统中的文件夹');
      return;
    }

    await addDir(droppedPath, group);
  };

  /** 切换 cwd 到指定目录，后端会发送 cwd:changed 事件触发会话重建。
   *  成功后重新加载 extraDirs 刷新星标显示。 */
  const handleSetCwd = async (dirId: string) => {
    if (!currentProjectId) return;
    try {
      await trpc.project.setCwd.mutate({ projectId: currentProjectId, dirId });
      // Reload extraDirs to refresh isCwd flags in the UI (star badge)
      await loadExtraDirs(currentProjectId);
      getToast().success('已切换工作目录');
    } catch (err) {
      getToast().error('切换工作目录失败', tRPCError(err));
    }
  };

  /** 移除目录：先检查 Review Queue 中是否有该目录路径下的未审阅改动，有则弹出确认。 */
  const handleRemoveDir = async (dirId: string, dirPath: string, _isCwd: boolean) => {
    // 检查 Review Queue 中是否有该目录路径下的未审阅改动
    const reviewQueue = useDiffReviewStore.getState().queue;
    const hasPendingReviews = reviewQueue.some(
      (entry) => !entry.reviewed && entry.filePath.toLowerCase().startsWith(dirPath.toLowerCase()),
    );

    if (hasPendingReviews) {
      const confirmed = window.confirm(
        `目录「${dirPath}」下有未审阅的 AI 文件改动，移除后这些改动将无法在 Review Queue 中追踪。确定要移除吗？`,
      );
      if (!confirmed) return;
    }

    await removeDir(dirId);
    // 如果移除的是 cwd 目录，后端会自动回退到验证组第一个剩余目录并发送 cwd:changed 事件
  };

  return (
    <Drawer side="left" open={open} onClose={closeDrawers} title="文件" width={FILE_DRAWER_WIDTH} flush>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* ── 项目切换栏 ──────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-border/50 px-2 py-1.5">
          {/* 自定义项目下拉 */}
          <div className="relative flex-1">
            {renamingId === currentProjectId && currentProject ? (
              /* Inline rename for current project header */
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs text-foreground outline-none"
                  data-testid="header-rename-input"
                />
                <button
                  onClick={() => void handleSubmitRename()}
                  title="确认"
                  className="rounded p-0.5 text-primary hover:bg-accent"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  onClick={handleCancelRename}
                  title="取消"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowProjectList(!showProjectList)}
                onDoubleClick={(e) => {
                  if (currentProject) {
                    e.preventDefault();
                    handleStartRename(currentProject.id, displayLabel(currentProject));
                  }
                }}
                title={currentProject ? '双击编辑项目标记名' : undefined}
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-xs text-sidebar-foreground transition-colors hover:bg-accent"
                data-testid="project-dropdown-btn"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className="flex-1 truncate text-left">
                  {currentProject ? displayLabel(currentProject) : '未打开项目'}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </button>
            )}

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
                        className={cn(
                          'group flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent cursor-pointer',
                          p.id === currentProjectId && 'bg-accent/50',
                        )}
                      >
                        {renamingId === p.id ? (
                          /* Inline rename input */
                          <div className="flex flex-1 items-center gap-1">
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={handleRenameKeyDown}
                              onClick={(e) => e.stopPropagation()}
                              className="min-w-0 flex-1 rounded border border-primary bg-background px-1.5 py-0.5 text-xs text-foreground outline-none"
                              data-testid={`rename-input-${p.id}`}
                            />
                            <button
                              onClick={(e) => { e.stopPropagation(); void handleSubmitRename(); }}
                              title="确认"
                              className="rounded p-0.5 text-primary hover:bg-accent"
                            >
                              <Check className="h-3 w-3" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleCancelRename(); }}
                              title="取消"
                              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <Folder className="h-3 w-3 shrink-0 opacity-60" />
                            <span
                              className="flex-1 truncate"
                              onClick={() => handleSelectProject(p.id)}
                            >
                              {displayLabel(p)}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStartRename(p.id, displayLabel(p)); }}
                              title="重命名"
                              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                              data-testid={`rename-btn-${p.id}`}
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </>
                        )}
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
          ) : open ? (
            <FileTreeSection
              currentProject={currentProject}
              fileTree={fileTree}
              fileTreeLoading={fileTreeLoading}
              extraDirs={extraDirs}
              dirFileTrees={dirFileTrees}
              dirFileTreeLoading={dirFileTreeLoading}
              refreshFileTree={refreshFileTree}
              loadDirFileTree={loadDirFileTree}
              currentProjectId={currentProjectId}
              onSelectFile={handleSelectFile}
              onAddDir={handleAddDir}
              onDropDir={handleDropDir}
              onSetCwd={handleSetCwd}
              onRemoveDir={handleRemoveDir}
            />
          ) : null}
        </div>

        {/* ── 最近打开 ────────────────────────────────── */}
        <RecentFilesSection />

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
      </div>
    </Drawer>
  );
}

// ── 最近打开列表 ────────────────────────────────────────

function RecentFilesSection() {
  const recentFiles = useProjectStore((s) => s.recentFiles);

  if (recentFiles.length === 0) return null;

  return (
    <div className="border-t border-border/50 px-2 py-1.5" data-testid="recent-files">
      <div className="mb-1 flex items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <History className="h-2.5 w-2.5" />
        最近打开
      </div>
      <div className="flex flex-col">
        {recentFiles.map((f) => (
          <RecentFileRow key={f.path} entry={f} />
        ))}
      </div>
    </div>
  );
}

function RecentFileRow({ entry }: { entry: RecentFileEntry }) {
  return (
    <button
      onClick={() => openReviewAwareFile(entry.path, entry.name)}
      title={entry.path}
      data-testid={`recent-file-${entry.name}`}
      className="flex items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-accent"
    >
      <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
      <span className="shrink-0 tabular-nums text-[9px] text-muted-foreground">
        {formatTime(entry.openedAt)}
      </span>
    </button>
  );
}

// ── 多目录文件树分组组件 ────────────────────────────────────
// VS Code 多根工作区风格：按分组（验证/设计）分隔并列展示所有目录的文件树。

interface DirEntry {
  /** dirId for extra dirs, or 'root' for the project root. */
  dirId: string;
  label: string;
  path: string;
  group: DirGroup;
  isCwd: boolean;
}

const GROUP_LABELS: Record<DirGroup, string> = {
  verify: '验证',
  design: '设计',
};

interface FileTreeSectionProps {
  currentProject?: ProjectInfo;
  fileTree: FileTreeNode | null;
  fileTreeLoading: boolean;
  extraDirs: ExtraDirEntry[];
  dirFileTrees: Record<string, FileTreeNode>;
  dirFileTreeLoading: Record<string, boolean>;
  refreshFileTree: () => Promise<void>;
  loadDirFileTree: (projectId: string, dirId: string) => Promise<void>;
  currentProjectId: string | null;
  onSelectFile: (path: string, name: string) => void;
  onAddDir: (group: DirGroup) => void;
  onDropDir: (e: React.DragEvent, group: DirGroup) => void;
  onSetCwd: (dirId: string) => void;
  onRemoveDir: (dirId: string, dirPath: string, isCwd: boolean) => void;
}

function FileTreeSection({
  currentProject,
  fileTree,
  fileTreeLoading,
  extraDirs,
  dirFileTrees,
  dirFileTreeLoading,
  refreshFileTree,
  loadDirFileTree,
  currentProjectId,
  onSelectFile,
  onAddDir,
  onDropDir,
  onSetCwd,
  onRemoveDir,
}: FileTreeSectionProps) {
  // Build the unified dir list: project root (verify group, first = default cwd) + extra dirs.
  const allDirs: DirEntry[] = useMemo(() => {
    const dirs: DirEntry[] = [];
    if (currentProject) {
      dirs.push({
        dirId: 'root',
        label: currentProject.name,
        path: currentProject.rootPath,
        group: 'verify',
        isCwd: !extraDirs.some((d) => d.isCwd), // root is cwd unless an extra dir is marked
      });
    }
    for (const d of extraDirs) {
      dirs.push({
        dirId: d.id,
        label: d.label ?? d.path.split(/[/\\]/).pop() ?? d.path,
        path: d.path,
        group: d.group,
        isCwd: d.isCwd,
      });
    }
    return dirs;
  }, [currentProject, extraDirs]);

  // Group dirs by their group key, preserving order.
  const dirsByGroup = useMemo(() => {
    const groups: DirGroup[] = ['verify', 'design'];
    return groups.map((g) => ({
      group: g,
      dirs: allDirs.filter((d) => d.group === g),
    }));
  }, [allDirs]);

  return (
    <div className="flex flex-col gap-1">
      {/* 全局刷新按钮 */}
      <div className="mb-0.5 flex items-center justify-between">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          文件树
        </span>
        <button
          onClick={() => void refreshFileTree()}
          title="刷新所有目录"
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn('h-3 w-3', fileTreeLoading && 'animate-spin')} />
        </button>
      </div>

      {dirsByGroup.map(({ group, dirs }) => (
        <div
          key={group}
          className="flex flex-col gap-0.5"
          data-testid={`dir-group-${group}`}
          onDrop={(e) => onDropDir(e, group)}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          {/* 分组标题行 + 「+」按钮 */}
          <div className="flex items-center justify-between border-b border-border/30 pb-0.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              {GROUP_LABELS[group]}
            </span>
            <button
              onClick={() => onAddDir(group)}
              title={`添加${GROUP_LABELS[group]}目录`}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              data-testid={`add-dir-${group}`}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          {/* 拖拽提示区域 — 不可见但作为 drop target */}
          <div
            data-testid={`dir-drop-zone-${group}`}
            className="min-h-[2px]"
            onDrop={(e) => onDropDir(e, group)}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          />

          {/* 该分组下的每个目录的文件树 */}
          {dirs.map((dir) => (
            <DirTreeEntry
              key={dir.dirId}
              dir={dir}
              currentProject={currentProject}
              fileTree={fileTree}
              fileTreeLoading={fileTreeLoading}
              dirFileTrees={dirFileTrees}
              dirFileTreeLoading={dirFileTreeLoading}
              loadDirFileTree={loadDirFileTree}
              currentProjectId={currentProjectId}
              onSelectFile={onSelectFile}
              onSetCwd={onSetCwd}
              onRemoveDir={onRemoveDir}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── 单个目录的文件树入口 ────────────────────────────────────

interface DirTreeEntryProps {
  dir: DirEntry;
  currentProject?: ProjectInfo;
  fileTree: FileTreeNode | null;
  fileTreeLoading: boolean;
  dirFileTrees: Record<string, FileTreeNode>;
  dirFileTreeLoading: Record<string, boolean>;
  loadDirFileTree: (projectId: string, dirId: string) => Promise<void>;
  currentProjectId: string | null;
  onSelectFile: (path: string, name: string) => void;
  onSetCwd: (dirId: string) => void;
  onRemoveDir: (dirId: string, dirPath: string, isCwd: boolean) => void;
}

function DirTreeEntry({
  dir,
  currentProject,
  fileTree,
  fileTreeLoading,
  dirFileTrees,
  dirFileTreeLoading,
  loadDirFileTree,
  currentProjectId,
  onSelectFile,
  onSetCwd,
  onRemoveDir,
}: DirTreeEntryProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false,
  });

  // Close context menu on outside click or escape
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleClick = () => setContextMenu((s) => ({ ...s, visible: false }));
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu((s) => ({ ...s, visible: false }));
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu.visible]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
  }, []);

  const handleSetCwdClick = useCallback(() => {
    onSetCwd(dir.dirId === 'root' ? 'root' : dir.dirId);
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [dir.dirId, onSetCwd]);

  const handleRemoveClick = useCallback(() => {
    onRemoveDir(dir.dirId, dir.path, dir.isCwd);
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [dir.dirId, dir.path, dir.isCwd, onRemoveDir]);

  return (
    <div className="flex flex-col gap-0.5" data-testid={`dir-tree-${dir.dirId}`}>
      {/* 目录标题行：名称 + cwd 标记/切换 + 右键菜单 */}
      <div
        className="flex cursor-pointer items-center gap-1 px-1 py-0.5 hover:bg-accent/50"
        data-testid={`dir-header-${dir.dirId}`}
        onContextMenu={handleContextMenu}
      >
        <Folder className={cn('h-3 w-3 shrink-0 text-primary/70', dir.isCwd && 'text-primary')} />
        <span
          className={cn(
            'flex-1 truncate text-[11px]',
            dir.isCwd ? 'font-bold text-foreground' : 'font-medium text-foreground',
          )}
          data-testid={`dir-label-${dir.dirId}`}
        >
          {dir.label}
        </span>
        {dir.isCwd ? (
          <span
            className="flex items-center gap-0.5 text-[9px] text-primary"
            title="当前工作目录"
          >
            <Star className="h-2.5 w-2.5 fill-primary" data-testid="cwd-star" />
            cwd
          </span>
        ) : (
          <button
            onClick={() => onSetCwd(dir.dirId === 'root' ? 'root' : dir.dirId)}
            title="设为工作目录"
            className="rounded px-1 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            设为 cwd
          </button>
        )}
      </div>

      {/* 文件树实例 */}
      {dir.dirId === 'root' ? (
        fileTree ? (
          <FileTree
            node={fileTree}
            onSelectFile={onSelectFile}
            projectRootPath={currentProject?.rootPath}
            dirId="root"
          />
        ) : (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {fileTreeLoading ? '加载中...' : '无文件'}
          </div>
        )
      ) : dirFileTrees[dir.dirId] ? (
        <FileTree
          node={dirFileTrees[dir.dirId]}
          onSelectFile={onSelectFile}
          projectRootPath={dir.path}
          dirId={dir.dirId}
        />
      ) : (
        <DirFileTreeLoader
          dirId={dir.dirId}
          projectId={currentProjectId}
          loading={dirFileTreeLoading[dir.dirId] ?? false}
          loadDirFileTree={loadDirFileTree}
        />
      )}

      {/* 右键上下文菜单（portal to body to escape Drawer transform） */}
      {contextMenu.visible && createPortal(
        <>
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setContextMenu((s) => ({ ...s, visible: false }))}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu((s) => ({ ...s, visible: false }));
            }}
          />
          <div
            className="fixed z-[9999] min-w-40 overflow-hidden rounded-md border border-border bg-popover shadow-xl"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {!dir.isCwd && (
              <button
                onClick={handleSetCwdClick}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
              >
                <FolderInput className="h-3 w-3" />
                设为工作目录
              </button>
            )}
            {dir.dirId !== 'root' && (
              <button
                onClick={handleRemoveClick}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-accent"
              >
                <Trash2 className="h-3 w-3" />
                移除目录
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/** 懒加载额外目录文件树的占位组件。 */
function DirFileTreeLoader({
  dirId,
  projectId,
  loading,
  loadDirFileTree,
}: {
  dirId: string;
  projectId: string | null;
  loading: boolean;
  loadDirFileTree: (projectId: string, dirId: string) => Promise<void>;
}) {
  useEffect(() => {
    if (projectId && !loading) {
      void loadDirFileTree(projectId, dirId);
    }
  }, [dirId, projectId, loading, loadDirFileTree]);

  return (
    <div className="px-2 py-1 text-xs text-muted-foreground">
      {loading ? '加载中...' : '等待加载...'}
    </div>
  );
}
