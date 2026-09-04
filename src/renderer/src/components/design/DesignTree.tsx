/**
 * RTL 层级树（issue 02 tracer bullet）。
 *
 * 数据来自 rtl-router.getChildren 的懒加载子树查询（渲染端零解析：
 * 主进程 SQLite 直出提炼行，SoC 级数据不整树进渲染进程）。
 * 虚拟滚动优化在 issue 03（tree-usability）落实。
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Box } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { DesignInstRow } from '@main/rtl/types';

interface DesignTreeProps {
  projectId: string;
  node: DesignInstRow;
}

export function DesignTree({ projectId, node }: DesignTreeProps) {
  return <TreeNode projectId={projectId} node={node} level={0} />;
}

function TreeNode({ projectId, node, level }: DesignTreeProps & { level: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DesignInstRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (children === null && !loading) {
      setLoading(true);
      try {
        const rows = await trpc.rtl.getChildren.query({ projectId, path: node.path });
        setChildren(rows);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  };

  return (
    <div>
      <button
        type="button"
        data-testid="design-tree-node"
        onClick={() => void toggle()}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-xs transition-colors',
          'hover:bg-accent',
        )}
        style={{ paddingLeft: 8 + level * 16 }}
      >
        {children !== null && children.length === 0 ? (
          <span className="inline-block size-3.5 shrink-0" />
        ) : loading ? (
          <RefreshDots />
        ) : expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Box className="size-3.5 shrink-0 text-primary/70" />
        <span className="truncate font-medium text-foreground">{node.name}</span>
        <span className="truncate text-[10px] text-muted-foreground">{node.module}</span>
        {children !== null && children.length > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{children.length}</span>
        )}
      </button>
      {expanded && children !== null && (
        <div role="group" aria-label={`${node.name} 子实例`}>
          {children.map((child) => (
            <TreeNode key={child.path} projectId={projectId} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function RefreshDots() {
  return (
    <span className="inline-block size-3.5 shrink-0 animate-pulse text-muted-foreground" aria-label="加载中">
      ···
    </span>
  );
}
