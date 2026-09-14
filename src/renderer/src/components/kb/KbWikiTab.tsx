/**
 * KbWikiTab — wiki 布局知识库的只读浏览与写作规则编辑（issue 04）。
 *
 * 页面区：按类型目录分组的页面目录（pageId 含类型路径）、聚合页与
 * orphan；页面正文只读渲染，wikilink 点击跟随主进程统一解析结论
 * （resolved 跳转 / ambiguous 列候选 / unresolved 提示）。
 *
 * 规则区：schema.md / purpose.md 编辑；schema 草稿防抖即时校验
 * （受约束表不完整/重复/未知路由实时报错），保存经 kb.saveWikiRules
 * （已有页目录重映射被主进程拒绝）。
 */

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, FileText, FileWarning, Network, ScrollText, Search, ShieldAlert, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import { useKbWikiStore } from '@renderer/stores/kb-wiki';
import { wikiLinksToDisplayMarkdown, parseWikilinkHref } from '@renderer/lib/wiki-links';
import { KbWikiGraph } from './KbWikiGraph';
import { useKbStore } from '@renderer/stores/kb';
import { KbPageTree } from './KbPageTree';
import type { WikiPageType, WikiSearchHit, WikiSourceSummary } from '@shared/kb-types';

export function KbWikiTab() {
  const [section, setSection] = useState<'pages' | 'raw' | 'graph' | 'rules' | 'search'>('pages');
  const loadCatalog = useKbWikiStore((s) => s.loadCatalog);
  const reset = useKbWikiStore((s) => s.reset);
  const openPage = useKbWikiStore((s) => s.openPage);
  const loadDocuments = useKbStore((s) => s.loadDocuments);

  useEffect(() => {
    void loadCatalog();
    void loadDocuments();
    return () => reset();
  }, [loadCatalog, loadDocuments, reset]);

  /** 检索结果中的 wiki 命中 → 切到知识页区并打开该页 */
  const openWikiHit = (pageId: string): void => {
    setSection('pages');
    void openPage(pageId);
  };

  /** 图节点跳转 → 切到知识页区并打开该页（spec §9「点击线索聚焦关联页面」） */
  const openGraphPage = (pageId: string): void => {
    setSection('pages');
    void openPage(pageId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="kb-wiki-tab">
      {/* 子导航 */}
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <button
          onClick={() => setSection('pages')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            section === 'pages'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <BookOpen className="h-3.5 w-3.5" />
          知识页
        </button>
        <button
          onClick={() => setSection('raw')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            section === 'raw'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid="kb-wiki-raw-tab"
        >
          <FileText className="h-3.5 w-3.5" />
          原始全文
        </button>
        <button
          onClick={() => setSection('search')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            section === 'search'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid="kb-wiki-search-tab"
        >
          <Search className="h-3.5 w-3.5" />
          检索
        </button>
        <button
          onClick={() => setSection('graph')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            section === 'graph'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid="kb-wiki-graph-tab"
        >
          <Network className="h-3.5 w-3.5" />
          知识图谱
        </button>
        <button
          onClick={() => setSection('rules')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            section === 'rules'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <ScrollText className="h-3.5 w-3.5" />
          写作规则
        </button>
        <div className="flex-1" />
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <ShieldAlert className="h-3 w-3" />
          只读（由审阅/发布流程写入）
        </span>
      </div>

      {section === 'pages' ? (
        <PageBrowser />
      ) : section === 'raw' ? (
        <RawBrowser />
      ) : section === 'graph' ? (
        <KbWikiGraph onOpenPage={openGraphPage} />
      ) : section === 'search' ? (
        <SearchPanel onOpenWikiPage={openWikiHit} />
      ) : (
        <RulesEditor />
      )}
    </div>
  );
}

function RawBrowser() {
  const sources = useKbStore((s) => s.wikiSources);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openSource = async (source: WikiSourceSummary): Promise<void> => {
    setActiveSourceId(source.sourceId);
    setContent(null);
    setError(null);
    setLoading(true);
    try {
      const result = await trpc.kb.sourceParsed.query({ sourceId: source.sourceId });
      setContent(result.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const activeSource = sources.find((source) => source.sourceId === activeSourceId) ?? null;
  return (
    <div className="flex flex-1 overflow-hidden" data-testid="kb-wiki-raw-browser">
      <div className="w-60 shrink-0 overflow-y-auto border-r border-border py-2">
        <div className="px-3 pb-2 text-[11px] font-medium text-muted-foreground">raw / parsed</div>
        {sources.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">暂无已转换来源全文</div>
        ) : sources.map((source) => (
          <button
            key={source.sourceId}
            onClick={() => void openSource(source)}
            data-testid={`kb-wiki-raw-${source.sourceId}`}
            className={cn(
              'flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-secondary',
              activeSourceId === source.sourceId && 'bg-secondary font-medium',
            )}
            title={source.sourcePath}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{source.sourcePath}</span>
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {!activeSource ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">从左侧选择来源全文</div>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
              <span className="font-mono text-xs">{activeSource.sourcePath}</span>
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">raw</span>
              {activeSource.parsedStale && <span className="text-[10px] text-amber-600">当前原件尚未转换</span>}
            </div>
            <div className="whitespace-pre-wrap text-[11px] leading-relaxed" data-testid="kb-wiki-raw-content">
              {loading ? '正在读取全文…' : error ?? content}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 页面浏览 ────────────────────────────────────────────────────

function PageBrowser() {
  const catalog = useKbWikiStore((s) => s.catalog);
  const catalogLoading = useKbWikiStore((s) => s.catalogLoading);
  const catalogError = useKbWikiStore((s) => s.catalogError);
  const activePageId = useKbWikiStore((s) => s.activePageId);
  if (catalogLoading) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">正在编目页面…</div>;
  }
  if (catalogError) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-md">
          <FileWarning className="mx-auto mb-2 h-6 w-6 text-destructive" />
          <p className="text-xs font-medium text-foreground">页面目录不可用</p>
          <p className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">{catalogError}</p>
        </div>
      </div>
    );
  }
  if (!catalog) return null;

  return (
    <div className="flex flex-1 overflow-hidden">
      <KbPageTree catalog={catalog} />

      {/* 页面正文 */}
      <div className="flex-1 overflow-hidden">
        {catalog.pages.length === 0 && !activePageId ? (
          <div className="flex h-full items-center justify-center px-8 text-center">
            <div className="max-w-md">
              <BookOpen className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">尚无已发布知识页</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                文档上传后需完成编译，再到知识审阅接受并发布提案。若编译失败或等待模型配置，请先查看导入任务。
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={() => useKbStore.getState().setActiveTab('tasks')} className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90">查看导入任务</button>
                <button onClick={() => useKbStore.getState().setActiveTab('review')} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-secondary">前往知识审阅</button>
              </div>
            </div>
          </div>
        ) : <WikiPageView />}
      </div>
    </div>
  );
}

function WikiPageView() {
  const page = useKbWikiStore((s) => s.activePage);
  const pageLoading = useKbWikiStore((s) => s.pageLoading);
  const activePageId = useKbWikiStore((s) => s.activePageId);
  const followLink = useKbWikiStore((s) => s.followLink);

  if (pageLoading) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中…</div>;
  }
  if (!page || !activePageId) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">从左侧选择一个页面</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 页头 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-mono text-xs text-foreground">{page.pageId}</span>
        {page.kind === 'page' && page.parse.ok && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {page.parse.frontmatter.type}
          </span>
        )}
        {page.kind === 'aggregate' && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">聚合页</span>
        )}
        {page.routeMismatch && (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
            类型与目录路由不一致
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-muted-foreground">只读</span>
      </div>

      {/* 坏页的解析问题 */}
      {!page.parse.ok && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2">
          <p className="text-[11px] font-medium text-destructive">页面 frontmatter 未通过校验（只读展示原文）</p>
          <ul className="mt-1 list-disc pl-4">
            {page.parse.issues.map((i, idx) => (
              <li key={idx} className="text-[11px] text-destructive/80">{i.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 正文（只读渲染，wikilink 点击跟随） */}
      <div className="flex-1 overflow-y-auto px-6 py-4" data-testid="wiki-page-content">
        <ReactMarkdown
          components={{
            a: ({ href, children }) => {
              const target = href !== undefined ? parseWikilinkHref(href) : null;
              if (target === null) {
                return <a href={href}>{children}</a>;
              }
              return (
                <a
                  href="#"
                  data-testid={`wiki-link-${target}`}
                  onClick={(e) => {
                    e.preventDefault();
                    void followLink(target);
                  }}
                  className="text-primary underline underline-offset-2"
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {wikiLinksToDisplayMarkdown(page.content)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// ── 写作规则编辑 ────────────────────────────────────────────────

function RulesEditor() {
  const rulesLoading = useKbWikiStore((s) => s.rulesLoading);
  const schemaDraft = useKbWikiStore((s) => s.schemaDraft);
  const purposeDraft = useKbWikiStore((s) => s.purposeDraft);
  const schemaRaw = useKbWikiStore((s) => s.schemaRaw);
  const purposeRaw = useKbWikiStore((s) => s.purposeRaw);
  const validation = useKbWikiStore((s) => s.validation);
  const rulesSaving = useKbWikiStore((s) => s.rulesSaving);
  const loadRules = useKbWikiStore((s) => s.loadRules);
  const setSchemaDraft = useKbWikiStore((s) => s.setSchemaDraft);
  const setPurposeDraft = useKbWikiStore((s) => s.setPurposeDraft);
  const saveRules = useKbWikiStore((s) => s.saveRules);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const schemaChanged = schemaDraft !== null && schemaDraft !== schemaRaw;
  const purposeChanged = purposeDraft !== null && purposeDraft !== purposeRaw;
  const canSave = !rulesLoading && !rulesSaving && (schemaChanged || purposeChanged)
    && validation.status !== 'invalid' && validation.status !== 'validating';

  if (rulesLoading) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">加载写作规则…</div>;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-4 py-3" data-testid="kb-wiki-rules">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium">写作规则</span>
        <span className="text-[11px] text-muted-foreground">
          schema 的 `## Page Types` 是受约束表：不完整/重复/未知路由与已有页目录重映射会在保存时拒绝
        </span>
      </div>

      <div className="grid flex-1 grid-cols-2 gap-3 overflow-hidden">
        <label className="flex min-h-0 flex-col">
          <span className="mb-1 font-mono text-[11px] text-muted-foreground">schema.md（写作规则 + 类型路由）</span>
          <textarea
            value={schemaDraft ?? ''}
            onChange={(e) => setSchemaDraft(e.target.value)}
            spellCheck={false}
            className="flex-1 resize-none rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-primary"
          />
        </label>
        <label className="flex min-h-0 flex-col">
          <span className="mb-1 font-mono text-[11px] text-muted-foreground">purpose.md（库目标，可任意修改）</span>
          <textarea
            value={purposeDraft ?? ''}
            onChange={(e) => setPurposeDraft(e.target.value)}
            spellCheck={false}
            className="flex-1 resize-none rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-primary"
          />
        </label>
      </div>

      {/* 即时校验反馈 */}
      {validation.status === 'validating' && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="wiki-schema-validating">校验中…</p>
      )}
      {validation.status === 'valid' && schemaChanged && (
        <p className="mt-2 text-[11px] text-primary" data-testid="wiki-schema-valid">✓ schema 通过受约束表校验</p>
      )}
      {validation.status === 'invalid' && (
        <div className="mt-2 rounded border border-destructive/40 bg-destructive/5 p-2" data-testid="wiki-schema-issues">
          <p className="text-[11px] font-medium text-destructive">schema 校验未通过（{validation.issues.length} 个问题）：</p>
          <ul className="mt-1 list-disc pl-4">
            {validation.issues.map((i, idx) => (
              <li key={idx} className="text-[11px] text-destructive/85">
                {i.line !== undefined ? `第 ${i.line} 行：` : ''}{i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={() => void saveRules()}
          disabled={!canSave}
          data-testid="wiki-rules-save"
          className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {rulesSaving ? '保存中…' : '保存规则'}
        </button>
      </div>
    </div>
  );
}

// ── 知识检索（issue 14）──────────────────────────────────────────

const WIKI_PAGE_TYPE_OPTIONS: readonly WikiPageType[] = [
  'source', 'entity', 'concept', 'comparison',
  'synthesis', 'query', 'pitfall', 'interface',
];

function SearchPanel({ onOpenWikiPage }: { onOpenWikiPage: (pageId: string) => void }): React.JSX.Element {
  const search = useKbWikiStore((s) => s.search);
  const setSearchQuery = useKbWikiStore((s) => s.setSearchQuery);
  const setSearchFilters = useKbWikiStore((s) => s.setSearchFilters);
  const runSearch = useKbWikiStore((s) => s.runSearch);
  const catalog = useKbWikiStore((s) => s.catalog);

  /** parsed 命中的全文预览（sourceId → kb.sourceParsed） */
  const [parsedHit, setParsedHit] = useState<WikiSearchHit | null>(null);
  const [parsedContent, setParsedContent] = useState<string | null>(null);
  const [parsedLoading, setParsedLoading] = useState(false);
  const [parsedError, setParsedError] = useState<string | null>(null);

  // 标签筛选选项：从目录页面的 frontmatter tags 收集
  const tagOptions = useMemo(() => {
    if (!catalog) return [];
    const tags = new Set<string>();
    for (const p of catalog.pages) {
      if (p.parse.ok) for (const t of p.parse.frontmatter.tags) tags.add(t);
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [catalog]);

  const openParsedHit = async (hit: WikiSearchHit): Promise<void> => {
    setParsedHit(hit);
    setParsedContent(null);
    setParsedError(null);
    setParsedLoading(true);
    try {
      const view = await trpc.kb.sourceParsed.query({ sourceId: hit.id });
      setParsedContent(view.content);
    } catch (err) {
      setParsedError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsedLoading(false);
    }
  };

  const closeParsed = (): void => {
    setParsedHit(null);
    setParsedContent(null);
    setParsedError(null);
    setParsedLoading(false);
  };

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden px-4 py-3" data-testid="kb-wiki-search">
      {/* 检索栏：关键词 + 类型/标签筛选（与 kb_search 同一主进程服务） */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search.query}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
          placeholder="关键词（支持中文 bigram 与 AWLEN / [7:0] / 0x10 等精确符号）"
          className="h-7 min-w-56 flex-1 rounded border border-border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-primary/40"
          data-testid="kb-wiki-search-input"
        />
        <select
          value={search.kindFilter}
          onChange={(e) => setSearchFilters({ kindFilter: e.target.value as '' | 'wiki' | 'parsed' })}
          className="h-7 rounded border border-border bg-transparent px-1 text-xs"
          data-testid="kb-wiki-search-kind"
        >
          <option value="">全部对象</option>
          <option value="wiki">知识页</option>
          <option value="parsed">来源全文</option>
        </select>
        <select
          value={search.pageTypeFilter}
          onChange={(e) => setSearchFilters({ pageTypeFilter: e.target.value })}
          className="h-7 rounded border border-border bg-transparent px-1 text-xs"
          data-testid="kb-wiki-search-pagetype"
        >
          <option value="">全部类型</option>
          {WIKI_PAGE_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={search.tagFilter}
          onChange={(e) => setSearchFilters({ tagFilter: e.target.value })}
          className="h-7 rounded border border-border bg-transparent px-1 text-xs"
          data-testid="kb-wiki-search-tag"
        >
          <option value="">全部标签</option>
          {tagOptions.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <button
          onClick={() => void runSearch()}
          disabled={search.searching || search.query.trim() === ''}
          className="h-7 rounded bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          data-testid="kb-wiki-search-run"
        >
          {search.searching ? '检索中…' : '检索'}
        </button>
      </div>

      {/* 覆盖状态 */}
      {search.coverage && (
        <div className="mt-1.5 text-[11px] text-muted-foreground" data-testid="kb-wiki-search-coverage">
          参与排名：知识页 {search.coverage.wikiPages} 页 · 来源全文 {search.coverage.parsedSources} 份
          {search.hits.length > 0 ? ` · 命中 ${search.hits.length} 条` : ''}
        </div>
      )}

      {/* 错误态（未挂载 / 非 wiki 布局 / 门禁暂停 / 请求失败） */}
      {search.errorMessage && (
        <div
          className="mt-3 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          data-testid="kb-wiki-search-error"
        >
          <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{search.errorMessage}</span>
        </div>
      )}

      {/* 结果列表 */}
      {!search.errorMessage && search.hits.length > 0 && (
        <div className="mt-2 flex-1 overflow-y-auto" data-testid="kb-wiki-search-results">
          {search.hits.map((hit) => (
            <button
              key={`${hit.kind}:${hit.id}`}
              onClick={() => {
                if (hit.kind === 'wiki') onOpenWikiPage(hit.id);
                else void openParsedHit(hit);
              }}
              className="block w-full rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-secondary/50"
              data-testid={`kb-wiki-search-hit-${hit.kind}-${hit.id}`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'rounded px-1 py-0.5 text-[10px] font-medium',
                    hit.kind === 'wiki'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  {hit.kind === 'wiki' ? '知识页' : '来源全文'}
                </span>
                {hit.pageType && <span className="text-[10px] text-muted-foreground">{hit.pageType}</span>}
                <span className="truncate text-xs font-medium text-foreground">{hit.title}</span>
                {hit.stale && (
                  <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                    来源已更新
                  </span>
                )}
                {hit.kind === 'parsed' && hit.sourceRevision && (
                  <span className="shrink-0 text-[10px] text-muted-foreground" title="来源当前修订">
                    rev {hit.sourceRevision.slice(0, 8)}
                  </span>
                )}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={hit.absolutePath}>
                {hit.relativePath}
              </div>
              {hit.snippet && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/90">{hit.snippet}</div>
              )}
              {(hit.tags?.length ?? 0) > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {hit.tags?.map((t) => (
                    <span key={t} className="rounded bg-secondary px-1 text-[10px] text-secondary-foreground">{t}</span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 空态：检索过但无命中 */}
      {!search.errorMessage && !search.searching && search.hits.length === 0 && search.coverage && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" data-testid="kb-wiki-search-empty">
          无匹配结果——试试更短的关键词，或放宽类型/标签筛选
        </div>
      )}

      {/* parsed 全文预览（只读浮层） */}
      {parsedHit && (
        <div className="absolute inset-0 z-10 flex flex-col bg-background/95 px-4 py-3" data-testid="kb-wiki-parsed-preview">
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">来源全文</span>
            <span className="truncate text-xs font-medium text-foreground">{parsedHit.title}</span>
            {parsedHit.sourceRevision && (
              <span className="text-[10px] text-muted-foreground">rev {parsedHit.sourceRevision.slice(0, 8)}</span>
            )}
            <button
              onClick={closeParsed}
              className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              data-testid="kb-wiki-parsed-close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 flex-1 overflow-y-auto whitespace-pre-wrap rounded border border-border p-2 text-[11px] leading-relaxed text-foreground">
            {parsedLoading ? '正在读取全文…' : parsedError ?? parsedContent}
          </div>
        </div>
      )}
    </div>
  );
}
