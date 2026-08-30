/**
 * 回归运行配置模态（ADR 0029 决策 2/3/6/7）。
 *
 * 点回归卡片弹出：左栏 Regression Item 搜索/过滤列表，右栏 entry 只读预览 +
 * 选项表单 + 只读命令预览（与执行共用 buildRegrCommand）+ 运行按钮。
 * 选择单位为单个 Item（list 或 group）；group 选中时递归解析引用并聚合 tagSet。
 * 运行后由调用方关闭模态，不发生页面导航（终端按需打开）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Play, X, Copy, Check, ChevronDown, ChevronRight, List as ListIcon, FolderClosed } from 'lucide-react';
import { useRegressionStore } from '@renderer/stores/regression';
import { useProjectStore } from '@renderer/stores/project';
import { buildRegrCommand } from '@shared/regression-command';
import type { RegressionItem, RegressionList, RegressionRunOptions } from '@shared/types';
import { SegmentedControl } from '@renderer/components/ui/SegmentedControl';
import { cn } from '@renderer/lib/utils';

type TypeFilter = 'all' | 'list' | 'group';

/** 类型分段选项（SegmentedControl 段序即此序） */
const TYPE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'list', label: '列表' },
  { value: 'group', label: '组' },
] as const satisfies ReadonlyArray<{ value: TypeFilter; label: string }>;

/** 文件路径 → 文件名（item 行 / 摘要共用） */
function baseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

export function RunConfigModal({
  subsys,
  items,
  onClose,
}: {
  subsys: string;
  items: RegressionItem[];
  onClose: () => void;
}) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const runRegression = useRegressionStore((s) => s.runRegression);
  const parseList = useRegressionStore((s) => s.parseList);
  const parseGroup = useRegressionStore((s) => s.parseGroup);
  const parsedLists = useRegressionStore((s) => s.parsedLists);
  const parsedGroups = useRegressionStore((s) => s.parsedGroups);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [entryPreviewOpen, setEntryPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);

  // ── 选项表单 ──
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [selectedNonTags, setSelectedNonTags] = useState<Set<string>>(new Set());
  const [failMode, setFailMode] = useState(false);
  const [coverage, setCoverage] = useState(false);
  const [regrWork, setRegrWork] = useState('');
  const [merge, setMerge] = useState(false);
  const [dashboard, setDashboard] = useState('');

  const selected = items.find((it) => it.filePath === selectedPath) ?? null;

  /** tag 过滤候选：子系统内全部 list 的 tagSet 并集 */
  const filterTags = useMemo(() => {
    const tags = new Set<string>();
    for (const it of items) {
      if (it.type === 'list') for (const t of it.tagSet) tags.add(t);
    }
    return [...tags].sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      if (tagFilter) {
        if (it.type === 'list') {
          if (!it.tagSet.includes(tagFilter)) return false;
        } else {
          // group：仅在引用列表（已解析加载）的聚合 tagSet 命中时匹配；未加载不匹配
          const resolved = parsedGroups.get(it.filePath)?.resolved;
          if (!resolved) return false;
          const hit = resolved.some(
            (ref) => ref.type === 'list' && parsedLists.get(ref.path)?.tagSet.includes(tagFilter),
          );
          if (!hit) return false;
        }
      }
      if (!q) return true;
      return baseName(it.filePath).toLowerCase().includes(q);
    });
  }, [items, search, typeFilter, tagFilter, parsedGroups, parsedLists]);

  // ── group 引用解析 + 引用列表 tagSet 聚合 ──
  const groupResolved =
    selected?.type === 'group' ? parsedGroups.get(selected.filePath)?.resolved ?? null : null;

  useEffect(() => {
    if (selected?.type === 'group') void parseGroup(selected.filePath);
  }, [selected, parseGroup]);

  useEffect(() => {
    if (!groupResolved) return;
    for (const ref of groupResolved) {
      if (ref.type === 'list') void parseList(ref.path);
    }
  }, [groupResolved, parseList]);

  /** tag 候选：list 用自身 tagSet；group 用引用列表聚合 tagSet（未加载完成时为空） */
  const candidateTags = useMemo(() => {
    if (!selected) return [];
    if (selected.type === 'list') return selected.tagSet;
    if (!groupResolved) return [];
    const tags = new Set<string>();
    for (const ref of groupResolved) {
      if (ref.type !== 'list') continue;
      for (const t of parsedLists.get(ref.path)?.tagSet ?? []) tags.add(t);
    }
    return [...tags];
  }, [selected, groupResolved, parsedLists]);

  const buildOptions = (): RegressionRunOptions => ({
    tags: selectedTags.size > 0 ? [...selectedTags] : undefined,
    nonTags: selectedNonTags.size > 0 ? [...selectedNonTags] : undefined,
    failMode: failMode || undefined,
    coverage: coverage || undefined,
    regrWork: regrWork.trim() || undefined,
    merge: merge && coverage ? true : undefined,
    dashboard: dashboard.trim() || undefined,
  });

  const command = useMemo(
    () => (selected ? buildRegrCommand(selected.filePath, buildOptions()) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildOptions 闭包读取表单 state，依赖与下方列出一致
    [selected, selectedTags, selectedNonTags, failMode, coverage, regrWork, merge, dashboard],
  );

  const toggleSet = (value: string, set: Set<string>, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    setter(next);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时静默（预览文本仍可手动选中复制）
    }
  };

  const handleRun = async () => {
    if (!selected || !currentProjectId || running) return;
    setRunning(true);
    try {
      // 提交失败（store 内已 toast）时保持模态打开，用户可修正选项重试
      const ok = await runRegression(currentProjectId, selected.filePath, subsys, buildOptions());
      if (ok) onClose();
    } finally {
      setRunning(false);
    }
  };

  const selectItem = (item: RegressionItem) => {
    setSelectedPath(item.filePath);
    setEntryPreviewOpen(false);
  };

  const selectedList = selected?.type === 'list' ? (selected as RegressionList) : null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50"
      onClick={onClose}
      data-testid="reg-run-modal"
    >
      <div
        className="flex h-[560px] w-full max-w-4xl flex-col rounded-lg border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-foreground">运行回归</span>
            <span className="font-mono text-xs text-muted-foreground">{subsys}</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body：左 item 列表 / 右 配置 ── */}
        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
          {/* 左栏：搜索 + 过滤 + item 列表 */}
          <div className="flex min-h-0 flex-col border-r border-border">
            <div className="flex flex-col gap-1.5 border-b border-border/60 p-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索列表 / 组文件名"
                className="w-full rounded border border-border bg-background/60 px-2 py-1 text-xs outline-none transition-colors focus:border-primary"
                data-testid="reg-run-search"
              />
              <SegmentedControl
                className="w-full"
                options={TYPE_FILTERS.map((t) => ({
                  key: t.value,
                  label: t.label,
                  testId: `reg-run-filter-${t.value}`,
                }))}
                value={typeFilter}
                onChange={setTypeFilter}
              />
              {filterTags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {filterTags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                      className={cn(
                        'rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors',
                        tagFilter === tag
                          ? 'bg-primary/20 text-primary'
                          : 'bg-secondary text-muted-foreground hover:bg-accent',
                      )}
                      title="按标签过滤列表"
                      data-testid={`reg-run-tagfilter-${tag}`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">无匹配的回归文件</div>
              ) : (
                filtered.map((item) => {
                  const name = baseName(item.filePath);
                  const isSelected = item.filePath === selectedPath;
                  return (
                    <button
                      key={item.filePath}
                      onClick={() => selectItem(item)}
                      className={cn(
                        'mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors',
                        isSelected ? 'bg-primary/15' : 'hover:bg-accent',
                      )}
                      data-testid={`reg-run-item-${name}`}
                    >
                      {item.type === 'list' ? (
                        <ListIcon className="h-3 w-3 shrink-0 text-primary/70" />
                      ) : (
                        <FolderClosed className="h-3 w-3 shrink-0 text-violet-foreground/70" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{name}</span>
                      {item.type === 'list' && (
                        <span className="shrink-0 text-[9px] text-muted-foreground">
                          {item.onCount} ON · {item.entries.length} 行
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* 右栏：预览 + 选项 + 命令 + 运行 */}
          <div className="min-h-0 overflow-y-auto p-3">
            {!selected ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
                <Play className="size-5 opacity-30" />
                <span className="text-xs">选择一个回归列表或组</span>
                <span className="text-[10px] opacity-60">单次运行一个文件；多列表打包请使用组（.grp）</span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {/* Item 摘要 */}
                <div className="rounded-md border border-border/50 bg-secondary/20 px-3 py-2">
                  <div className="truncate font-mono text-xs text-foreground">{baseName(selected.filePath)}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {selectedList
                      ? `${selectedList.onCount} ON / ${selectedList.offCount} OFF / ${selectedList.entries.length} 行`
                      : `${(selected as { refPaths: string[] }).refPaths.length} 个引用（嵌套递归解析）`}
                  </div>
                </div>

                {/* Entry 只读预览（list）— 按需展开 */}
                {selectedList && selectedList.entries.length > 0 && (
                  <div>
                    <button
                      onClick={() => setEntryPreviewOpen(!entryPreviewOpen)}
                      className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                      data-testid="reg-run-entry-toggle"
                    >
                      {entryPreviewOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      预览用例（{selectedList.entries.length}）
                    </button>
                    {entryPreviewOpen && (
                      <table
                        className="mt-1 w-full rounded border border-border/50 text-left font-mono text-[10px]"
                        data-testid="reg-run-entry-table"
                      >
                        <thead>
                          <tr className="border-b border-border/50 text-muted-foreground">
                            <th className="px-2 py-1 font-medium">开关</th>
                            <th className="px-2 py-1 font-medium">Case</th>
                            <th className="px-2 py-1 font-medium">Seed</th>
                            <th className="px-2 py-1 font-medium">Tag</th>
                            <th className="px-2 py-1 font-medium">优先级</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedList.entries.map((e, i) => (
                            <tr key={`${e.caseName}-${i}`} className="border-b border-border/30 last:border-b-0">
                              <td className="px-2 py-0.5">
                                <span className={e.enabled ? 'text-status-pass-foreground' : 'text-muted-foreground/50'}>
                                  {e.enabled ? 'ON' : 'OFF'}
                                </span>
                              </td>
                              <td className="px-2 py-0.5 text-foreground">{e.caseName}</td>
                              <td className="px-2 py-0.5 text-muted-foreground">{e.seed}</td>
                              <td className="px-2 py-0.5 text-muted-foreground">{e.tags.join(',') || '—'}</td>
                              <td className="px-2 py-0.5 text-muted-foreground">{e.priority || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* Group 引用清单（解析后） */}
                {selected?.type === 'group' && groupResolved && (
                  <div className="rounded-md border border-border/50 px-3 py-2">
                    <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">引用文件</div>
                    {groupResolved.map((ref) => (
                      <div key={ref.path} className="truncate font-mono text-[10px] text-muted-foreground">
                        [{ref.type}] {ref.path}
                      </div>
                    ))}
                  </div>
                )}

                {/* 选项表单 */}
                <div className="flex flex-col gap-2.5">
                  {candidateTags.length > 0 && (
                    <ChipRow
                      label="Tag（只跑选中的标签）"
                      tags={candidateTags}
                      selected={selectedTags}
                      onToggle={(t) => toggleSet(t, selectedTags, setSelectedTags)}
                      testidPrefix="reg-run-tag"
                    />
                  )}
                  {candidateTags.length > 0 && (
                    <ChipRow
                      label="Non-tag（排除标签）"
                      tags={candidateTags}
                      selected={selectedNonTags}
                      onToggle={(t) => toggleSet(t, selectedNonTags, setSelectedNonTags)}
                      testidPrefix="reg-run-nt"
                    />
                  )}

                  <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                    <ToggleRow
                      label="Fail mode（-fm，只跑失败用例）"
                      checked={failMode}
                      onChange={setFailMode}
                      testid="reg-run-fm"
                    />
                    <ToggleRow
                      label="覆盖率（-cov）"
                      checked={coverage}
                      onChange={(v) => {
                        setCoverage(v);
                        if (!v) setMerge(false);
                      }}
                      testid="reg-run-cov"
                    />
                    <ToggleRow
                      label="自动 merge（-merge，需先勾选覆盖率）"
                      checked={merge && coverage}
                      disabled={!coverage}
                      onChange={setMerge}
                      testid="reg-run-merge"
                    />
                  </div>

                  <div className="flex gap-3">
                    <label className="flex flex-1 items-center gap-1.5">
                      <span className="shrink-0 text-[10px] font-medium text-muted-foreground">回归工作目录（-regr_work）</span>
                      <input
                        value={regrWork}
                        onChange={(e) => setRegrWork(e.target.value)}
                        placeholder="留空使用 runsim 默认"
                        className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-primary"
                        data-testid="reg-run-regr-work"
                      />
                    </label>
                    <label className="flex flex-1 items-center gap-1.5">
                      <span className="shrink-0 text-[10px] font-medium text-muted-foreground">Dashboard DE TAG（-m）</span>
                      <input
                        value={dashboard}
                        onChange={(e) => setDashboard(e.target.value)}
                        placeholder="如 DE123"
                        className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-primary"
                        data-testid="reg-run-dashboard"
                      />
                    </label>
                  </div>
                </div>

                {/* 命令预览（只读，与执行同一构造实现） */}
                <div className="rounded-md border border-border bg-background/60 px-3 py-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">命令预览</span>
                    <button
                      onClick={handleCopy}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title="复制命令"
                      data-testid="reg-run-copy"
                    >
                      {copied ? <Check className="h-3 w-3 text-status-pass-foreground" /> : <Copy className="h-3 w-3" />}
                      {copied ? '已复制' : '复制'}
                    </button>
                  </div>
                  <code className="block break-all font-mono text-[11px] text-foreground" data-testid="reg-run-cmd-preview">
                    {command}
                  </code>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <button
            onClick={onClose}
            className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={handleRun}
            disabled={!selected || running || !currentProjectId}
            className="flex items-center gap-1.5 rounded bg-primary px-4 py-1 text-xs font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="reg-run-confirm"
          >
            <Play className="h-3 w-3" />
            {running ? '提交中…' : '运行'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 小部件 ─────────────────────────────────────────────

function ChipRow({
  label,
  tags,
  selected,
  onToggle,
  testidPrefix,
}: {
  label: string;
  tags: string[];
  selected: Set<string>;
  onToggle: (tag: string) => void;
  testidPrefix: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <button
            key={tag}
            onClick={() => onToggle(tag)}
            className={cn(
              'rounded px-2 py-0.5 font-mono text-[10px] transition-colors',
              selected.has(tag) ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground hover:bg-accent',
            )}
            data-testid={`${testidPrefix}-${tag}`}
          >
            {tag}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
  testid,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  testid: string;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      title={disabled ? '需要先勾选覆盖率（-cov）' : undefined}
      className={cn(
        'flex items-center gap-1.5 text-[11px] transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/40' : 'text-muted-foreground hover:text-foreground',
      )}
      data-testid={testid}
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
        )}
      >
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {label}
    </button>
  );
}
