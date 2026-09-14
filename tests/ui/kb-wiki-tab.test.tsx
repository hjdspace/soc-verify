// @vitest-environment jsdom
/**
 * KbWikiTab 页面分组过滤测试。
 *
 * 回归：schema 路由目录（typeDirs）与磁盘目录名大小写可能不一致
 * （Windows 大小写不敏感文件系统下主进程按 toLowerCase 匹配编目），
 * 分组过滤必须归一化分隔符与大小写，否则页面会从分组中静默丢失。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// ─── Mock data ──────────────────────────────────────────────

const { mockCatalog } = vi.hoisted(() => {
  const makeParse = (type: string) => ({
    ok: true as const,
    frontmatter: {
      type: type as 'concept' | 'source',
      title: 'T',
      summary: 'S',
      keywords: [],
      tags: [],
      sources: [],
      created: '2026-09-13T00:00:00Z',
      updated: '2026-09-13T00:00:00Z',
    },
    body: '',
  });
  return {
    mockCatalog: {
      ok: true as const,
      catalog: {
        // schema 中 concept 的目录为「Concepts」（大写），而磁盘编目 relPath 为小写
        typeDirs: { concept: 'Concepts', source: 'sources' } as Record<string, string>,
        pages: [
          {
            pageId: 'concepts/axi',
            relPath: 'wiki/concepts/axi.md',
            type: 'concept' as const,
            kind: 'page' as const,
            parse: makeParse('concept'),
            routeMismatch: false,
          },
          {
            pageId: 'sources/spec',
            relPath: 'wiki\\sources\\spec.md',
            type: 'source' as const,
            kind: 'page' as const,
            parse: makeParse('source'),
            routeMismatch: false,
          },
        ],
        aggregates: [],
        orphans: [],
      },
    },
  };
});

// ─── Mock tRPC ──────────────────────────────────────────────

const { wikiCatalogQueryMock, wikiSearchQueryMock, sourceParsedQueryMock, wikiPageQueryMock } = vi.hoisted(() => ({
  wikiCatalogQueryMock: vi.fn(),
  wikiSearchQueryMock: vi.fn(),
  sourceParsedQueryMock: vi.fn(),
  wikiPageQueryMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      wikiCatalog: { query: wikiCatalogQueryMock },
      wikiPage: { query: wikiPageQueryMock },
      wikiSearch: { query: wikiSearchQueryMock },
      sourceParsed: { query: sourceParsedQueryMock },
      wikiRules: { query: vi.fn().mockResolvedValue({ schemaRaw: '', purposeRaw: '', schemaParse: { ok: true, routing: { typeDirs: {} } } }) },
      saveWikiRules: { mutate: vi.fn() },
      validateWikiSchema: { mutate: vi.fn() },
    },
  },
}));

// ─── Mock toast store ───────────────────────────────────────

const { toastMocks } = vi.hoisted(() => ({
  toastMocks: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector(toastMocks)),
    { getState: () => toastMocks },
  ),
}));

// ─── Import after mocks ─────────────────────────────────────

import { KbWikiTab } from '@renderer/components/kb/KbWikiTab';
import { useKbWikiStore } from '@renderer/stores/kb-wiki';

beforeEach(() => {
  vi.clearAllMocks();
  wikiCatalogQueryMock.mockResolvedValue(mockCatalog);
  useKbWikiStore.setState({
    catalog: null,
    catalogLoading: false,
    catalogError: null,
    activePageId: null,
    activePage: null,
    pageLoading: false,
    schemaRaw: null,
    purposeRaw: null,
    rulesLoading: false,
    schemaDraft: null,
    purposeDraft: null,
    validation: { status: 'idle' },
    rulesSaving: false,
    search: {
      query: '', kindFilter: '' as const, pageTypeFilter: '', tagFilter: '',
      searching: false, hits: [], coverage: null, errorCode: null, errorMessage: null,
    },
  });
});

describe('KbWikiTab 页面分组（分隔符与大小写归一化）', () => {
  it('schema 目录大小写与 relPath 目录不一致时页面仍归入对应分组', async () => {
    render(<KbWikiTab />);
    const group = await screen.findByTestId('wiki-group-Concepts');
    await waitFor(() => {
      expect(within(group).getByTestId('wiki-page-concepts/axi')).toBeInTheDocument();
    });
  });

  it('relPath 使用反斜杠分隔符时按归一化路径归组', async () => {
    render(<KbWikiTab />);
    const group = await screen.findByTestId('wiki-group-sources');
    await waitFor(() => {
      expect(within(group).getByTestId('wiki-page-sources/spec')).toBeInTheDocument();
    });
  });

  it('页面不重复出现在其他分组', async () => {
    render(<KbWikiTab />);
    await screen.findByTestId('wiki-group-Concepts');
    const sourceGroup = screen.getByTestId('wiki-group-sources');
    expect(within(sourceGroup).queryByTestId('wiki-page-concepts/axi')).not.toBeInTheDocument();
  });
});

// ─── 知识检索面板（issue 14）────────────────────────────────

const searchHit = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'wiki',
  id: 'concepts/dds',
  relativePath: 'wiki/concepts/dds.md',
  absolutePath: 'D:/kb/wiki/concepts/dds.md',
  title: 'DDS 原理',
  snippet: '正文片段',
  pageType: 'concept',
  tags: ['单测'],
  keywords: [],
  sourceRefs: [],
  stale: false,
  score: 10,
  ...over,
});

describe('KbWikiTab 知识检索（issue 14 统一检索）', () => {
  const renderSearch = async (): Promise<void> => {
    render(<KbWikiTab />);
    await screen.findByTestId('wiki-group-Concepts');
    fireEvent.click(screen.getByTestId('kb-wiki-search-tab'));
    await screen.findByTestId('kb-wiki-search');
  };

  it('检索成功：结果列表渲染 kind/标题/stale 标记与覆盖状态', async () => {
    wikiSearchQueryMock.mockResolvedValue({
      ok: true,
      result: {
        mode: 'keyword', kbId: 'kb-1',
        coverage: { wikiPages: 2, parsedSources: 1 },
        hits: [
          searchHit({}),
          searchHit({ kind: 'parsed', id: 'src-1', pageType: null, title: 'dds.pdf', sourceRevision: 'rev-a' }),
          searchHit({ id: 'concepts/old', title: '过期页', stale: true }),
        ],
      },
    });
    await renderSearch();

    fireEvent.change(screen.getByTestId('kb-wiki-search-input'), { target: { value: 'DDS' } });
    fireEvent.click(screen.getByTestId('kb-wiki-search-run'));

    await screen.findByTestId('kb-wiki-search-results');
    expect(screen.getByTestId('kb-wiki-search-hit-wiki-concepts/dds')).toBeInTheDocument();
    expect(screen.getByTestId('kb-wiki-search-hit-parsed-src-1')).toBeInTheDocument();
    expect(screen.getByTestId('kb-wiki-search-hit-wiki-concepts/old')).toBeInTheDocument();
    expect(screen.getByText('来源已更新')).toBeInTheDocument(); // stale 标记
    expect(screen.getByTestId('kb-wiki-search-coverage').textContent).toContain('命中 3 条');
    expect(wikiSearchQueryMock).toHaveBeenCalledWith({ query: 'DDS' }); // 无筛选时不带筛选参数
  });

  it('点击 wiki 命中：切到知识页区并打开该页', async () => {
    wikiSearchQueryMock.mockResolvedValue({
      ok: true,
      result: { mode: 'keyword', kbId: 'kb-1', coverage: { wikiPages: 1, parsedSources: 0 },
        hits: [searchHit({})] },
    });
    wikiPageQueryMock.mockResolvedValue({
      pageId: 'concepts/dds', relPath: 'wiki/concepts/dds.md', kind: 'page',
      content: '# DDS', parse: { ok: true, frontmatter: { type: 'concept', title: 'DDS 原理',
        summary: 'S', keywords: [], tags: [], sources: [],
        created: '2026-09-13T00:00:00Z', updated: '2026-09-13T00:00:00Z' } },
      links: [],
    });
    await renderSearch();

    fireEvent.change(screen.getByTestId('kb-wiki-search-input'), { target: { value: 'DDS' } });
    fireEvent.click(screen.getByTestId('kb-wiki-search-run'));
    fireEvent.click(await screen.findByTestId('kb-wiki-search-hit-wiki-concepts/dds'));

    // 切回知识页区并打开了对应页面
    await waitFor(() => {
      expect(screen.getByTestId('wiki-page-concepts/axi')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(useKbWikiStore.getState().activePageId).toBe('concepts/dds');
    });
  });

  it('点击 parsed 命中：浮层预览机械全文（kb.sourceParsed）', async () => {
    wikiSearchQueryMock.mockResolvedValue({
      ok: true,
      result: { mode: 'keyword', kbId: 'kb-1', coverage: { wikiPages: 0, parsedSources: 1 },
        hits: [searchHit({ kind: 'parsed', id: 'src-1', pageType: null, title: 'dds.pdf', sourceRevision: 'rev-a' })] },
    });
    sourceParsedQueryMock.mockResolvedValue({ sourceId: 'src-1', revision: 'rev-a', content: '# 机械全文\n', isHistorical: false });
    await renderSearch();

    fireEvent.change(screen.getByTestId('kb-wiki-search-input'), { target: { value: 'DDS' } });
    fireEvent.click(screen.getByTestId('kb-wiki-search-run'));
    fireEvent.click(await screen.findByTestId('kb-wiki-search-hit-parsed-src-1'));

    await screen.findByTestId('kb-wiki-parsed-preview');
    expect(await screen.findByText('# 机械全文')).toBeInTheDocument();
    expect(sourceParsedQueryMock).toHaveBeenCalledWith({ sourceId: 'src-1' });

    fireEvent.click(screen.getByTestId('kb-wiki-parsed-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('kb-wiki-parsed-preview')).not.toBeInTheDocument();
    });
  });

  it('服务失败（未挂载/门禁）：错误态可见', async () => {
    wikiSearchQueryMock.mockRejectedValue(new Error('当前挂载的不是 wiki 布局知识库'));
    await renderSearch();

    fireEvent.change(screen.getByTestId('kb-wiki-search-input'), { target: { value: 'DDS' } });
    fireEvent.click(screen.getByTestId('kb-wiki-search-run'));

    const err = await screen.findByTestId('kb-wiki-search-error');
    expect(err.textContent).toContain('wiki 布局');
  });

  it('检索无结果：空态提示', async () => {
    wikiSearchQueryMock.mockResolvedValue({
      ok: true,
      result: { mode: 'keyword', kbId: 'kb-1', coverage: { wikiPages: 2, parsedSources: 1 }, hits: [] },
    });
    await renderSearch();

    fireEvent.change(screen.getByTestId('kb-wiki-search-input'), { target: { value: '不存在' } });
    fireEvent.click(screen.getByTestId('kb-wiki-search-run'));

    await screen.findByTestId('kb-wiki-search-empty');
  });
});
