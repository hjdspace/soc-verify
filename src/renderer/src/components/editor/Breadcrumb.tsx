import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Folder, File as FileIcon, ChevronDown } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useProjectStore } from '@renderer/stores/project';
import { openFileDestination, useWorkbenchStore } from '@renderer/stores/workbench';
import type { FileTreeNode } from '@shared/types';

// ── 路径解析工具 ────────────────────────────────────────────────

type PathSegment = {
  /** 段名称（如 `rtl`、`alu_add.sv`） */
  name: string;
  /** 累积路径（如 `/proj/rtl`），用于点击导航 */
  path: string;
};

/**
 * 将文件路径拆分为面包屑段数组。
 * 自动识别 `/` 和 `\` 分隔符，保留 Unix 前导 `/` 作为根段。
 *
 * 示例：
 *   `/proj/rtl/alu_add.sv` → [{ name: '/', path: '/' }, { name: 'proj', path: '/proj' }, { name: 'rtl', path: '/proj/rtl' }, { name: 'alu_add.sv', path: '/proj/rtl/alu_add.sv' }]
 *   `C:\proj\rtl\alu_add.sv` → [{ name: 'C:', path: 'C:' }, { name: 'proj', path: 'C:\proj' }, ...]
 *   `alu_add.sv` → [{ name: 'alu_add.sv', path: 'alu_add.sv' }]
 */
function parsePathSegments(filePath: string): PathSegment[] {
  // 检测分隔符：如果路径包含 `\` 则使用 `\`，否则使用 `/`
  const sep = filePath.includes('\\') ? '\\' : '/';
  const isAbsoluteUnix = filePath.startsWith('/');

  // 按分隔符拆分，过滤空段
  const parts = filePath.split(/[/\\]/).filter((p) => p.length > 0);
  if (parts.length === 0) return [{ name: filePath, path: filePath }];

  const segments: PathSegment[] = [];

  // Unix 绝对路径：前导 `/` 作为根段
  if (isAbsoluteUnix) {
    segments.push({ name: '/', path: '/' });
  }

  // 逐段累积路径
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (isAbsoluteUnix) {
      // /proj, /proj/rtl, /proj/rtl/alu_add.sv
      segments.push({ name: part, path: '/' + parts.slice(0, i + 1).join('/') });
    } else {
      // C:, C:\proj, C:\proj\rtl, ...
      const path = i === 0 ? part : parts.slice(0, i + 1).join(sep);
      segments.push({ name: part, path });
    }
  }

  return segments;
}

/** 获取路径的父目录路径 */
function parentPath(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(/[/\\]/).filter((p) => p.length > 0);
  if (parts.length <= 1) {
    // 根目录或单段路径 — 返回自身
    return filePath.startsWith('/') ? '/' : (filePath.includes(':') ? parts[0] : filePath);
  }
  // 去掉最后一段
  parts.pop();
  if (filePath.startsWith('/')) {
    return '/' + parts.join('/');
  }
  return parts.join(sep);
}

// ── BreadcrumbDropdownItem 子组件 ──────────────────────────────

type DropdownItem = {
  node: FileTreeNode;
  expanded?: boolean;
  children?: FileTreeNode[];
  loading?: boolean;
};

function BreadcrumbDropdownItem({
  item,
  level,
  onOpenFile,
  onToggleDir,
}: {
  item: DropdownItem;
  level: number;
  onOpenFile: (path: string, name: string) => void;
  onToggleDir: (path: string) => void;
}) {
  const isDir = item.node.type === 'directory';

  return (
    <>
      <div
        className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        onClick={(e) => {
          e.stopPropagation();
          if (isDir) {
            onToggleDir(item.node.path);
          } else {
            onOpenFile(item.node.path, item.node.name);
          }
        }}
        data-testid={`dropdown-item-${item.node.path}`}
      >
        {isDir ? (
          <>
            {item.loading ? (
              <ChevronDown className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : item.expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <FileIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          </>
        )}
        <span className="truncate">{item.node.name}</span>
      </div>
      {isDir && item.expanded && item.children && (
        <div>
          {item.children.map((child) => (
            <BreadcrumbDropdownItem
              key={child.path}
              item={{ node: child }}
              level={level + 1}
              onOpenFile={onOpenFile}
              onToggleDir={onToggleDir}
            />
          ))}
          {item.children.length === 0 && !item.loading && (
            <div
              className="px-1.5 py-0.5 text-[10px] text-muted-foreground/60"
              style={{ paddingLeft: `${(level + 1) * 12 + 6}px` }}
            >
              （空目录）
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── BreadcrumbDropdown 子组件 ──────────────────────────────────

function BreadcrumbDropdown({
  dirPath,
  anchorRect,
  highlightedName,
  onSelectFile,
  onClose,
}: {
  dirPath: string;
  /** 面包屑段按钮的屏幕坐标，用于定位下拉列表 */
  anchorRect: DOMRect;
  highlightedName?: string;
  onSelectFile: (path: string, name: string) => void;
  onClose: () => void;
}) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const [items, setItems] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, FileTreeNode[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 加载目录内容
  const loadDir = useCallback((path: string): Promise<FileTreeNode[]> => {
    if (!projectId) return Promise.resolve([]);
    return trpc.project.getDirChildren
      .query({ projectId, dirPath: path })
      .catch(() => [] as FileTreeNode[]);
  }, [projectId]);

  // 初始加载
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadDir(dirPath).then((children) => {
      if (!cancelled) {
        setItems(children);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [dirPath, loadDir]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 使用 mousedown 而非 click，确保在面包屑按钮的 onClick 之前关闭旧下拉
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // ESC 关闭
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleToggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // 懒加载子目录
        if (!(path in dirChildren) && !loadingDirs.has(path)) {
          setLoadingDirs((prev2) => new Set(prev2).add(path));
          void loadDir(path).then((children) => {
            setDirChildren((prev3) => ({ ...prev3, [path]: children }));
            setLoadingDirs((prev3) => {
              const next3 = new Set(prev3);
              next3.delete(path);
              return next3;
            });
          });
        }
      }
      return next;
    });
  }, [dirChildren, loadingDirs, loadDir]);

  const handleOpenFile = useCallback((path: string, name: string) => {
    onSelectFile(path, name);
    onClose();
  }, [onSelectFile, onClose]);

  // 计算定位：下拉列表放在面包屑段按钮的正下方
  const style: React.CSSProperties = {
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.bottom + 4,
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={dropdownRef}
      className="max-h-80 w-72 overflow-auto rounded-md border border-border bg-popover shadow-lg"
      style={style}
      data-testid="breadcrumb-dropdown"
    >
      {loading ? (
        <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
          <ChevronDown className="h-3 w-3 animate-spin" />
          加载中...
        </div>
      ) : items.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">（空目录）</div>
      ) : (
        items.map((node) => {
          const isExpanded = expandedDirs.has(node.path);
          const children = dirChildren[node.path];
          const isLoadingDir = loadingDirs.has(node.path);
          // 高亮当前面包屑段对应的同级项
          const isHighlighted = highlightedName != null && node.name === highlightedName;

          return (
            <div key={node.path} className={isHighlighted ? 'bg-accent/50' : ''}>
              <BreadcrumbDropdownItem
                item={{
                  node,
                  expanded: isExpanded,
                  children,
                  loading: isLoadingDir,
                }}
                level={0}
                onOpenFile={handleOpenFile}
                onToggleDir={handleToggleDir}
              />
            </div>
          );
        })
      )}
    </div>,
    document.body,
  );
}

// ── Breadcrumb 组件 ────────────────────────────────────────────

interface BreadcrumbProps {
  /** 完整文件路径 */
  filePath: string;
  /** 点击非末尾段时的导航回调，参数为该段的累积路径（如 `/proj/rtl`）。
   *  如果不提供，则使用内置的 VS Code 风格下拉列表。 */
  onNavigate?: (dirPath: string) => void;
}

export function Breadcrumb({ filePath, onNavigate }: BreadcrumbProps) {
  const segments = useMemo(() => parsePathSegments(filePath), [filePath]);
  const [dropdownState, setDropdownState] = useState<{ segmentIndex: number; dirPath: string; anchorRect: DOMRect } | null>(null);
  const open = useWorkbenchStore((s) => s.open);

  const handleOpenFile = useCallback((path: string, name: string) => {
    openFileDestination(open, path, name);
  }, [open]);

  const handleSegmentClick = useCallback((segment: PathSegment, index: number, e: React.MouseEvent) => {
    // 如果有 onNavigate 回调（向后兼容），调用它
    if (onNavigate) {
      onNavigate(segment.path);
      return;
    }
    // 获取被点击按钮的屏幕坐标用于定位下拉列表
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    // 如果已经打开了同一个段的下拉，则关闭它（toggle 行为）
    if (dropdownState?.segmentIndex === index) {
      setDropdownState(null);
      return;
    }
    // 点击目录段：弹出下拉列表，展示该段的同级内容（即父目录的内容）
    // 父目录路径 = 该段的父目录
    const parent = parentPath(segment.path);
    setDropdownState({ segmentIndex: index, dirPath: parent, anchorRect: rect });
  }, [onNavigate, dropdownState]);

  // 计算下拉列表应该高亮的段名（当前点击的段在父目录中的同级项）
  const dropdownHighlightedName = dropdownState
    ? segments[dropdownState.segmentIndex]?.name
    : undefined;

  return (
    <nav
      className="flex items-center gap-0.5 overflow-hidden"
      aria-label="文件路径导航"
      data-testid="breadcrumb"
    >
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const hasDropdown = dropdownState?.segmentIndex === index;

        return (
          <span key={`${segment.path}-${index}`} className="relative flex items-center gap-0.5">
            {index > 0 && (
              <span className="select-none text-muted-foreground/50" aria-hidden="true">
                ›
              </span>
            )}
            {isLast ? (
              <span
                className="truncate rounded px-1 text-xs font-medium text-foreground"
                data-testid="breadcrumb-active"
                title={segment.path}
              >
                {segment.name}
              </span>
            ) : (
              <button
                type="button"
                className="truncate rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={segment.path}
                onClick={(e) => handleSegmentClick(segment, index, e)}
                data-testid={`breadcrumb-segment-${index}`}
              >
                {segment.name}
              </button>
            )}
            {hasDropdown && (
              <BreadcrumbDropdown
                dirPath={dropdownState!.dirPath}
                anchorRect={dropdownState!.anchorRect}
                highlightedName={dropdownHighlightedName}
                onSelectFile={handleOpenFile}
                onClose={() => setDropdownState(null)}
              />
            )}
          </span>
        );
      })}
    </nav>
  );
}
