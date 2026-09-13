/**
 * KbReviewTab — 知识提案审阅与发布面板（issue 05/06）。
 *
 * 与代码审阅共用同一套「展示 / 动作」解耦：面板左侧列出待审阅变更集与
 * 其中的页面，右侧用 before/proposed 合成的 diff 渲染增删行与逐块操作条；
 * 接受/拒绝经 kb-staged adapter 落到 `kb.decideStaged`（记录用户选择）。
 *
 * 发布（issue 06）：整页接受后点「发布」经 `kb.publishStaged` 走一次原子
 * 提交（正式页 + 确定性 index/overview + log + 页面历史 + manifest），
 * 成功后直接只读打开已发布页。基线变动转 stale 时主进程失效旧批准，
 * 这里显示原因并刷新为 pending。
 *
 * diff 合成在 store（buildStagedDiff）完成，展示组件不伪造 tool call、
 * 也不自行调用 project 撤销 API（spec L04 / F16）。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 */

import { useEffect, useMemo } from 'react';
import { AlertTriangle, Check, ClipboardCheck, FilePlus2, FileText, Upload, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useKbReviewStore, buildStagedDiff, selectHunkStates } from '@renderer/stores/kb-review';
import { useKbStore } from '@renderer/stores/kb';
import { useKbWikiStore } from '@renderer/stores/kb-wiki';
import type { WikiChangeSetOrigin, WikiStagedPage } from '@shared/kb-types';

const ORIGIN_LABELS: Record<WikiChangeSetOrigin, string> = {
  compile: '编译产出',
  saveQuery: '保存问答',
  fix: '修复',
};

export function KbReviewTab() {
  const changeSets = useKbReviewStore((s) => s.changeSets);
  const listLoading = useKbReviewStore((s) => s.listLoading);
  const listError = useKbReviewStore((s) => s.listError);
  const activeChangeSet = useKbReviewStore((s) => s.activeChangeSet);
  const activePageRelPath = useKbReviewStore((s) => s.activePageRelPath);
  const activeReview = useKbReviewStore((s) => s.activeReview);
  const loadChangeSets = useKbReviewStore((s) => s.loadChangeSets);
  const openChangeSet = useKbReviewStore((s) => s.openChangeSet);
  const selectPage = useKbReviewStore((s) => s.selectPage);
  const reset = useKbReviewStore((s) => s.reset);

  useEffect(() => {
    void loadChangeSets();
    return () => reset();
  }, [loadChangeSets, reset]);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="kb-review-tab">
      {/* 子导航：变更集列表 + 选中页 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <ClipboardCheck className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">待审阅提案</span>
        <span className="text-[10px] text-muted-foreground">{changeSets.length} 个变更集</span>
        {activeChangeSet && (
          <>
            <span className="text-[10px] text-muted-foreground">·</span>
            <span className="font-mono text-[10px] text-muted-foreground" title={activeChangeSet.changeSetId}>
              {activeChangeSet.changeSetId.slice(0, 8)}
            </span>
          </>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">接受后点「发布」写入正式知识页与索引</span>
      </div>

      {listError && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive">
          {listError}
        </div>
      )}

      {/* 基线变动：旧批准已失效，必须重新生成差异并重新批准 */}
      {activeReview?.stale && (
        <div
          className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="kb-review-stale"
        >
          <p className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3" />
            基线已变动，旧批准已失效（需重新审阅后再发布）
          </p>
          <ul className="mt-0.5 list-disc pl-4">
            {activeReview.stale.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* 变更集与页面列表 */}
        <div className="w-72 shrink-0 overflow-y-auto border-r border-border py-2">
          {listLoading ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">加载待审阅提案…</div>
          ) : changeSets.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              没有待审阅的知识提案
            </div>
          ) : (
            changeSets.map((cs) => (
              <ChangeSetGroup
                key={cs.changeSetId}
                summary={cs}
                active={cs.changeSetId === activeChangeSet?.changeSetId}
                onOpen={() => void openChangeSet(cs.changeSetId)}
                activeChangeSet={activeChangeSet}
                activePageRelPath={activePageRelPath}
                onSelectPage={selectPage}
              />
            ))
          )}
        </div>

        {/* 页面 diff */}
        <div className="flex-1 overflow-hidden">
          <PageDiff relPath={activePageRelPath} />
        </div>
      </div>
    </div>
  );
}

// ── 变更集分组 ──────────────────────────────────────────────────

function ChangeSetGroup({
  summary,
  active,
  onOpen,
  activeChangeSet,
  activePageRelPath,
  onSelectPage,
}: {
  summary: { changeSetId: string; taskId: string; origin: WikiChangeSetOrigin; pageCount: number; newPageCount: number; findingCount: number; settled: boolean; createdAt: string };
  active: boolean;
  onOpen: () => void;
  activeChangeSet: ReturnType<typeof useKbReviewStore.getState>['activeChangeSet'];
  activePageRelPath: string | null;
  onSelectPage: (relPath: string) => void;
}) {
  return (
    <div className="mb-1" data-testid={`kb-changeset-${summary.changeSetId}`}>
      <button
        onClick={onOpen}
        data-testid={`kb-changeset-open-${summary.changeSetId}`}
        className={cn(
          'block w-full px-3 py-1.5 text-left transition-colors hover:bg-secondary',
          active ? 'bg-secondary' : '',
        )}
        title={`任务 ${summary.taskId}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-xs text-foreground">{summary.changeSetId.slice(0, 8)}</span>
          <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground">
            {ORIGIN_LABELS[summary.origin]}
          </span>
          {summary.settled && (
            <span className="shrink-0 rounded bg-status-pass/15 px-1 py-0.5 text-[10px] text-status-pass-foreground">
              已处置
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {summary.pageCount} 页（新页 {summary.newPageCount}）
          {summary.findingCount > 0 ? ` · ${summary.findingCount} 条知识待办` : ''}
        </div>
      </button>

      {/* 选中变更集的页面列表 */}
      {active && activeChangeSet && (
        <div className="pb-1">
          {activeChangeSet.pages.map((p) => (
            <button
              key={p.relPath}
              onClick={() => onSelectPage(p.relPath)}
              data-testid={`kb-page-${p.relPath}`}
              className={cn(
                'flex w-full items-center gap-1.5 px-5 py-1 text-left text-[11px] transition-colors hover:bg-secondary',
                p.relPath === activePageRelPath ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground',
              )}
              title={p.relPath}
            >
              {p.before === null
                ? <FilePlus2 className="h-3 w-3 shrink-0 text-status-pass-foreground" />
                : <FileText className="h-3 w-3 shrink-0" />}
              <span className="truncate">{p.pageId}</span>
            </button>
          ))}

          {activeChangeSet.warnings.length > 0 && (
            <div className="mx-3 mt-1 rounded border border-amber-500/30 bg-amber-500/10 p-1.5" data-testid="kb-changeset-warnings">
              <p className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-2.5 w-2.5" />
                {activeChangeSet.warnings.length} 条丢弃说明
              </p>
              <ul className="mt-0.5 list-disc pl-3.5">
                {activeChangeSet.warnings.map((w, i) => (
                  <li key={i} className="text-[10px] text-amber-600/85 dark:text-amber-400/85">{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 页面 diff ──────────────────────────────────────────────────

function PageDiff({ relPath }: { relPath: string | null }) {
  const activeChangeSet = useKbReviewStore((s) => s.activeChangeSet);
  const activeReview = useKbReviewStore((s) => s.activeReview);
  const deciding = useKbReviewStore((s) => s.deciding);
  const publishing = useKbReviewStore((s) => s.publishing);
  const decideHunk = useKbReviewStore((s) => s.decideHunk);
  const publishActive = useKbReviewStore((s) => s.publishActive);
  // 订阅原始切片后在组件侧用 useMemo 组合：selectHunkStates 每次会创建新对象，
  // 直接传给 useSyncExternalStore 的 selector 会触发 getSnapshot 缓存告警与无限重渲染。
  const activePageRelPath = useKbReviewStore((s) => s.activePageRelPath);

  /** 发布成功 → 只读打开已发布页（切到「知识页」tab 并装载该页） */
  const onPublish = async (): Promise<void> => {
    const res = await publishActive();
    if (!res.ok) return;
    await useKbWikiStore.getState().openPage(res.pageId);
    useKbStore.getState().setActiveTab('wiki');
  };

  const page: WikiStagedPage | null = useMemo(
    () => activeChangeSet?.pages.find((p) => p.relPath === relPath) ?? null,
    [activeChangeSet, relPath],
  );
  const diff = useMemo(() => (page ? buildStagedDiff(page) : null), [page]);
  const hunkStates = useMemo(
    () => selectHunkStates({ activeReview, activePageRelPath }),
    [activeReview, activePageRelPath],
  );

  if (!activeChangeSet || !relPath) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-xs text-muted-foreground">
        从左侧选择一个待审阅的变更集
      </div>
    );
  }

  const pageReview = activeReview?.pages.find((p) => p.relPath === relPath);
  const hasChanges = diff !== null;

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="kb-review-diff">
      {/* 页头 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="truncate font-mono text-xs text-foreground" title={relPath}>{relPath}</span>
        {page && (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {page.type}
          </span>
        )}
        {page?.before === null && (
          <span className="shrink-0 rounded bg-status-pass/15 px-1.5 py-0.5 text-[10px] text-status-pass-foreground">
            新建
          </span>
        )}
        {pageReview !== undefined && pageReview.pageDecision !== 'pending' && (
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
            整页{pageReview.pageDecision === 'accepted' ? '接受' : '拒绝'}
          </span>
        )}
        <div className="flex-1" />
        {hasChanges && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
            <span className="text-status-pass-foreground">+{diff.totalAdd}</span>
            <span className="text-destructive">−{diff.totalDel}</span>
          </span>
        )}
      </div>

      {/* 来源引用（证据边） */}
      {page && page.sources.length > 0 && (
        <div className="border-b border-border bg-secondary/40 px-4 py-1.5 text-[10px] text-muted-foreground">
          来源：{page.sources.map((s) => s.sourceId.slice(0, 8)).join('、')}
        </div>
      )}

      {/* diff 主体 */}
      <div className="flex-1 overflow-auto" data-testid="kb-review-diff-lines">
        {!hasChanges ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">提案内容与已发布页一致，无差异</div>
        ) : (
          <>
            {/* 整页操作条：整页处置 = 处置全部真实 hunk
                （新页 [0]；已有页 frontmatter 合并块 + 正文逐 hunk，issue 07） */}
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-1.5">
              <span className="text-[11px] font-medium text-foreground">整页处置</span>
              <span className="text-[10px] text-muted-foreground">
                {page?.before === null ? '接受后作为新页发布' : '接受后覆盖已发布页'}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => void decideHunk(diff.hunks.map((h) => h.id), 'rejected')}
                disabled={deciding || publishing}
                data-testid="kb-page-reject"
                className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <X className="h-2.5 w-2.5" />
                拒绝
              </button>
              <button
                onClick={() => void decideHunk(diff.hunks.map((h) => h.id), 'accepted')}
                disabled={deciding || publishing}
                data-testid="kb-page-accept"
                className="flex items-center gap-1 rounded border border-status-pass/30 bg-status-pass/10 px-2 py-0.5 text-[10px] text-status-pass-foreground transition-colors hover:bg-status-pass/20 disabled:opacity-40"
              >
                <Check className="h-2.5 w-2.5" />
                接受
              </button>
              {/* 发布：基线校验 + 一次原子提交（正式页/聚合/日志/历史） */}
              <button
                onClick={() => void onPublish()}
                disabled={publishing || deciding}
                data-testid="kb-page-publish"
                title="发布本变更集：校验基线后一次提交写入正式页与索引"
                className="flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
              >
                <Upload className="h-2.5 w-2.5" />
                {publishing ? '发布中…' : '发布'}
              </button>
            </div>

            {/* 逐行 diff（上下文 + 增删），新增行按 hunk 状态着色 */}
            <div className="font-mono text-[11px] leading-relaxed">
              {diff.lines.map((line, idx) => (
                <DiffRow key={idx} line={line} state={hunkStates} />
              ))}
            </div>

            {/* 逐块操作条：frontmatter 合并块 + 正文逐 hunk（issue 07） */}
            {diff.hunks.map((hunk) => (
              <div
                key={hunk.id}
                data-testid={`kb-hunk-bar-${hunk.id}`}
                className="flex items-center gap-2 border-t border-border bg-secondary/30 px-4 py-1.5"
              >
                <span className="font-mono text-[10px] text-muted-foreground">
                  +{hunk.addCount} −{hunk.delCount}
                </span>
                <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground">
                  {hunk.kind === 'frontmatter' ? 'frontmatter 整体' : hunk.kind === 'whole-page' ? '整页' : '正文'}
                </span>
                <div className="flex-1" />
                <HunkStateBadge state={hunkStates[hunk.id] ?? 'pending'} />
                <button
                  onClick={() => void decideHunk([hunk.id], 'rejected')}
                  disabled={deciding || publishing}
                  data-testid={`kb-hunk-reject-${hunk.id}`}
                  className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  拒绝
                </button>
                <button
                  onClick={() => void decideHunk([hunk.id], 'accepted')}
                  disabled={deciding || publishing}
                  data-testid={`kb-hunk-accept-${hunk.id}`}
                  className="rounded border border-status-pass/30 bg-status-pass/10 px-1.5 py-0.5 text-[10px] text-status-pass-foreground transition-colors hover:bg-status-pass/20 disabled:opacity-40"
                >
                  接受
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function HunkStateBadge({ state }: { state: 'pending' | 'accepted' | 'rejected' }) {
  if (state === 'pending') {
    return <span className="text-[10px] text-muted-foreground">待处置</span>;
  }
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px]',
        state === 'accepted'
          ? 'bg-status-pass/15 text-status-pass-foreground'
          : 'bg-destructive/10 text-destructive',
      )}
    >
      {state === 'accepted' ? '已接受' : '已拒绝'}
    </span>
  );
}

function DiffRow({
  line,
  state,
}: {
  line: { type: 'ctx' | 'add' | 'del'; content: string; oldLine?: number; newLine?: number; hunkId?: number };
  state: Record<number, 'pending' | 'accepted' | 'rejected'>;
}) {
  const hunkState = line.hunkId === undefined ? 'ctx' : (state[line.hunkId] ?? 'pending');
  // accepted：改动已采纳，增行折叠为普通代码；del 行不展示（旧行已不再存在）
  const showDel = line.type === 'del' && hunkState === 'pending';
  const showAdd = line.type === 'add' && hunkState !== 'accepted';
  if (line.type === 'del' && !showDel) return null;
  if (line.type === 'add' && !showAdd) return null;

  return (
    <div
      data-testid={`kb-diff-${line.type}`}
      className={cn(
        'flex items-start gap-2 whitespace-pre-wrap px-4',
        line.type === 'add' && (hunkState === 'rejected' ? 'bg-destructive/10 line-through opacity-70' : 'bg-status-pass/10'),
        line.type === 'del' && 'bg-destructive/10',
      )}
    >
      <span className="w-4 shrink-0 select-none text-muted-foreground">
        {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
      </span>
      <span className="flex-1">{line.content.length > 0 ? line.content : '\u00A0'}</span>
    </div>
  );
}
