import {
  ChevronRight,
  FileText,
  CircleDot,
  Play,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '@renderer/lib/utils';

// ─── Types ──────────────────────────────────────────────

export type CaseData = {
  id?: string;
  name: string;
  subsys: string;
  path: string;
  status?: string;
  duration?: number;
  description?: string;
  baseCase?: string;
  filePath?: string;
  base?: string;
  block?: string;
  postSim?: boolean;
};

export type CaseTreeNode = {
  type: 'file' | 'case';
  name: string;
  path: string;
  caseData?: CaseData;
  children: CaseTreeNode[];
};

// ─── Status colors ──────────────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  pass: 'text-status-pass-foreground',
  fail: 'text-status-fail-foreground',
  running: 'text-status-running-foreground animate-pulse',
  pending: 'text-status-pending-foreground',
  error: 'text-status-fail-foreground',
  aborted: 'text-status-aborted-foreground',
};

// ─── Case ID helpers ────────────────────────────────────

/**
 * 生成用例的唯一标识符。
 *
 * `path` 在同一 file group 下可能不唯一（多个 case 共享同一文件路径），
 * 因此用 `path + name` 组合确保唯一性；如果 `id` 存在则优先使用。
 */
export function getCaseId(caseData: CaseData): string {
  return caseData.id ?? `${caseData.path}::${caseData.name}`;
}

// ─── buildCaseTree ──────────────────────────────────────

/**
 * 从扁平用例列表构建用例树。
 *
 * 树结构：
 *   文件节点（按 filePath 分组）
 *     ├─ 根用例（无 baseCase）
 *     │   ├─ 子用例（baseCase 指向根用例）
 *     │   └─ ...
 *     └─ ...
 *
 * 如果用例没有 filePath 信息，回退为扁平结构（每个用例直接作为根节点）。
 */
export function buildCaseTree(cases: CaseData[]): CaseTreeNode[] {
  // 检查是否有树结构信息
  const hasTreeInfo = cases.some((c) => c.filePath);

  if (!hasTreeInfo) {
    // 无树信息，回退为扁平列表
    return cases.map((c) => ({
      type: 'case' as const,
      name: c.name,
      path: c.path,
      caseData: c,
      children: [],
    }));
  }

  // 按 filePath 分组
  const fileGroups = new Map<string, CaseData[]>();
  for (const c of cases) {
    const fp = c.filePath ?? c.path;
    if (!fileGroups.has(fp)) {
      fileGroups.set(fp, []);
    }
    fileGroups.get(fp)!.push(c);
  }

  const tree: CaseTreeNode[] = [];

  for (const [filePath, fileCases] of fileGroups) {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const fileNode: CaseTreeNode = {
      type: 'file',
      name: fileName,
      path: filePath,
      children: [],
    };

    // 用例名 → 树节点映射（用于查找父节点）
    const caseMap = new Map<string, CaseTreeNode>();

    // 第一遍：创建根用例（无 baseCase）
    for (const c of fileCases) {
      if (!c.baseCase) {
        const node: CaseTreeNode = {
          type: 'case',
          name: c.name,
          path: c.path,
          caseData: c,
          children: [],
        };
        caseMap.set(c.name, node);
        fileNode.children.push(node);
      }
    }

    // 第二遍：添加子用例
    for (const c of fileCases) {
      if (c.baseCase) {
        let parentNode = caseMap.get(c.baseCase);
        if (!parentNode) {
          // 父用例不存在，创建占位节点
          parentNode = {
            type: 'case',
            name: c.baseCase,
            path: '',
            caseData: { ...c, name: c.baseCase, baseCase: undefined },
            children: [],
          };
          caseMap.set(c.baseCase, parentNode);
          fileNode.children.push(parentNode);
        }
        const childNode: CaseTreeNode = {
          type: 'case',
          name: c.name,
          path: c.path,
          caseData: c,
          children: [],
        };
        caseMap.set(c.name, childNode);
        parentNode.children.push(childNode);
      }
    }

    tree.push(fileNode);
  }

  return tree;
}

// ─── 大列表虚拟化 ────────────────────────────────────────

/** 树行高（py-0.5 + text-xs ≈ 24px），虚拟切片的滚动量纲 */
const TREE_ROW_HEIGHT = 24;
/** 可见区上下额外渲染的行数，滚动时不露白 */
const TREE_OVERSCAN = 10;
/** 超过该阈值才启用虚拟切片；小列表全量渲染避免测量开销 */
const VIRTUALIZE_THRESHOLD = 100;

type VirtualChildrenProps = {
  /** 该文件节点下的直接子项（CaseTreeItem 列表） */
  children: React.ReactNode[];
  /** 展开状态变化时父级滚动容器可能重排，用 key 变化触发重新测量 */
};

/**
 * 文件节点的直接子项虚拟列表。
 *
 * 万级用例场景下一个 cfg 文件可含数千子项，全量挂载 DOM 会导致
 * 首帧构建与样式计算阻塞（切换视图卡顿主因）。这里按滚动容器
 * 可视高度切片渲染：仅渲染可见区 ± overscan 的行，其余以等高
 * spacer 占位，保证滚动条与实际内容高度一致。
 *
 * 用 ResizeObserver 而非固定视口高度，适配左栏拖拽变宽/窗口缩放。
 */
function VirtualChildren({ children }: VirtualChildrenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 向上找到可滚动的父容器（面板内容区）测量视口并监听滚动
    const scroller = findScrollParent(el);
    if (!scroller) return;

    const updateViewport = () => setViewportHeight(scroller.clientHeight);
    const onScroll = () => setScrollTop(scroller.scrollTop);

    updateViewport();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scroller);

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, []);

  const total = children.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
  const endIndex = Math.min(total, Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN);
  const visible = children.slice(startIndex, endIndex);

  return (
    <div ref={containerRef} className="relative">
      {startIndex > 0 && (
        <div style={{ height: startIndex * TREE_ROW_HEIGHT }} aria-hidden />
      )}
      {visible}
      {endIndex < total && (
        <div style={{ height: (total - endIndex) * TREE_ROW_HEIGHT }} aria-hidden />
      )}
    </div>
  );
}

/** 沿 DOM 向上找最近的可滚动祖先（overflow-y auto/scroll） */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

// ─── CaseTreeItem ───────────────────────────────────────

export type CaseTreeItemProps = {
  node: CaseTreeNode;
  level: number;
  expandedFiles: Set<string>;
  expandedCases: Set<string>;
  toggleFile: (path: string) => void;
  toggleCase: (id: string) => void;
  batchMode: boolean;
  selectedCases: Set<string>;
  selectedCaseId: string | null;
  toggleCaseSelection: (path: string) => void;
  onCaseSelect: (caseData: CaseData) => void;
  onContextMenu: (e: React.MouseEvent, caseData: CaseData) => void;
  onFileContextMenu: (e: React.MouseEvent, fileNode: CaseTreeNode) => void;
  onRunCase: (caseData: CaseData) => void;
};

export const CaseTreeItem = memo(function CaseTreeItem({
  node,
  level,
  expandedFiles,
  expandedCases,
  toggleFile,
  toggleCase,
  batchMode,
  selectedCases,
  selectedCaseId,
  toggleCaseSelection,
  onCaseSelect,
  onContextMenu,
  onFileContextMenu,
  onRunCase,
}: CaseTreeItemProps) {
  const paddingLeft = level * 12 + 8;

  if (node.type === 'file') {
    const isExpanded = expandedFiles.has(node.path);
    const childItems = node.children.map((child, idx) => (
      <div
        key={child.caseData ? getCaseId(child.caseData) : `${child.path}::${child.name}::${idx}`}
        className="tree-item-enter animate-[tree-item-enter_200ms_var(--ease-out)_both]"
        style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
      >
        <CaseTreeItem
          node={child}
          level={level + 1}
          expandedFiles={expandedFiles}
          expandedCases={expandedCases}
          toggleFile={toggleFile}
          toggleCase={toggleCase}
          batchMode={batchMode}
          selectedCases={selectedCases}
          selectedCaseId={selectedCaseId}
          toggleCaseSelection={toggleCaseSelection}
          onCaseSelect={onCaseSelect}
          onContextMenu={onContextMenu}
          onFileContextMenu={onFileContextMenu}
          onRunCase={onRunCase}
        />
      </div>
    ));
    return (
      <div>
        <button
          onClick={() => toggleFile(node.path)}
          onContextMenu={(e) => onFileContextMenu(e, node)}
          className="flex w-full items-center gap-1 rounded py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50"
          style={{ paddingLeft: `${paddingLeft}px` }}
        >
          <ChevronRight
            className={cn(
              'h-2.5 w-2.5 shrink-0 opacity-50 transition-transform duration-[150ms] ease-[var(--ease-out)]',
              isExpanded && 'rotate-90',
            )}
          />
          <FileText className="h-2.5 w-2.5 shrink-0 opacity-40" />
          <span className="truncate">{node.name}</span>
          <span className="ml-auto shrink-0 text-[9px] opacity-50">{node.children.length}</span>
        </button>
        <div
          className={cn(
            'grid transition-all duration-[var(--duration-normal)] ease-[var(--ease-out)]',
            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            {node.children.length > VIRTUALIZE_THRESHOLD ? (
              isExpanded && <VirtualChildren>{childItems}</VirtualChildren>
            ) : (
              childItems
            )}
          </div>
        </div>
      </div>
    );
  }

  // Case node
  const caseId = node.caseData ? getCaseId(node.caseData) : node.name;
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedCases.has(caseId);
  const isSelected = batchMode && selectedCases.has(caseId);
  const isActiveCase = !batchMode && selectedCaseId === caseId;

  return (
    <div>
      <div
        className={cn(
          'group relative flex items-center gap-1 rounded py-0.5 text-xs transition-colors',
          isActiveCase
            ? 'bg-primary/15 text-primary'
            : isSelected
              ? 'bg-primary/20 text-foreground'
              : 'text-foreground/70 hover:bg-foreground/10',
          (batchMode || (!batchMode && node.caseData)) && 'cursor-pointer',
        )}
        style={{ paddingLeft: `${paddingLeft}px` }}
        onClick={() => {
          if (batchMode) {
            if (node.caseData) toggleCaseSelection(caseId);
          } else if (node.caseData) {
            onCaseSelect(node.caseData);
          }
        }}
        onContextMenu={(e) => !batchMode && node.caseData && onContextMenu(e, node.caseData)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleCase(caseId);
            }}
            className="shrink-0"
          >
            <ChevronRight
              className={cn(
                'h-2.5 w-2.5 opacity-50 transition-transform duration-[150ms] ease-[var(--ease-out)]',
                isExpanded && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
        {batchMode && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleCaseSelection(caseId)}
            className="h-2.5 w-2.5 shrink-0"
          />
        )}
        <CircleDot
          className={cn('h-2.5 w-2.5 shrink-0', STATUS_COLORS[node.caseData?.status ?? 'pending'])}
        />
        <span className="truncate">{node.name}</span>
        {node.caseData?.postSim && (
          <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-600 dark:text-amber-400">
            后仿
          </span>
        )}
        {node.caseData?.baseCase && (
          <span
            className={cn(
              'shrink-0 text-[9px]',
              isActiveCase ? 'opacity-60' : 'opacity-40',
            )}
          >
            :{node.caseData.baseCase}
          </span>
        )}
        {!batchMode && node.caseData && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRunCase(node.caseData!);
            }}
            className="ml-auto shrink-0 rounded p-0.5 opacity-40 transition-opacity hover:bg-foreground/10 hover:opacity-100"
            title="运行仿真"
          >
            <Play className="h-3 w-3 text-primary" />
          </button>
        )}
        {isActiveCase && (
          <span className="absolute left-0 top-0 bottom-0 w-0.5 rounded-l bg-primary" />
        )}
      </div>
      {hasChildren && (
        <div
          className={cn(
            'grid transition-all duration-[var(--duration-normal)] ease-[var(--ease-out)]',
            isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            {node.children.map((child, idx) => (
              <div
                key={child.caseData ? getCaseId(child.caseData) : `${child.path}::${child.name}::${idx}`}
                className="tree-item-enter animate-[tree-item-enter_200ms_var(--ease-out)_both]"
                style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
              >
                <CaseTreeItem
                  node={child}
                  level={level + 1}
                  expandedFiles={expandedFiles}
                  expandedCases={expandedCases}
                  toggleFile={toggleFile}
                  toggleCase={toggleCase}
                  batchMode={batchMode}
                  selectedCases={selectedCases}
                  selectedCaseId={selectedCaseId}
                  toggleCaseSelection={toggleCaseSelection}
                  onCaseSelect={onCaseSelect}
                  onContextMenu={onContextMenu}
                  onFileContextMenu={onFileContextMenu}
                  onRunCase={onRunCase}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
