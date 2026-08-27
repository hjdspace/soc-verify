import { useState, useCallback, memo, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  FolderOpen as OpenIcon,
  Copy,
  CopyPlus,
  Plus,
  Trash2,
} from 'lucide-react';
import { Icon, addCollection } from '@iconify/react';
import { icons as vscodeIcons } from '@iconify-json/vscode-icons';
import type { FileTreeNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useToastStore } from '@renderer/stores/toast';
import { useSourceControlStore } from '@renderer/stores/source-control';

interface FileTreeProps {
  node: FileTreeNode;
  onSelectFile: (path: string, name: string) => void;
  selectedPath?: string;
  projectRootPath?: string;
  /** 所属目录 ID：'root' 表示项目根目录，其余为额外目录（验证/设计分组）的 dirId。
   *  懒加载展开时按此作用域请求 getDirChildren——目录位于项目根之外时必须携带，
   *  否则后端按项目根做安全校验会拒绝（表现为展开后无子项）。 */
  dirId?: string;
}

// ─── Context menu state ───────────────────────────────────

interface FileContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  node: FileTreeNode | null;
}

// ─── Helper: compute relative path ────────────────────────

function getRelativePath(rootPath: string, fullPath: string): string {
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedFull = fullPath.replace(/\\/g, '/');
  if (normalizedFull.startsWith(normalizedRoot + '/')) {
    return normalizedFull.slice(normalizedRoot.length + 1);
  }
  if (normalizedFull === normalizedRoot) return '.';
  return fullPath;
}

// ─── File-type icon mapping ────────────────────────────────
//
// Maps file extensions to the local VS Code Icons set. The icon data is bundled
// locally so the file tree stays useful in offline desktop sessions.

type IconEntry = { icon: string };

addCollection(vscodeIcons);

const DEFAULT_FILE_ICON: IconEntry = { icon: 'vscode-icons:file-type-text' };

const EXT_ICON_MAP: Record<string, IconEntry> = {
  sv: { icon: 'vscode-icons:file-type-systemverilog' }, svh: { icon: 'vscode-icons:file-type-systemverilog' },
  v: { icon: 'vscode-icons:file-type-verilog' }, vh: { icon: 'vscode-icons:file-type-verilog' },
  systemverilog: { icon: 'vscode-icons:file-type-systemverilog' }, verilog: { icon: 'vscode-icons:file-type-verilog' },
  vhd: { icon: 'vscode-icons:file-type-vhdl' }, vhdl: { icon: 'vscode-icons:file-type-vhdl' },
  sdc: { icon: 'vscode-icons:file-type-config' }, xdc: { icon: 'vscode-icons:file-type-config' },
  do: { icon: 'vscode-icons:file-type-shell' }, tcl: { icon: 'vscode-icons:file-type-tcl' },
  ts: { icon: 'vscode-icons:file-type-typescript' }, tsx: { icon: 'vscode-icons:file-type-reactjs' },
  js: { icon: 'vscode-icons:file-type-js' }, jsx: { icon: 'vscode-icons:file-type-reactjs' },
  mjs: { icon: 'vscode-icons:file-type-js' }, cjs: { icon: 'vscode-icons:file-type-js' },
  html: { icon: 'vscode-icons:file-type-html' }, htm: { icon: 'vscode-icons:file-type-html' },
  vue: { icon: 'vscode-icons:file-type-vue' }, xml: { icon: 'vscode-icons:file-type-xml' },
  css: { icon: 'vscode-icons:file-type-css' }, scss: { icon: 'vscode-icons:file-type-scss' }, less: { icon: 'vscode-icons:file-type-less' },
  c: { icon: 'vscode-icons:file-type-c' }, h: { icon: 'vscode-icons:file-type-c' },
  cpp: { icon: 'vscode-icons:file-type-cpp' }, cc: { icon: 'vscode-icons:file-type-cpp' }, cxx: { icon: 'vscode-icons:file-type-cpp' },
  hpp: { icon: 'vscode-icons:file-type-cppheader' }, hxx: { icon: 'vscode-icons:file-type-cppheader' },
  rs: { icon: 'vscode-icons:file-type-rust' }, rust: { icon: 'vscode-icons:file-type-rust' },
  go: { icon: 'vscode-icons:file-type-go' }, java: { icon: 'vscode-icons:file-type-java' },
  py: { icon: 'vscode-icons:file-type-python' }, pyw: { icon: 'vscode-icons:file-type-python' }, python: { icon: 'vscode-icons:file-type-python' },
  sh: { icon: 'vscode-icons:file-type-shell' }, bash: { icon: 'vscode-icons:file-type-shell' }, zsh: { icon: 'vscode-icons:file-type-shell' }, shell: { icon: 'vscode-icons:file-type-shell' },
  rb: { icon: 'vscode-icons:file-type-ruby' }, ruby: { icon: 'vscode-icons:file-type-ruby' }, php: { icon: 'vscode-icons:file-type-php' },
  json: { icon: 'vscode-icons:file-type-json' }, yaml: { icon: 'vscode-icons:file-type-yaml' }, yml: { icon: 'vscode-icons:file-type-yaml' },
  toml: { icon: 'vscode-icons:file-type-toml' }, ini: { icon: 'vscode-icons:file-type-config' }, cfg: { icon: 'vscode-icons:file-type-config' }, conf: { icon: 'vscode-icons:file-type-config' },
  sql: { icon: 'vscode-icons:file-type-sql' }, md: { icon: 'vscode-icons:file-type-markdown' }, markdown: { icon: 'vscode-icons:file-type-markdown' }, txt: { icon: 'vscode-icons:file-type-text' },
  bin: { icon: 'vscode-icons:file-type-binary' }, hex: { icon: 'vscode-icons:file-type-binary' }, elf: { icon: 'vscode-icons:file-type-binary' }, so: { icon: 'vscode-icons:file-type-binary' }, dll: { icon: 'vscode-icons:file-type-binary' }, o: { icon: 'vscode-icons:file-type-binary' }, a: { icon: 'vscode-icons:file-type-binary' },
  zip: { icon: 'vscode-icons:file-type-zip' }, tar: { icon: 'vscode-icons:file-type-zip' }, gz: { icon: 'vscode-icons:file-type-zip' }, '7z': { icon: 'vscode-icons:file-type-zip' }, rar: { icon: 'vscode-icons:file-type-zip' },
  png: { icon: 'vscode-icons:file-type-image' }, jpg: { icon: 'vscode-icons:file-type-image' }, jpeg: { icon: 'vscode-icons:file-type-image' }, gif: { icon: 'vscode-icons:file-type-image' }, svg: { icon: 'vscode-icons:file-type-svg' }, ico: { icon: 'vscode-icons:file-type-image' }, bmp: { icon: 'vscode-icons:file-type-image' },
  mk: { icon: 'vscode-icons:file-type-makefile' }, makefile: { icon: 'vscode-icons:file-type-makefile' }, cmake: { icon: 'vscode-icons:file-type-cmake' },
};

// Special filenames that get specific icons
const NAME_ICON_MAP: Record<string, IconEntry> = {
  makefile: { icon: 'vscode-icons:file-type-makefile' },
  cmakelists: { icon: 'vscode-icons:file-type-cmake' },
  dockerfile: { icon: 'vscode-icons:file-type-docker' },
  '.gitignore': { icon: 'vscode-icons:file-type-git' },
  '.gitattributes': { icon: 'vscode-icons:file-type-git' },
  '.env': { icon: 'vscode-icons:file-type-config' },
  'package.json': { icon: 'vscode-icons:file-type-npm' },
  'tsconfig.json': { icon: 'vscode-icons:file-type-tsconfig' },
  'eslint.config': { icon: 'vscode-icons:file-type-eslint' },
};

/**
 * Get the appropriate icon + color class for a file based on its name/extension.
 * Falls back to a generic File icon for unknown types.
 */
function getFileIcon(fileName: string): IconEntry {
  const lowerName = fileName.toLowerCase();

  // Check special filename matches first
  if (NAME_ICON_MAP[lowerName]) return NAME_ICON_MAP[lowerName];

  // Extract extension (last segment after the final dot)
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1) return DEFAULT_FILE_ICON;
  const ext = fileName.slice(lastDot + 1).toLowerCase();
  return EXT_ICON_MAP[ext] ?? DEFAULT_FILE_ICON;
}

const FOLDER_ICON_MAP: Record<string, { closed: string; opened: string }> = {
  src: { closed: 'vscode-icons:folder-type-src', opened: 'vscode-icons:folder-type-src-opened' },
  test: { closed: 'vscode-icons:folder-type-test', opened: 'vscode-icons:folder-type-test-opened' },
  tests: { closed: 'vscode-icons:folder-type-test', opened: 'vscode-icons:folder-type-test-opened' },
  '__tests__': { closed: 'vscode-icons:folder-type-test', opened: 'vscode-icons:folder-type-test-opened' },
  components: { closed: 'vscode-icons:folder-type-component', opened: 'vscode-icons:folder-type-component-opened' },
  coverage: { closed: 'vscode-icons:folder-type-coverage', opened: 'vscode-icons:folder-type-coverage-opened' },
  config: { closed: 'vscode-icons:folder-type-config', opened: 'vscode-icons:folder-type-config-opened' },
  configs: { closed: 'vscode-icons:folder-type-config', opened: 'vscode-icons:folder-type-config-opened' },
  scripts: { closed: 'vscode-icons:folder-type-script', opened: 'vscode-icons:folder-type-script-opened' },
  docs: { closed: 'vscode-icons:folder-type-docs', opened: 'vscode-icons:folder-type-docs-opened' },
  dist: { closed: 'vscode-icons:folder-type-dist', opened: 'vscode-icons:folder-type-dist-opened' },
};

function getFolderIcon(folderName: string, opened: boolean): string {
  const entry = FOLDER_ICON_MAP[folderName.toLowerCase()];
  return entry?.[opened ? 'opened' : 'closed'] ?? `vscode-icons:default-folder${opened ? '-opened' : ''}`;
}

// ─── Git status badge helpers ──────────────────────────────
//
// VS Code-style git status indicators: M (modified, yellow),
// A (added, green), D (deleted, red), U (untracked, blue).

// GitBadge 携带标记文字、tooltip，以及一组语义色 class —— badge 颜色和
// 文件名颜色共用同一语义变量，确保标记与文件名在视觉上联动。
type GitBadge = { label: string; className: string; nameClassName: string; tooltip: string };

function getGitBadge(
  indexStatus: string,
  workTreeStatus: string,
): GitBadge | null {
  // Untracked —— 绿色（VS Code 风格）
  if (indexStatus === '?' && workTreeStatus === '?') {
    return {
      label: 'U',
      className: 'text-status-pass-foreground',
      nameClassName: 'text-status-pass-foreground',
      tooltip: '未跟踪',
    };
  }
  // Deleted —— 红色
  if (indexStatus === 'D' || workTreeStatus === 'D') {
    return {
      label: 'D',
      className: 'text-status-fail-foreground',
      nameClassName: 'text-status-fail-foreground',
      tooltip: '已删除',
    };
  }
  // Renamed —— 紫色
  if (indexStatus === 'R' || workTreeStatus === 'R') {
    return {
      label: 'R',
      className: 'text-violet-foreground',
      nameClassName: 'text-violet-foreground',
      tooltip: '已重命名',
    };
  }
  // Added (staged new file) —— 绿色
  if (indexStatus === 'A') {
    return {
      label: 'A',
      className: 'text-status-pass-foreground',
      nameClassName: 'text-status-pass-foreground',
      tooltip: '已新增',
    };
  }
  // Modified —— 黄色
  if (indexStatus === 'M' || workTreeStatus === 'M') {
    return {
      label: 'M',
      className: 'text-warning-foreground',
      nameClassName: 'text-warning-foreground',
      tooltip: '已修改',
    };
  }
  // Other statuses (C=copied, etc.)
  if (indexStatus || workTreeStatus) {
    const label = (indexStatus || workTreeStatus).trim();
    if (label) {
      return {
        label,
        className: 'text-muted-foreground',
        nameClassName: 'text-muted-foreground',
        tooltip: '变更',
      };
    }
  }
  return null;
}

// ─── Git directory status helpers ─────────────────────────
//
// VS Code-style folder decorations: 目录下包含修改文件（M/D/R…）→ 黄色，
// 目录下仅有新增文件（A/U）→ 绿色。两者同时存在时黄色（修改）优先。

type GitDirStatus = 'modified' | 'added';

function getGitDirStatusKind(
  indexStatus: string,
  workTreeStatus: string,
): GitDirStatus | null {
  // 新增：untracked / staged-added
  if (indexStatus === '?' && workTreeStatus === '?') return 'added';
  if (indexStatus === 'A') return 'added';
  // 修改：deleted / renamed / modified / copied 等
  if (indexStatus === 'D' || workTreeStatus === 'D') return 'modified';
  if (indexStatus === 'R' || workTreeStatus === 'R') return 'modified';
  if (indexStatus === 'M' || workTreeStatus === 'M') return 'modified';
  if (indexStatus.trim() || workTreeStatus.trim()) return 'modified';
  return null;
}

// ─── Root component ───────────────────────────────────────

export function FileTree({ node, onSelectFile, selectedPath, projectRootPath, dirId }: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<FileContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    node: null,
  });
  const projectId = useProjectStore((s) => s.currentProjectId) ?? undefined;

const addContextFile = useSessionCoreStore((s) => s.addContextFile);
const currentSessionId = useSessionCoreStore((s) => s.currentSessionId);
  const toast = useToastStore.getState();

  // ── Git status for file-tree badges ───────────────────
  // Loads git status once per project and builds a path→badge map
  // for O(1) lookup in each tree node. Refreshes when the SCM panel
  // updates the store.
  const scmStatus = useSourceControlStore((s) => s.status);
  const loadScmStatus = useSourceControlStore((s) => s.loadStatus);

  useEffect(() => {
    if (projectId) {
      void loadScmStatus(projectId);
    }
  }, [projectId, loadScmStatus]);

  // Build a map of normalized file path → git badge.
  // SCM status paths are relative to the project root; FileTreeNode paths
  // are absolute. We normalise both sides to forward-slash absolute paths
  // so lookup works regardless of OS path separators.
  const gitBadgeMap = useMemo(() => {
    const map = new Map<string, GitBadge>();
    if (!scmStatus?.files || !projectRootPath) return map;
    const root = projectRootPath.replace(/\\/g, '/').replace(/\/$/, '');
    for (const f of scmStatus.files) {
      const badge = getGitBadge(f.indexStatus, f.workTreeStatus);
      if (!badge) continue;
      // Normalise: git paths use forward slashes, join with root
      const absPath = `${root}/${f.path.replace(/\\/g, '/')}`;
      map.set(absPath, badge);
    }
    return map;
  }, [scmStatus, projectRootPath]);

  // Build a map of directory path → aggregated git status (VS Code-style
  // folder decorations). Each changed file bubbles its status up through
  // every ancestor directory (stopping below the project root);
  // 'modified' (黄) outranks 'added' (绿) when a folder contains both.
  const gitDirStatusMap = useMemo(() => {
    const map = new Map<string, GitDirStatus>();
    if (!scmStatus?.files || !projectRootPath) return map;
    const root = projectRootPath.replace(/\\/g, '/').replace(/\/$/, '');
    for (const f of scmStatus.files) {
      const kind = getGitDirStatusKind(f.indexStatus, f.workTreeStatus);
      if (!kind) continue;
      const absPath = `${root}/${f.path.replace(/\\/g, '/')}`;
      let dir = absPath.slice(0, absPath.lastIndexOf('/'));
      while (dir.length > root.length) {
        const existing = map.get(dir);
        // Same or higher status already set — ancestors already carry it too.
        if (existing === kind || (kind === 'added' && existing === 'modified')) break;
        map.set(dir, kind);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    }
    return map;
  }, [scmStatus, projectRootPath]);

  const handleContextMenu = useCallback((e: React.MouseEvent, targetNode: FileTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, node: targetNode });
  }, []);

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

  const handleOpenFile = useCallback(async () => {
    const targetNode = contextMenu.node;
    if (!targetNode) return;
    try {
      await trpc.project.openInSystem.mutate({ path: targetNode.path, type: targetNode.type });
    } catch (err) {
      useToastStore.getState().error('打开失败', err instanceof Error ? err.message : String(err));
    }
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [contextMenu.node]);

  const handleCopyPath = useCallback(async () => {
    const targetNode = contextMenu.node;
    if (!targetNode) return;
    try {
      await navigator.clipboard.writeText(targetNode.path);
      useToastStore.getState().success('已复制路径');
    } catch {
      useToastStore.getState().error('复制失败', '无法访问剪贴板');
    }
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [contextMenu.node]);

  const handleCopyRelativePath = useCallback(async () => {
    const targetNode = contextMenu.node;
    if (!targetNode || !projectRootPath) return;
    try {
      const relPath = getRelativePath(projectRootPath, targetNode.path);
      await navigator.clipboard.writeText(relPath);
      useToastStore.getState().success('已复制相对路径');
    } catch {
      useToastStore.getState().error('复制失败', '无法访问剪贴板');
    }
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [contextMenu.node, projectRootPath]);

  const handleAddToContext = useCallback(() => {
    const targetNode = contextMenu.node;
    if (!targetNode) return;
    if (!currentSessionId) {
      toast.warning('请先创建 AI 会话', '在右侧面板点击 + 创建会话后再添加上下文');
      setContextMenu((s) => ({ ...s, visible: false }));
      return;
    }
    addContextFile({ name: targetNode.name, path: targetNode.path, type: targetNode.type });
    useToastStore.getState().success('已添加到上下文', targetNode.name);
    setContextMenu((s) => ({ ...s, visible: false }));
  }, [contextMenu.node, currentSessionId, addContextFile, toast]);

  // ─── Delete file / directory ──────────────────────────
  //
  // 删除流程：右键点击 → 菜单中选「删除」→ 弹出确认弹窗 →
  // 用户确认 → 调用 tRPC deleteNode → file watcher 自动刷新树
  const [deleteConfirm, setDeleteConfirm] = useState<
    { node: FileTreeNode } | null
  >(null);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteClick = useCallback(() => {
    const targetNode = contextMenu.node;
    if (!targetNode) return;
    setContextMenu((s) => ({ ...s, visible: false }));
    setDeleteConfirm({ node: targetNode });
  }, [contextMenu.node]);

  const handleDeleteConfirm = useCallback(async () => {
    const targetNode = deleteConfirm?.node;
    if (!targetNode || !projectId) return;
    setDeleting(true);
    try {
      await trpc.project.deleteNode.mutate({
        projectId,
        path: targetNode.path,
      });
      useToastStore.getState().success(
        '删除成功',
        targetNode.type === 'directory'
          ? `已删除文件夹「${targetNode.name}」`
          : `已删除文件「${targetNode.name}」`,
      );
    } catch (err) {
      useToastStore.getState().error(
        '删除失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setDeleting(false);
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, projectId]);

  return (
    <>
      <FileTreeNode
        node={node}
        depth={0}
        onSelectFile={onSelectFile}
        selectedPath={selectedPath}
        onContextMenu={handleContextMenu}
        projectId={projectId}
        dirId={dirId}
        gitBadgeMap={gitBadgeMap}
        gitDirStatusMap={gitDirStatusMap}
      />
      {contextMenu.visible && contextMenu.node && createPortal(
        <div
          className="fixed z-[9999] min-w-44 overflow-hidden rounded-md border border-border bg-popover shadow-xl"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleOpenFile}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
          >
            <OpenIcon className="h-3 w-3 text-muted-foreground" />
            <span>{contextMenu.node.type === 'directory' ? '在资源管理器中打开' : '打开文件'}</span>
          </button>
          <button
            onClick={handleCopyPath}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
          >
            <Copy className="h-3 w-3 text-muted-foreground" />
            <span>复制路径</span>
          </button>
          <button
            onClick={handleCopyRelativePath}
            disabled={!projectRootPath}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
          >
            <CopyPlus className="h-3 w-3 text-muted-foreground" />
            <span>复制相对路径</span>
          </button>
          <div className="border-t border-border/50" />
          <button
            onClick={handleAddToContext}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
          >
            <Plus className="h-3 w-3 text-muted-foreground" />
            <span>添加到上下文</span>
          </button>
          <div className="border-t border-border/50" />
          <button
            onClick={handleDeleteClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-destructive"
          >
            <Trash2 className="h-3 w-3 text-muted-foreground" />
            <span>删除</span>
          </button>
        </div>,
        document.body,
      )}

      {/* ─── 删除确认弹窗（portal to body to escape Drawer transform） ────────────────────────────── */}
      {deleteConfirm && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40"
          onClick={() => !deleting && setDeleteConfirm(null)}
        >
          <div
            className="w-80 rounded-lg border border-border bg-popover p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              <span className="text-sm font-semibold text-foreground">确认删除</span>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">
              {deleteConfirm.node.type === 'directory'
                ? `将递归删除文件夹「${deleteConfirm.node.name}」及其所有内容，此操作不可撤销。`
                : `将删除文件「${deleteConfirm.node.name}」，此操作不可撤销。`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleting}
                className="rounded-md border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1 text-xs text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleting && (
                  <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
                )}
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── Recursive tree node ──────────────────────────────────

interface FileTreeNodeProps {
  node: FileTreeNode;
  depth: number;
  onSelectFile: (path: string, name: string) => void;
  selectedPath?: string;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
  /** Project ID for lazy-loading directory children via tRPC. */
  projectId?: string;
  /** Owning directory scope for lazy loading ('root' or an extra-dir ID). */
  dirId?: string;
  /** Map of git-relative-path → badge for showing M/D/A/U indicators. */
  gitBadgeMap?: Map<string, GitBadge>;
  /** Map of directory path → aggregated status for VS Code-style folder markers. */
  gitDirStatusMap?: Map<string, GitDirStatus>;
}

function FileTreeNode({ node, depth, onSelectFile, selectedPath, onContextMenu, projectId, dirId, gitBadgeMap, gitDirStatusMap }: FileTreeNodeProps) {
  // Normalise node path to forward-slash absolute path for git badge lookup
  const normalizedPath = node.path.replace(/\\/g, '/');
  if (node.type === 'file') {
    return (
      <FileTreeItem
        node={node}
        depth={depth}
        onSelectFile={onSelectFile}
        selected={selectedPath === node.path}
        onContextMenu={onContextMenu}
        gitBadge={gitBadgeMap?.get(normalizedPath) ?? null}
      />
    );
  }

  return (
    <FileTreeDirectory
      node={node}
      depth={depth}
      onSelectFile={onSelectFile}
      selectedPath={selectedPath}
      onContextMenu={onContextMenu}
      projectId={projectId}
      dirId={dirId}
      gitBadgeMap={gitBadgeMap}
      gitDirStatusMap={gitDirStatusMap}
    />
  );
}

// ─── File item ────────────────────────────────────────────

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  onSelectFile: (path: string, name: string) => void;
  selected: boolean;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
  /** Git status badge for this file (null = no change). */
  gitBadge?: GitBadge | null;
}

const FileTreeItem = memo(function FileTreeItem({ node, depth, onSelectFile, selected, onContextMenu, gitBadge }: FileTreeItemProps) {
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      path: node.path,
      name: node.name,
      type: 'file' as const,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }, [node.path, node.name]);

  const fileIcon = getFileIcon(node.name);

  return (
    <button
      draggable
      onDragStart={handleDragStart}
      onClick={() => onSelectFile(node.path, node.name)}
      onContextMenu={(e) => onContextMenu(e, node)}
      className={cn(
        'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors',
        'hover:bg-accent',
        selected
          ? 'bg-accent/60 text-accent-foreground'
          : node.gitIgnored
            ? 'text-muted-foreground'
            : gitBadge?.nameClassName ?? 'text-foreground',
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <Icon
        icon={fileIcon.icon}
        aria-hidden="true"
        className={cn('h-3.5 w-3.5 shrink-0', node.gitIgnored && 'opacity-50')}
      />
      <span
        className={cn(
          'truncate',
          // 选中状态下不覆盖前景色（由 button 级 text-accent-foreground 控制）
          !selected && gitBadge?.nameClassName,
        )}
      >
        {node.name}
      </span>
      {gitBadge && (
        <span
          className={cn(
            'ml-auto shrink-0 text-[9px] font-bold',
            // 选中状态下 badge 用 accent-foreground 保持可读性
            selected ? 'text-accent-foreground' : gitBadge.className,
          )}
          title={gitBadge.tooltip}
        >
          {gitBadge.label}
        </span>
      )}
    </button>
  );
});

// ─── Directory item ───────────────────────────────────────

interface FileTreeDirectoryProps {
  node: FileTreeNode;
  depth: number;
  onSelectFile: (path: string, name: string) => void;
  selectedPath?: string;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
  /** Project ID for lazy-loading directory children via tRPC. */
  projectId?: string;
  /** Owning directory scope for lazy loading ('root' or an extra-dir ID). */
  dirId?: string;
  /** Map of git-relative-path → badge for showing M/D/A/U indicators. */
  gitBadgeMap?: Map<string, GitBadge>;
  /** Map of directory path → aggregated status for VS Code-style folder markers. */
  gitDirStatusMap?: Map<string, GitDirStatus>;
}

const FileTreeDirectory = memo(function FileTreeDirectory({
  node,
  depth,
  onSelectFile,
  selectedPath,
  onContextMenu,
  projectId,
  dirId,
  gitBadgeMap,
  gitDirStatusMap,
}: FileTreeDirectoryProps) {
  // Root-level directories (depth 0) are expanded by default.
  // All other directories start collapsed.
  const [expanded, setExpanded] = useState(depth < 1);

  // Lazy children state: when node.lazy is true, children are fetched on first expand.
  // The loaded children replace the empty array from the server.
  const [lazyChildren, setLazyChildren] = useState<FileTreeNode[] | null>(null);
  const [loadingChildren, setLoadingChildren] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((e) => {
      const next = !e;
      // If expanding a lazy node that hasn't been loaded yet, fetch children.
      if (next && node.lazy && !lazyChildren && projectId && !loadingChildren) {
        setLoadingChildren(true);
        trpc.project.getDirChildren
          .query({ projectId, dirPath: node.path, dirId })
          .then((children: FileTreeNode[]) => {
            setLazyChildren(children);
          })
          .catch((err: unknown) => {
            // 加载失败不能静默吞掉——否则目录会永远显示为空且无法重试。
            // 重置 lazyChildren 以便下次展开时重新请求。
            console.warn(`[FileTree] failed to load children of ${node.path}:`, err);
            setLazyChildren(null);
          })
          .finally(() => {
            setLoadingChildren(false);
          });
      }
      return next;
    });
  }, [node.lazy, node.path, lazyChildren, projectId, dirId, loadingChildren]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      path: node.path,
      name: node.name,
      type: 'directory' as const,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }, [node.path, node.name]);

  // Use lazyChildren if loaded, otherwise fall back to the node's children array.
  // For lazy nodes that haven't been expanded yet, children is empty (from server).
  const displayChildren = lazyChildren ?? node.children;

  // Aggregated git status for this directory (VS Code-style folder marker):
  // 'modified' → 黄色（含 M/D/R… 文件），'added' → 绿色（仅含新增 A/U 文件）
  const normalizedPath = node.path.replace(/\\/g, '/');
  const dirStatus = gitDirStatusMap?.get(normalizedPath) ?? null;

  return (
    <div>
      <button
        draggable
        onDragStart={handleDragStart}
        onClick={toggle}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={cn(
          'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-accent',
          node.gitIgnored && 'text-muted-foreground',
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 opacity-50 transition-transform duration-[150ms] ease-[var(--ease-out)]',
            expanded && 'rotate-90',
          )}
        />
        <Icon
          icon={getFolderIcon(node.name, expanded)}
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
        />
        <span
          className={cn(
            'truncate font-medium',
            dirStatus === 'modified' && 'text-warning-foreground',
            dirStatus === 'added' && 'text-status-pass-foreground',
          )}
        >
          {node.name}
        </span>
        {loadingChildren && (
          <span className="ml-1 h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent opacity-50" />
        )}
        {dirStatus && (
          <span
            className={cn(
              'ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-current',
              dirStatus === 'modified' ? 'text-warning-foreground' : 'text-status-pass-foreground',
            )}
            title={dirStatus === 'modified' ? '包含修改的文件' : '包含新增的文件'}
          />
        )}
      </button>
      <div
        className={cn(
          'grid transition-all duration-[var(--duration-normal)] ease-[var(--ease-out)]',
          expanded && displayChildren ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          {displayChildren?.map((child, idx) => (
            <div
              key={child.path}
              className="tree-item-enter animate-[tree-item-enter_200ms_var(--ease-out)_both]"
              style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
            >
              <FileTreeNode
                node={child}
                depth={depth + 1}
                onSelectFile={onSelectFile}
                selectedPath={selectedPath}
                onContextMenu={onContextMenu}
                projectId={projectId}
                dirId={dirId}
                gitBadgeMap={gitBadgeMap}
                gitDirStatusMap={gitDirStatusMap}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
