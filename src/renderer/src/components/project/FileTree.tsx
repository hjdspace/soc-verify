import { useState, useCallback, memo } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from 'lucide-react';
import type { FileTreeNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';

interface FileTreeProps {
  node: FileTreeNode;
  onSelectFile: (path: string, name: string) => void;
  selectedPath?: string;
  depth?: number;
}

export function FileTree({ node, onSelectFile, selectedPath, depth = 0 }: FileTreeProps) {
  if (node.type === 'file') {
    return (
      <FileTreeItem
        node={node}
        depth={depth}
        onSelectFile={onSelectFile}
        selected={selectedPath === node.path}
      />
    );
  }

  return <FileTreeDirectory node={node} depth={depth} onSelectFile={onSelectFile} selectedPath={selectedPath} />;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  onSelectFile: (path: string, name: string) => void;
  selected: boolean;
}

const FileTreeItem = memo(function FileTreeItem({ node, depth, onSelectFile, selected }: FileTreeItemProps) {
  return (
    <button
      onClick={() => onSelectFile(node.path, node.name)}
      className={cn(
        'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors',
        'hover:bg-accent',
        selected && 'bg-accent/60 text-accent-foreground',
        !selected && 'text-muted-foreground',
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <File className="h-3 w-3 shrink-0 opacity-50" />
      <span className="truncate">{node.name}</span>
    </button>
  );
});

interface FileTreeDirectoryProps {
  node: FileTreeNode;
  depth: number;
  onSelectFile: (path: string, name: string) => void;
  selectedPath?: string;
}

const FileTreeDirectory = memo(function FileTreeDirectory({
  node,
  depth,
  onSelectFile,
  selectedPath,
}: FileTreeDirectoryProps) {
  const [expanded, setExpanded] = useState(depth < 1);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  return (
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-accent"
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
            <FileTree
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
});
