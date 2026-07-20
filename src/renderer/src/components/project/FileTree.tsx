import { useState, useCallback, memo, useEffect } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, FolderOpen as OpenIcon, Copy, CopyPlus, Plus } from 'lucide-react';
import type { FileTreeNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import { useSessionStore } from '@renderer/stores/session';
import { useToastStore } from '@renderer/stores/toast';

interface FileTreeProps {
  node: FileTreeNode;
  onSelectFile: (path: string, name: string) => void;
  selectedPath?: string;
  projectRootPath?: string;
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

// ─── Root component ───────────────────────────────────────

export function FileTree({ node, onSelectFile, selectedPath, projectRootPath }: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<FileContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    node: null,
  });

  const addContextFile = useSessionStore((s) => s.addContextFile);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const toast = useToastStore.getState();

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

  return (
    <>
      <FileTreeNode
        node={node}
        depth={0}
        onSelectFile={onSelectFile}
        selectedPath={selectedPath}
        onContextMenu={handleContextMenu}
      />
      {contextMenu.visible && contextMenu.node && (
        <div
          className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover shadow-xl"
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
        </div>
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
}

function FileTreeNode({ node, depth, onSelectFile, selectedPath, onContextMenu }: FileTreeNodeProps) {
  if (node.type === 'file') {
    return (
      <FileTreeItem
        node={node}
        depth={depth}
        onSelectFile={onSelectFile}
        selected={selectedPath === node.path}
        onContextMenu={onContextMenu}
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
}

const FileTreeItem = memo(function FileTreeItem({ node, depth, onSelectFile, selected, onContextMenu }: FileTreeItemProps) {
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      path: node.path,
      name: node.name,
      type: 'file' as const,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }, [node.path, node.name]);

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
            : 'text-foreground',
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <File className={cn('h-3 w-3 shrink-0', node.gitIgnored ? 'opacity-50' : 'opacity-70')} />
      <span className="truncate">{node.name}</span>
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
}

const FileTreeDirectory = memo(function FileTreeDirectory({
  node,
  depth,
  onSelectFile,
  selectedPath,
  onContextMenu,
}: FileTreeDirectoryProps) {
  const [expanded, setExpanded] = useState(depth < 1);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      path: node.path,
      name: node.name,
      type: 'directory' as const,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  }, [node.path, node.name]);

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
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
        )}
        {expanded ? (
          <FolderOpen className="h-3 w-3 shrink-0 text-primary/70" />
        ) : (
          <Folder className="h-3 w-3 shrink-0 text-primary/70" />
        )}
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
});
