/**
 * RTL 层级树（issue 03 层级树可用性）。
 *
 * - 虚拟滚动（@tanstack/react-virtual）：SoC 级几万 instance 节点只渲染
 *   可视窗口附近的行。行源 = flattenVisibleTree（展开状态 + 子实例缓存
 *   → 扁平行，子实例未加载时产出加载占位行）。
 * - 树节点显示子树实例数徽标（instCount，主进程提炼时 O(n) 计算，
 *   无需展开即可判断子系统规模）。
 * - 跳转源码：解析 write_json src 属性 → Workbench 文件 tab 定位模块
 *   声明行（openFileDestination 复用行号 reveal 机制）。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Box, ExternalLink } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { useProjectStore } from '@renderer/stores/project';
import { openFileDestination, useWorkbenchStore } from '@renderer/stores/workbench';
import { flattenVisibleTree, parseSrcLocation, resolveSrcPath } from './design-tree-model';
import type { DesignInstRow } from '@main/rtl/types';

const ROW_HEIGHT = 24;

interface DesignTreeProps {
  projectId: string;
  node: DesignInstRow;
  /** 点击节点选中（issue 04：选中查看模块接口视图；与展开/收起同一交互） */
  onSelect?: (inst: DesignInstRow) => void;
  /** 当前选中实例 path（高亮行） */
  selectedPath?: string | null;
}

export function DesignTree({ projectId, node, onSelect, selectedPath }: DesignTreeProps) {
  const [childrenMap, setChildrenMap] = useState<Map<string, DesignInstRow[]>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const inflight = useRef<Set<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const open = useWorkbenchStore((s) => s.open);
  const projectRoot = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.currentProjectId)?.rootPath ?? null,
  );

  const rows = useMemo(
    () => flattenVisibleTree(node, expanded, childrenMap),
    [node, expanded, childrenMap],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => rows[index]!.key,
  });

  const toggle = useCallback(
    (target: DesignInstRow) => {
      const willExpand = !expanded.has(target.path);
      // 展开时懒加载子实例（tree 节点按需取数，SoC 级数据不整树进渲染进程）；
      // 加载失败收起节点清除占位行，再次展开即重试
      if (willExpand && !childrenMap.has(target.path) && !inflight.current.has(target.path)) {
        inflight.current.add(target.path);
        void trpc.rtl.getChildren
          .query({ projectId, path: target.path })
          .then((children) => {
            setChildrenMap((prev) => new Map(prev).set(target.path, children));
          })
          .catch(() => {
            setExpanded((prev) => {
              if (!prev.has(target.path)) return prev;
              const next = new Set(prev);
              next.delete(target.path);
              return next;
            });
          })
          .finally(() => {
            inflight.current.delete(target.path);
          });
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        if (willExpand) next.add(target.path);
        else next.delete(target.path);
        return next;
      });
    },
    [expanded, childrenMap, projectId],
  );

  const jumpToSource = useCallback(
    (target: DesignInstRow) => {
      if (!target.src) return;
      const loc = parseSrcLocation(target.src);
      const absPath = resolveSrcPath(loc.path, projectRoot);
      const name = absPath.split(/[\\/]/).pop() ?? absPath;
      openFileDestination(open, absPath, name, loc.line !== null ? { line: loc.line } : undefined);
    },
    [open, projectRoot],
  );

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      data-testid="design-tree-scroll"
      role="tree"
      aria-label="RTL 层级树"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]!;
          return (
            <div
              key={vi.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {row.kind === 'node' ? (
                <NodeRow
                  node={row.node}
                  level={row.level}
                  expanded={expanded.has(row.node.path)}
                  selected={selectedPath === row.node.path}
                  onToggle={() => toggle(row.node)}
                  onSelect={() => onSelect?.(row.node)}
                  onJump={() => jumpToSource(row.node)}
                />
              ) : (
                <LoadingRow level={row.level} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  level,
  expanded,
  selected,
  onToggle,
  onSelect,
  onJump,
}: {
  node: DesignInstRow;
  level: number;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onJump: () => void;
}) {
  // instCount === 1 → leaf（黑盒/无用户模块子实例），无可展开子级
  const leaf = node.instCount <= 1;
  return (
    <div
      role="treeitem"
      aria-expanded={leaf ? undefined : expanded}
      aria-selected={selected}
      tabIndex={0}
      data-testid="design-tree-node"
      data-path={node.path}
      onClick={() => {
        onToggle();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
          onSelect();
        }
      }}
      className={cn(
        'flex h-full cursor-pointer items-center gap-1.5 rounded px-2 text-xs transition-colors',
        'hover:bg-accent focus-visible:outline focus-visible:outline-primary/60',
        selected && 'bg-accent ring-1 ring-primary/40',
      )}
      style={{ paddingLeft: 8 + level * 16 }}
    >
      {leaf ? (
        <span className="inline-block size-3.5 shrink-0" />
      ) : expanded ? (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <Box className="size-3.5 shrink-0 text-primary/70" />
      <span className="truncate font-medium text-foreground">{node.name}</span>
      <span className="truncate text-[10px] text-muted-foreground">{node.module}</span>
      <span
        className="ml-auto shrink-0 text-[10px] text-muted-foreground"
        data-testid="design-tree-inst-count"
        title="子树实例数（含自身）"
      >
        {node.instCount} 实例
      </span>
      {node.src && (
        <button
          type="button"
          data-testid="design-tree-jump"
          title={`打开源码：${node.src}`}
          aria-label={`打开源码：${node.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onJump();
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}

function LoadingRow({ level }: { level: number }) {
  return (
    <div
      className="flex h-full items-center gap-1.5 text-[10px] text-muted-foreground"
      style={{ paddingLeft: 8 + level * 16 + 20 }}
    >
      <span className="inline-block animate-pulse" aria-label="加载中">
        ···
      </span>
    </div>
  );
}
