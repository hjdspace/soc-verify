// @vitest-environment jsdom
/**
 * KbWikiTab 页面分组过滤测试。
 *
 * 回归：schema 路由目录（typeDirs）与磁盘目录名大小写可能不一致
 * （Windows 大小写不敏感文件系统下主进程按 toLowerCase 匹配编目），
 * 分组过滤必须归一化分隔符与大小写，否则页面会从分组中静默丢失。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

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

const { wikiCatalogQueryMock } = vi.hoisted(() => ({
  wikiCatalogQueryMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      wikiCatalog: { query: wikiCatalogQueryMock },
      wikiPage: { query: vi.fn() },
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
