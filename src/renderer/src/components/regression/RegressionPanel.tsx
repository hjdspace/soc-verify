import { useEffect, useState, useMemo } from 'react';
import {
  Play,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Cpu,
  List,
  FolderClosed,
  Loader2,
  Settings,
  Terminal as TerminalIcon,
  CircleDot,
  X,
} from 'lucide-react';
import { useRegressionStore } from '@renderer/stores/regression';
import { useProjectStore } from '@renderer/stores/project';
import { useEnvStore } from '@renderer/stores/env';
import { cn } from '@renderer/lib/utils';
import type {
  RegressionItem,
  RegressionList,
  RegressionGroup,
  RegressionRunOptions,
  RegressionHistoryEntry,
} from '@shared/types';

// ── Run options dialog ────────────────────────────────

function RunOptionsDialog({
  item,
  onConfirm,
  onCancel,
}: {
  item: RegressionItem;
  onConfirm: (options: RegressionRunOptions) => void;
  onCancel: () => void;
}) {
  const isList = item.type === 'list';
  const list = isList ? (item as RegressionList) : null;
  const allTags = list?.tagSet ?? [];

  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedNonTags, setSelectedNonTags] = useState<Set<string>>(new Set());
  const [failMode, setFailMode] = useState(false);
  const [coverage, setCoverage] = useState(false);
  const [regrWork, setRegrWork] = useState('');
  const [merge, setMerge] = useState(false);

  const toggleTag = (tag: string, set: Set<string>, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setter(next);
  };

  const handleConfirm = () => {
    const options: RegressionRunOptions = {
      tags: selectedTags.size > 0 ? Array.from(selectedTags) : undefined,
      nonTags: selectedNonTags.size > 0 ? Array.from(selectedNonTags) : undefined,
      failMode: failMode || undefined,
      coverage: coverage || undefined,
      regrWork: regrWork.trim() || undefined,
      merge: merge && coverage ? true : undefined,
    };
    onConfirm(options);
  };

  const fileName = item.filePath.split(/[/\\]/).pop() ?? item.filePath;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="w-96 rounded-lg border border-border bg-popover p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">运行回归</span>
          <button onClick={onCancel} className="rounded p-1 text-muted-foreground hover:bg-accent">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mb-3 rounded-md border border-border/50 bg-secondary/20 px-3 py-2">
          <div className="text-[10px] text-muted-foreground">文件</div>
          <div className="truncate font-mono text-xs text-foreground">{fileName}</div>
          {item.type === 'list' && list && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              {list.onCount} ON / {list.offCount} OFF / {list.entries.length} 总行数
            </div>
          )}
        </div>

        {/* Tags */}
        {allTags.length > 0 && (
          <>
            <div className="mb-2">
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                Tag（只跑选中的标签）
              </div>
              <div className="flex flex-wrap gap-1">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag, selectedTags, setSelectedTags)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[10px] transition-colors',
                      selectedTags.has(tag)
                        ? 'bg-primary/20 text-primary'
                        : 'bg-secondary text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-2">
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                Non-Tag（排除选中的标签）
              </div>
              <div className="flex flex-wrap gap-1">
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag, selectedNonTags, setSelectedNonTags)}
                    className={cn(
                      'rounded px-2 py-0.5 text-[10px] transition-colors',
                      selectedNonTags.has(tag)
                        ? 'bg-status-fail/20 text-status-fail-foreground'
                        : 'bg-secondary text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Checkboxes */}
        <div className="mb-3 space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input type="checkbox" checked={failMode} onChange={(e) => setFailMode(e.target.checked)} className="h-3 w-3" />
            <span>Fail mode（只跑失败用例）</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input type="checkbox" checked={coverage} onChange={(e) => setCoverage(e.target.checked)} className="h-3 w-3" />
            <span>Coverage（收集覆盖率）</span>
          </label>
          <label className={cn('flex items-center gap-2 text-xs', coverage ? 'text-foreground' : 'text-muted-foreground')}>
            <input
              type="checkbox"
              checked={merge}
              onChange={(e) => setMerge(e.target.checked)}
              disabled={!coverage}
              className="h-3 w-3"
            />
            <span>Merge（回归完成后自动 coverage merge）</span>
          </label>
        </div>

        {/* regr_work */}
        <div className="mb-3">
          <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">
            Regression Work Dir（可选）
          </label>
          <input
            type="text"
            value={regrWork}
            onChange={(e) => setRegrWork(e.target.value)}
            placeholder="-regr_work"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent">
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="flex items-center gap-1 rounded bg-primary/10 px-3 py-1 text-xs text-primary hover:bg-primary/20"
          >
            <Play className="h-3 w-3" />
            运行
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Subsystem group ───────────────────────────────────

function SubsysGroup({
  subsys,
  items,
  expandedSubsys,
  toggleSubsys,
  expandedItems,
  toggleItem,
  onRun,
}: {
  subsys: string;
  items: RegressionItem[];
  expandedSubsys: Set<string>;
  toggleSubsys: (name: string) => void;
  expandedItems: Set<string>;
  toggleItem: (path: string) => void;
  onRun: (item: RegressionItem) => void;
}) {
  const isExpanded = expandedSubsys.has(subsys);
  const listCount = items.filter((i) => i.type === 'list').length;
  const groupCount = items.filter((i) => i.type === 'group').length;

  return (
    <div>
      <button
        onClick={() => toggleSubsys(subsys)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-accent/50"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
        )}
        <Cpu className="h-3 w-3 shrink-0 text-primary/70" />
        <span className="truncate font-medium">{subsys}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {listCount > 0 && `${listCount} list`}
          {groupCount > 0 && ` · ${groupCount} grp`}
        </span>
      </button>

      {isExpanded && (
        <div className="pb-1 pl-4">
          {items.map((item) => (
            <RegressionItemRow
              key={item.filePath}
              item={item}
              expanded={expandedItems.has(item.filePath)}
              onToggle={() => toggleItem(item.filePath)}
              onRun={() => onRun(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Regression item row ───────────────────────────────

function RegressionItemRow({
  item,
  expanded,
  onToggle,
  onRun,
}: {
  item: RegressionItem;
  expanded: boolean;
  onToggle: () => void;
  onRun: () => void;
}) {
  const fileName = item.filePath.split(/[/\\]/).pop() ?? item.filePath;
  const isList = item.type === 'list';
  const list = isList ? (item as RegressionList) : null;
  const group = !isList ? (item as RegressionGroup) : null;

  const { parseList, parseGroup, parsedLists, parsedGroups, parsingListPath } = useRegressionStore();

  useEffect(() => {
    if (expanded && isList && list && !parsedLists.has(item.filePath)) {
      void parseList(item.filePath);
    }
    if (expanded && !isList && group && !parsedGroups.has(item.filePath)) {
      void parseGroup(item.filePath);
    }
  }, [expanded, isList, group, item.filePath, list, parseList, parseGroup, parsedLists, parsedGroups]);

  const parsedList = list ? parsedLists.get(item.filePath) : undefined;
  const parsedGroup = group ? parsedGroups.get(item.filePath) : undefined;

  return (
    <div>
      <div className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/30">
        <button onClick={onToggle} className="flex flex-1 items-center gap-1 text-left text-xs">
          {expanded ? (
            <ChevronDown className="h-2.5 w-2.5 shrink-0 opacity-50" />
          ) : (
            <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-50" />
          )}
          {isList ? (
            <List className="h-3 w-3 shrink-0 text-primary/60" />
          ) : (
            <FolderClosed className="h-3 w-3 shrink-0 text-warning-foreground/60" />
          )}
          <span className="truncate font-mono text-[11px]">{fileName}</span>
          {list && (
            <span className="shrink-0 text-[9px] text-muted-foreground">
              {list.onCount}ON/{list.offCount}OFF
            </span>
          )}
          {group && (
            <span className="shrink-0 text-[9px] text-muted-foreground">
              {group.refPaths.length} refs
            </span>
          )}
        </button>
        <button
          onClick={onRun}
          title="运行回归"
          className="shrink-0 rounded p-0.5 opacity-40 transition-opacity hover:bg-foreground/10 hover:opacity-100"
        >
          <Play className="h-3 w-3 text-primary" />
        </button>
      </div>

      {/* Expanded content */}
      {expanded && isList && (
        <div className="ml-6 pb-1">
          {parsingListPath === item.filePath ? (
            <div className="flex items-center gap-1 py-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              解析中...
            </div>
          ) : parsedList ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-border/30 text-left text-muted-foreground">
                    <th className="px-1 py-0.5">On</th>
                    <th className="px-1 py-0.5">Block</th>
                    <th className="px-1 py-0.5">Case</th>
                    <th className="px-1 py-0.5">Seed</th>
                    <th className="px-1 py-0.5">Iter</th>
                    <th className="px-1 py-0.5">Tags</th>
                    <th className="px-1 py-0.5">Pri</th>
                  </tr>
                </thead>
                <tbody>
                  {parsedList.entries.map((entry, i) => (
                    <tr
                      key={i}
                      className={cn(
                        'border-b border-border/20',
                        entry.enabled ? 'text-foreground' : 'text-muted-foreground/50',
                      )}
                    >
                      <td className="px-1 py-0.5">
                        {entry.enabled ? (
                          <span className="text-status-pass-foreground">ON</span>
                        ) : (
                          <span className="text-muted-foreground">OFF</span>
                        )}
                      </td>
                      <td className="px-1 py-0.5 font-mono">{entry.block}</td>
                      <td className="px-1 py-0.5 font-mono">{entry.caseName}</td>
                      <td className="px-1 py-0.5 font-mono">{entry.seed}</td>
                      <td className="px-1 py-0.5 font-mono">{entry.iterative}</td>
                      <td className="px-1 py-0.5">
                        {entry.tags.map((tag) => (
                          <span key={tag} className="mr-0.5 rounded bg-secondary px-1 text-[9px]">
                            {tag}
                          </span>
                        ))}
                      </td>
                      <td className="px-1 py-0.5">{entry.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-1 text-[10px] text-muted-foreground">点击展开查看详情</div>
          )}
        </div>
      )}

      {expanded && !isList && (
        <div className="ml-6 pb-1">
          {parsedGroup ? (
            <div className="space-y-0.5">
              {parsedGroup.refPaths.map((ref, i) => (
                <div key={i} className="truncate font-mono text-[10px] text-muted-foreground">
                  {ref}
                </div>
              ))}
              {parsedGroup.resolved.length > 0 && (
                <div className="mt-1 text-[9px] text-muted-foreground">
                  解析到 {parsedGroup.resolved.filter((r) => r.type === 'list').length} list /{' '}
                  {parsedGroup.resolved.filter((r) => r.type === 'group').length} nested group
                </div>
              )}
            </div>
          ) : (
            <div className="py-1 text-[10px] text-muted-foreground">解析中...</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── History row ───────────────────────────────────────

function HistoryRow({ entry }: { entry: RegressionHistoryEntry }) {
  const [showOutput, setShowOutput] = useState(false);
  const fileName = entry.filePath.split(/[/\\]/).pop() ?? entry.filePath;

  const statusColor = {
    running: 'text-status-running-foreground',
    completed: 'text-status-pass-foreground',
    aborted: 'text-status-aborted-foreground',
    failed: 'text-status-fail-foreground',
  }[entry.status];

  return (
    <div className="rounded-md border border-border/30 bg-secondary/20 px-2 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <CircleDot className={cn('h-2.5 w-2.5 shrink-0', statusColor, entry.status === 'running' && 'animate-pulse')} />
        <span className="truncate font-mono text-[11px] text-foreground">{fileName}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{entry.subsys}</span>
        <span className={cn('shrink-0 text-[10px] font-medium', statusColor)}>{entry.status}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {new Date(entry.submittedAt).toLocaleString()}
        </span>
        <button
          onClick={() => setShowOutput(!showOutput)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="查看输出"
        >
          <TerminalIcon className="h-3 w-3" />
        </button>
      </div>
      {showOutput && entry.stdoutTail && (
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/50 p-2 text-[9px] text-muted-foreground">
          {entry.stdoutTail}
        </pre>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────

export function RegressionPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const config = useEnvStore((s) => s.config);
  const loadEnvConfig = useEnvStore((s) => s.loadConfig);
  const projEnv = config?.envVars?.PROJ_ENV;

  const discovery = useRegressionStore((s) => s.discovery);
  const discoveryLoading = useRegressionStore((s) => s.discoveryLoading);
  const discoveryError = useRegressionStore((s) => s.discoveryError);
  const discover = useRegressionStore((s) => s.discover);
  const history = useRegressionStore((s) => s.history);
  const loadHistory = useRegressionStore((s) => s.loadHistory);
  const runRegression = useRegressionStore((s) => s.runRegression);

  const [expandedSubsys, setExpandedSubsys] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [runDialogItem, setRunDialogItem] = useState<RegressionItem | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Load env config, discovery and history when project changes
  useEffect(() => {
    if (currentProjectId) {
      void loadEnvConfig(currentProjectId);
      void discover(currentProjectId);
      void loadHistory(currentProjectId);
    }
  }, [currentProjectId, discover, loadHistory, loadEnvConfig]);

  const toggleSubsys = (name: string) => {
    setExpandedSubsys((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleItem = (path: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleRunConfirm = (options: RegressionRunOptions) => {
    if (runDialogItem && currentProjectId) {
      void runRegression(currentProjectId, runDialogItem.filePath, runDialogItem.subsys, options);
    }
    setRunDialogItem(null);
  };

  // Filter by search
  const filteredDiscovery = useMemo(() => {
    if (!searchQuery.trim()) return discovery;
    const q = searchQuery.trim().toLowerCase();
    return discovery
      .map(({ subsys, items }) => ({
        subsys,
        items: items.filter((item) => {
          const fileName = item.filePath.split(/[/\\]/).pop() ?? item.filePath;
          return fileName.toLowerCase().includes(q) || subsys.toLowerCase().includes(q);
        }),
      }))
      .filter(({ items }) => items.length > 0);
  }, [discovery, searchQuery]);

  // No project
  if (!currentProjectId) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        请先打开项目
      </div>
    );
  }

  // No PROJ_ENV
  if (!projEnv) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Settings className="h-8 w-8 opacity-40" />
        <p>未配置 PROJ_ENV 环境变量</p>
        <p className="text-[11px]">请在环境设置中配置 PROJ_ENV 后使用回归功能</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">回归套件</span>
          {discovery.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {discovery.length} 子系统 · {discovery.reduce((acc, s) => acc + s.items.length, 0)} 项
            </span>
          )}
        </div>
        <button
          onClick={() => currentProjectId && discover(currentProjectId, true)}
          disabled={discoveryLoading}
          className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
        >
          <RefreshCw className={cn('h-3 w-3', discoveryLoading && 'animate-spin')} />
          刷新
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索回归列表..."
          className="w-full rounded border border-border/50 bg-background/60 px-2 py-1 text-xs outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Discovery tree */}
      {discoveryLoading ? (
        <div className="flex items-center gap-1.5 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在扫描回归目录...
        </div>
      ) : discoveryError ? (
        <div className="py-4 text-xs">
          <div className="font-medium text-destructive">扫描失败</div>
          <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{discoveryError}</div>
          <button
            onClick={() => currentProjectId && discover(currentProjectId, true)}
            className="mt-2 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-primary hover:bg-accent"
          >
            <RefreshCw className="h-3 w-3" />
            重新扫描
          </button>
        </div>
      ) : filteredDiscovery.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          {searchQuery ? '未找到匹配的回归列表' : '未发现回归列表'}
        </div>
      ) : (
        <div className="mb-4 space-y-0.5">
          {filteredDiscovery.map(({ subsys, items }) => (
            <SubsysGroup
              key={subsys}
              subsys={subsys}
              items={items}
              expandedSubsys={expandedSubsys}
              toggleSubsys={toggleSubsys}
              expandedItems={expandedItems}
              toggleItem={toggleItem}
              onRun={setRunDialogItem}
            />
          ))}
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground">运行历史</span>
            <span className="text-[10px] text-muted-foreground">{history.length} 条</span>
          </div>
          <div className="space-y-1.5">
            {history.slice(0, 20).map((entry) => (
              <HistoryRow key={entry.runId} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {/* Run options dialog */}
      {runDialogItem && (
        <RunOptionsDialog
          item={runDialogItem}
          onConfirm={handleRunConfirm}
          onCancel={() => setRunDialogItem(null)}
        />
      )}
    </div>
  );
}
