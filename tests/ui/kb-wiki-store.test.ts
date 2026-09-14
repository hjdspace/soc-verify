// @vitest-environment jsdom
/**
 * kb-wiki store 行为测试（issue 04 — 只读浏览与规则编辑）。
 *
 * 覆盖：编目加载（成功/schema 失败）、页面打开、链接跟随
 * （resolved 跳转 / ambiguous 列候选不猜第一个 / unresolved 提示）、
 * schema 草稿防抖即时校验、规则保存（校验失败拦截、pageDirRemap
 * 失败透传、成功后刷新编目）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock data ──────────────────────────────────────────────

const { mockCatalog, mockPage, mockRules } = vi.hoisted(() => ({
  mockCatalog: {
    ok: true as const,
    catalog: {
      typeDirs: { concept: 'concepts', source: 'sources' },
      pages: [
        {
          pageId: 'concepts/axi',
          relPath: 'wiki/concepts/axi.md',
          type: 'concept' as const,
          kind: 'page' as const,
          parse: {
            ok: true as const,
            frontmatter: {
              type: 'concept' as const, title: 'AXI', summary: 'S',
              keywords: [], tags: [], sources: [],
              created: '2026-09-13T00:00:00Z', updated: '2026-09-13T00:00:00Z',
            },
            body: '',
          },
          routeMismatch: false,
        },
      ],
      aggregates: [{ pageId: 'index', relPath: 'wiki/index.md', kind: 'aggregate' as const }],
      orphans: [],
    },
  },
  mockPage: {
    pageId: 'concepts/axi',
    relPath: 'wiki/concepts/axi.md',
    kind: 'page' as const,
    content: '# AXI\n\n[[sources/spec|规范]] [[dup]] [[missing]]',
    parse: {
      ok: true as const,
      frontmatter: {
        type: 'concept' as const, title: 'AXI', summary: 'S',
        keywords: [], tags: [], sources: [],
        created: '2026-09-13T00:00:00Z', updated: '2026-09-13T00:00:00Z',
      },
      body: '',
    },
    links: [
      { kind: 'link' as const, target: 'sources/spec', resolution: { status: 'resolved' as const, pageId: 'sources/spec' } },
      { kind: 'link' as const, target: 'dup', resolution: { status: 'ambiguous' as const, candidates: ['sources/dup', 'concepts/dup'] } },
      { kind: 'link' as const, target: 'missing', resolution: { status: 'unresolved' as const } },
    ],
  },
  mockRules: {
    schemaRaw: '# schema\n',
    purposeRaw: '# purpose\n',
    schemaParse: { ok: true as const, routing: { typeDirs: {} } },
  },
}));

// ─── Mock tRPC ──────────────────────────────────────────────

const { wikiCatalogQueryMock, wikiPageMock, saveRulesMock, validateSchemaMock, wikiSearchMock, sourceParsedMock } = vi.hoisted(() => ({
  wikiCatalogQueryMock: vi.fn(),
  wikiPageMock: vi.fn(),
  saveRulesMock: vi.fn(),
  validateSchemaMock: vi.fn(),
  wikiSearchMock: vi.fn(),
  sourceParsedMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      wikiCatalog: { query: wikiCatalogQueryMock },
      wikiPage: { query: wikiPageMock },
      wikiRules: { query: vi.fn().mockResolvedValue(mockRules) },
      saveWikiRules: { mutate: saveRulesMock },
      validateWikiSchema: { mutate: validateSchemaMock },
      wikiSearch: { query: wikiSearchMock },
      sourceParsed: { query: sourceParsedMock },
    },
  },
}));

// ─── Mock toast store ───────────────────────────────────────

const { toastMocks } = vi.hoisted(() => ({
  toastMocks: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector(toastMocks)),
    { getState: () => toastMocks },
  ),
}));

// ─── Import after mocks ─────────────────────────────────────

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
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('编目与页面', () => {
  it('loadCatalog 成功写入 catalog', async () => {
    await useKbWikiStore.getState().loadCatalog();
    expect(useKbWikiStore.getState().catalog?.pages).toHaveLength(1);
    expect(useKbWikiStore.getState().catalogError).toBeNull();
  });

  it('loadCatalog schema 失败 → catalogError 带问题清单', async () => {
    wikiCatalogQueryMock.mockResolvedValueOnce({
      ok: false,
      schemaIssues: [{ code: 'missingPageTypes', message: 'schema.md 缺少 Page Types 段' }],
    });
    await useKbWikiStore.getState().loadCatalog();
    const s = useKbWikiStore.getState();
    expect(s.catalog).toBeNull();
    expect(s.catalogError).toContain('Page Types');
  });

  it('openPage 拉取页面内容', async () => {
    wikiPageMock.mockResolvedValue(mockPage);
    await useKbWikiStore.getState().openPage('concepts/axi');
    const s = useKbWikiStore.getState();
    expect(wikiPageMock).toHaveBeenCalledWith({ pageId: 'concepts/axi' });
    expect(s.activePage?.pageId).toBe('concepts/axi');
    expect(s.pageLoading).toBe(false);
  });
});

describe('链接跟随（复用主进程解析结论）', () => {
  beforeEach(async () => {
    wikiPageMock.mockResolvedValue(mockPage);
    await useKbWikiStore.getState().openPage('concepts/axi');
  });

  it('resolved → 打开目标页', async () => {
    await useKbWikiStore.getState().followLink('sources/spec');
    expect(wikiPageMock).toHaveBeenLastCalledWith({ pageId: 'sources/spec' });
  });

  it('ambiguous → 警告并列出全部候选，不打开页面', async () => {
    await useKbWikiStore.getState().followLink('dup');
    expect(toastMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('歧义'),
      expect.stringContaining('sources/dup'),
    );
    expect(wikiPageMock).toHaveBeenCalledTimes(1); // 只有 beforeEach 的 openPage
  });

  it('unresolved → 警告未解析，不打开页面', async () => {
    await useKbWikiStore.getState().followLink('missing');
    expect(toastMocks.warning).toHaveBeenCalledWith(expect.stringContaining('未解析'), expect.anything());
    expect(wikiPageMock).toHaveBeenCalledTimes(1);
  });
});

describe('写作规则', () => {
  it('loadRules 装载草稿', async () => {
    await useKbWikiStore.getState().loadRules();
    const s = useKbWikiStore.getState();
    expect(s.schemaDraft).toBe('# schema\n');
    expect(s.purposeDraft).toBe('# purpose\n');
  });

  it('setSchemaDraft 防抖后即时校验，丢弃过期响应', async () => {
    vi.useFakeTimers();
    validateSchemaMock.mockResolvedValue({ ok: true, routing: { typeDirs: {} } });
    await useKbWikiStore.getState().loadRules();
    useKbWikiStore.getState().setSchemaDraft('# 新草稿\n');
    expect(useKbWikiStore.getState().validation.status).toBe('validating');
    await vi.advanceTimersByTimeAsync(400);
    expect(validateSchemaMock).toHaveBeenCalledWith({ schemaRaw: '# 新草稿\n' });
    expect(useKbWikiStore.getState().validation.status).toBe('valid');
  });

  it('saveRules：校验未通过时拒绝保存请求', async () => {
    useKbWikiStore.setState({
      schemaRaw: '# 旧\n',
      schemaDraft: '# 新\n',
      purposeRaw: null,
      purposeDraft: null,
      validation: { status: 'invalid', issues: [{ code: 'missingType', message: '缺少类型行' }] },
    });
    const ok = await useKbWikiStore.getState().saveRules();
    expect(ok).toBe(false);
    expect(saveRulesMock).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalled();
  });

  it('saveRules：成功后更新基线并刷新编目', async () => {
    saveRulesMock.mockResolvedValue({ ok: true, saved: { schema: true, purpose: false } });
    useKbWikiStore.setState({
      schemaRaw: '# 旧\n',
      schemaDraft: '# 新\n',
      purposeRaw: '# p\n',
      purposeDraft: '# p\n',
      validation: { status: 'valid' },
    });
    const ok = await useKbWikiStore.getState().saveRules();
    expect(ok).toBe(true);
    expect(saveRulesMock).toHaveBeenCalledWith({ schemaRaw: '# 新\n' });
    expect(useKbWikiStore.getState().schemaRaw).toBe('# 新\n');
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it('saveRules：pageDirRemap 失败透传错误信息', async () => {
    saveRulesMock.mockResolvedValue({
      ok: false,
      error: { code: 'pageDirRemap', message: '类型「concept」的目录变更会影响已有页面，需要专门的迁移流程' },
    });
    useKbWikiStore.setState({
      schemaRaw: '# 旧\n',
      schemaDraft: '# 新\n',
      purposeRaw: null,
      purposeDraft: null,
      validation: { status: 'valid' },
    });
    const ok = await useKbWikiStore.getState().saveRules();
    expect(ok).toBe(false);
    expect(toastMocks.error).toHaveBeenCalledWith('保存写作规则失败', expect.stringContaining('会影响已有页面'));
  });

  it('saveRules：无变更时直接返回成功（不发起请求）', async () => {
    useKbWikiStore.setState({ schemaRaw: '# 同\n', schemaDraft: '# 同\n', purposeRaw: null, purposeDraft: null });
    const ok = await useKbWikiStore.getState().saveRules();
    expect(ok).toBe(true);
    expect(saveRulesMock).not.toHaveBeenCalled();
  });
});

// ─── 知识检索（issue 14）────────────────────────────────────

const searchOkResponse = {
  ok: true as const,
  result: {
    mode: 'keyword' as const,
    kbId: 'kb-1',
    coverage: { wikiPages: 8, parsedSources: 2 },
    hits: [
      {
        kind: 'wiki' as const,
        id: 'concepts/dds',
        relativePath: 'wiki/concepts/dds.md',
        absolutePath: 'D:/kb/wiki/concepts/dds.md',
        title: 'DDS',
        snippet: null,
        pageType: 'concept' as const,
        tags: ['单测'],
        keywords: [],
        sourceRefs: [],
        stale: false,
        score: 10,
      },
      {
        kind: 'parsed' as const,
        id: 'src-1',
        relativePath: 'raw/parsed/spec/dds.pdf.md',
        absolutePath: 'D:/kb/raw/parsed/spec/dds.pdf.md',
        title: 'dds.pdf',
        snippet: '…DDS…',
        stale: false,
        sourceRevision: 'rev-a',
        score: 1,
      },
    ],
  },
};

describe('kb-wiki store — runSearch（issue 14 统一检索）', () => {
  beforeEach(() => {
    useKbWikiStore.setState({
      search: {
        query: '',
        kindFilter: '',
        pageTypeFilter: '',
        tagFilter: '',
        searching: false,
        hits: [],
        coverage: null,
        errorCode: null,
        errorMessage: null,
      },
    });
  });

  it('空 query 拦截：提示输入关键词且不发起请求', async () => {
    useKbWikiStore.setState({
      search: { ...useKbWikiStore.getState().search, query: '   ' },
    });
    await useKbWikiStore.getState().runSearch();
    expect(useKbWikiStore.getState().search.errorMessage).toBe('请输入检索关键词');
    expect(wikiSearchMock).not.toHaveBeenCalled();
  });

  it('成功：hits/coverage 写入；kind/pageType/tag 筛选随请求透传', async () => {
    wikiSearchMock.mockResolvedValueOnce(searchOkResponse);
    useKbWikiStore.setState({
      search: {
        query: 'DDS',
        kindFilter: 'wiki',
        pageTypeFilter: 'concept',
        tagFilter: '单测',
        searching: false,
        hits: [],
        coverage: null,
        errorCode: null,
        errorMessage: null,
      },
    });

    await useKbWikiStore.getState().runSearch();

    expect(wikiSearchMock).toHaveBeenCalledWith({
      query: 'DDS',
      kind: 'wiki',
      pageType: 'concept',
      tag: '单测',
    });
    const search = useKbWikiStore.getState().search;
    expect(search.searching).toBe(false);
    expect(search.errorCode).toBeNull();
    expect(search.errorMessage).toBeNull();
    expect(search.hits).toHaveLength(2);
    expect(search.coverage).toEqual({ wikiPages: 8, parsedSources: 2 });
  });

  it('服务返回 ok:false（如门禁暂停）：errorCode/errorMessage 透传，hits 清空', async () => {
    wikiSearchMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'readGateBlocked', message: '知识库存在未恢复的发布事务' },
    });
    useKbWikiStore.setState({
      search: { ...useKbWikiStore.getState().search, query: 'DDS', hits: searchOkResponse.result.hits },
    });

    await useKbWikiStore.getState().runSearch();

    const search = useKbWikiStore.getState().search;
    expect(search.errorCode).toBe('readGateBlocked');
    expect(search.errorMessage).toContain('未恢复的发布事务');
    expect(search.hits).toEqual([]);
    expect(search.coverage).toBeNull();
  });

  it('请求异常（如未挂载 PRECONDITION_FAILED）：requestFailed', async () => {
    wikiSearchMock.mockRejectedValueOnce(new Error('当前挂载的不是 wiki 布局知识库'));
    useKbWikiStore.setState({ search: { ...useKbWikiStore.getState().search, query: 'DDS' } });

    await useKbWikiStore.getState().runSearch();

    const search = useKbWikiStore.getState().search;
    expect(search.errorCode).toBe('requestFailed');
    expect(search.errorMessage).toContain('wiki 布局');
    expect(search.hits).toEqual([]);
  });

  it('setSearchQuery / setSearchFilters 更新对应字段', () => {
    useKbWikiStore.getState().setSearchQuery('axi');
    useKbWikiStore.getState().setSearchFilters({ kindFilter: 'parsed', tagFilter: '时序' });
    const search = useKbWikiStore.getState().search;
    expect(search.query).toBe('axi');
    expect(search.kindFilter).toBe('parsed');
    expect(search.tagFilter).toBe('时序');
  });
});
