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
import { BookOpen, FileWarning, ScrollText, ShieldAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@renderer/lib/utils';
import { useKbWikiStore } from '@renderer/stores/kb-wiki';
import { wikiLinksToDisplayMarkdown, parseWikilinkHref } from '@renderer/lib/wiki-links';
import type { WikiPageType } from '@shared/kb-types';

export function KbWikiTab() {
  const [section, setSection] = useState<'pages' | 'rules'>('pages');
  const loadCatalog = useKbWikiStore((s) => s.loadCatalog);
  const reset = useKbWikiStore((s) => s.reset);

  useEffect(() => {
    void loadCatalog();
    return () => reset();
  }, [loadCatalog, reset]);

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

      {section === 'pages' ? <PageBrowser /> : <RulesEditor />}
    </div>
  );
}

// ── 页面浏览 ────────────────────────────────────────────────────

function PageBrowser() {
  const catalog = useKbWikiStore((s) => s.catalog);
  const catalogLoading = useKbWikiStore((s) => s.catalogLoading);
  const catalogError = useKbWikiStore((s) => s.catalogError);
  const activePageId = useKbWikiStore((s) => s.activePageId);
  const openPage = useKbWikiStore((s) => s.openPage);

  // 按类型目录分组（保持 schema 路由顺序）
  const groups = useMemo(() => {
    if (!catalog) return [];
    return Object.entries(catalog.typeDirs).map(([type, dir]) => ({
      type: type as WikiPageType,
      dir,
      // schema 的 dir 与磁盘目录名大小写可能不一致（Windows 不敏感文件系统），
      // 归一化分隔符与大小写后再过滤，避免页面从分组中丢失
      pages: catalog.pages.filter((p) => p.relPath.replace(/\\/g, '/').toLowerCase().startsWith(`wiki/${dir.toLowerCase()}/`)),
    }));
  }, [catalog]);

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
      {/* 页面目录 */}
      <div className="w-60 shrink-0 overflow-y-auto border-r border-border py-2">
        {groups.map((g) => (
          <div key={g.dir} className="mb-2" data-testid={`wiki-group-${g.dir}`}>
            <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
              {g.dir} <span className="font-normal">({g.type})</span>
            </div>
            {g.pages.length === 0 ? (
              <div className="px-3 py-0.5 text-[11px] text-muted-foreground/60">（空）</div>
            ) : (
              g.pages.map((p) => (
                <button
                  key={p.pageId}
                  onClick={() => void openPage(p.pageId)}
                  data-testid={`wiki-page-${p.pageId}`}
                  className={cn(
                    'block w-full truncate px-3 py-1 text-left text-xs transition-colors',
                    p.parse.ok ? 'text-foreground hover:bg-secondary' : 'text-destructive',
                    activePageId === p.pageId ? 'bg-secondary font-medium' : '',
                  )}
                  title={p.parse.ok ? p.pageId : p.parse.issues.map((i) => i.message).join('\n')}
                >
                  {p.pageId}
                  {p.routeMismatch ? ' ⚠' : ''}
                </button>
              ))
            )}
          </div>
        ))}

        {catalog.aggregates.length > 0 && (
          <div className="mb-2">
            <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">聚合页</div>
            {catalog.aggregates.map((a) => (
              <button
                key={a.pageId}
                onClick={() => void openPage(a.pageId)}
                className={cn(
                  'block w-full truncate px-3 py-1 text-left text-xs transition-colors hover:bg-secondary',
                  activePageId === a.pageId ? 'bg-secondary font-medium' : '',
                )}
              >
                {a.pageId}
              </button>
            ))}
          </div>
        )}

        {catalog.orphans.length > 0 && (
          <div className="mb-2">
            <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground">
              路由外（{catalog.orphans.length}）
            </div>
            {catalog.orphans.map((o) => (
              <div key={o.relPath} className="truncate px-3 py-0.5 text-[11px] text-muted-foreground/70" title={o.relPath}>
                {o.relPath}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 页面正文 */}
      <div className="flex-1 overflow-hidden">
        <WikiPageView />
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
