// @vitest-environment jsdom
/**
 * KbWikiTasks PDF 资产查看面板行为测试（issue 11 — 用户查看可追溯资产并返回原页）。
 *
 * 覆盖：
 *  - .pdf 来源出现「图片」入口，展开后渲染清单摘要（资产数/页进度/失败）
 *  - 资产卡片：经 kb.pdfAssetFile 解析路径并以 local-resource:// 显示缩略图，
 *    页码徽标（返回原页信息）与提取方式标签可见
 *  - 点击卡片显示详情：像素尺寸、页内坐标（rect）、整页渲染参数
 *  - renderRemaining 非空 → 「继续渲染剩余」按钮按剩余页数组发起提取
 *  - 未提取过 → 「提取图片」按钮发起默认提取
 *  - 提取失败原因（stats.failures）可见
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted mock data ──────────────────────────────────────

const { sources, manifest } = vi.hoisted(() => {
  const sources = [
    {
      sourceId: 'sid-md',
      sourcePath: 'docs/alpha.md',
      ext: '.md',
      size: 100,
      revision: 'r1',
      revisionShort: 'r1',
      status: 'ready',
      parsedRevision: 'r1',
      parsedHash: 'h1',
      parsedStale: false,
      assetCount: 0,
      importedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      sourceId: 'sid-pdf',
      sourcePath: 'docs/spec.pdf',
      ext: '.pdf',
      size: 4096,
      revision: 'f'.repeat(64),
      revisionShort: 'f0f0f0f0',
      status: 'ready',
      parsedRevision: 'f'.repeat(64),
      parsedHash: 'h2',
      parsedStale: false,
      assetCount: 2,
      pdfAssets: { status: 'ready', assetCount: 2, updatedAt: '2026-01-01T00:00:02.000Z' },
      importedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
    },
  ];
  const manifest = {
    manifestVersion: 1,
    sourceId: 'sid-pdf',
    revision: 'f'.repeat(64),
    parsedHash: null,
    extractor: { runtime: 'resources', version: '5.4.296' },
    assets: [
      {
        assetId: 'a'.repeat(64),
        file: 'a.png',
        ext: 'png',
        method: 'object',
        page: 1,
        width: 2,
        height: 2,
        rect: { x: 120, y: 110, width: 40, height: 40 },
      },
      {
        assetId: 'b'.repeat(64),
        file: 'b.png',
        ext: 'png',
        method: 'page-render',
        page: 2,
        width: 400,
        height: 400,
        render: { scale: 2, maxEdge: 2048, scaled: false },
      },
    ],
    pages: [],
    stats: {
      totalPages: 4,
      processedPages: 4,
      failedPages: 1,
      skippedPages: 0,
      failures: [{ page: 5, reason: '位图对象不可解析: g_d0_img_p1_1' }],
      skipped: [],
      bitmapAssets: 1,
      renderAssets: 1,
      renderCandidates: [2],
      renderRendered: [2],
      renderRemaining: [3, 4],
      batchLimitReached: false,
      textPages: 1,
      cancelled: false,
    },
    extractions: [],
    textLayer: true,
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
  };
  return { sources, manifest };
});

// ─── Mock tRPC ──────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  queueSnapshotQuery: vi.fn(),
  pdfAssetsQuery: vi.fn(),
  pdfAssetFileQuery: vi.fn(),
  pdfAssetExtractMutate: vi.fn(),
  queueEnqueueMutate: vi.fn(),
}));

let currentSources: unknown[];

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      sources: {
        query: vi.fn(() => Promise.resolve(currentSources)),
        useQuery: vi.fn(() => ({ data: currentSources, isLoading: false })),
      },
      queueSnapshot: { query: mocks.queueSnapshotQuery },
      queueEnqueue: { mutate: mocks.queueEnqueueMutate.mockResolvedValue({ results: [{ ok: true }] }) },
      queuePause: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      queueResume: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      queueCancel: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      queueRetry: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      queueClear: { mutate: vi.fn().mockResolvedValue({ removed: 1 }) },
      wikiCompileEnqueue: { mutate: vi.fn().mockResolvedValue({ results: [{ ok: true }] }) },
      pdfAssets: { query: mocks.pdfAssetsQuery },
      pdfAssetFile: { query: mocks.pdfAssetFileQuery },
      pdfAssetExtract: { mutate: mocks.pdfAssetExtractMutate },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
    ),
    { getState: vi.fn(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })) },
  ),
}));

beforeEach(() => {
  currentSources = sources;
  (window as unknown as { eventBridge: unknown }).eventBridge = {
    onKbTask: () => () => {},
  };
  mocks.queueSnapshotQuery.mockResolvedValue({
    ok: true,
    snapshot: { kbId: 'kb-1', paused: false, seq: 1, restoredWaiting: false, lastPersistError: null, tasks: [] },
  });
  mocks.pdfAssetsQuery.mockResolvedValue({ manifest });
  mocks.pdfAssetFileQuery.mockImplementation((_input: unknown) => {
    const input = _input as { assetId: string };
    return Promise.resolve({ path: `D:\\kb\\assets\\${input.assetId}.png` });
  });
  mocks.pdfAssetExtractMutate.mockResolvedValue({ ok: true, dir: 'D:\\kb\\assets', written: 2, addedRecords: 2, manifest });
});

afterEach(() => {
  delete (window as unknown as { eventBridge?: unknown }).eventBridge;
  vi.clearAllMocks();
});

// ─── Import after mocks ─────────────────────────────────────

import { KbWikiTasks } from '@renderer/components/kb/KbWikiTasks';
import { useKbQueueStore } from '@renderer/stores/kb-queue';

describe('KbWikiTasks PDF 资产面板（issue 11）', () => {
  beforeEach(() => {
    useKbQueueStore.setState({ snapshot: null, snapshotState: 'idle' });
    mocks.queueSnapshotQuery.mockResolvedValue({
      ok: true,
      snapshot: { kbId: 'kb-1', paused: false, seq: 1, restoredWaiting: false, lastPersistError: null, tasks: [] },
    });
    mocks.pdfAssetsQuery.mockResolvedValue({ manifest });
    mocks.pdfAssetExtractMutate.mockClear();
  });

  it('.pdf 来源出现图片入口；展开渲染摘要、资产缩略图（local-resource）与页码', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/spec.pdf')).toBeTruthy());

    const open = screen.getByTitle('查看 PDF 图像资产');
    fireEvent.click(open);

    await waitFor(() => expect(screen.getByTestId('pdf-assets-panel')).toBeTruthy());
    // 摘要：资产数、页进度、失败数
    expect(screen.getByText(/资产 2/)).toBeTruthy();
    expect(screen.getByText(/页 4\/4/)).toBeTruthy();
    expect(screen.getByText(/失败 1/)).toBeTruthy();

    // 资产卡片：页码徽标 + 提取方式，路径经 pdfAssetFile 解析并转 local-resource
    await waitFor(() => expect(screen.getByTestId(`pdf-asset-${'a'.repeat(8)}`)).toBeTruthy());
    expect(mocks.pdfAssetFileQuery).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'sid-pdf', revision: 'f'.repeat(64), assetId: 'a'.repeat(64) }),
    );
    expect(screen.getByTestId(`pdf-asset-${'b'.repeat(8)}`)).toBeTruthy();
    expect(screen.getByText('第 1 页')).toBeTruthy();
    expect(screen.getByText('第 2 页')).toBeTruthy();
    expect(screen.getByText('位图')).toBeTruthy();
    expect(screen.getByText('整页渲染')).toBeTruthy();

    const img = (await screen.findByAltText('第 1 页 位图')) as HTMLImageElement;
    expect(img.src.startsWith('local-resource://app/')).toBe(true);
  });

  it('点击卡片显示详情：页内坐标与整页渲染参数', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/spec.pdf')).toBeTruthy());
    fireEvent.click(screen.getByTitle('查看 PDF 图像资产'));

    await waitFor(() => expect(screen.getByTestId(`pdf-asset-${'a'.repeat(8)}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`pdf-asset-${'b'.repeat(8)}`));

    await waitFor(() => expect(screen.getByTestId('pdf-asset-detail')).toBeTruthy());
    expect(screen.getByText(/400 × 400/)).toBeTruthy();
    expect(screen.getByText(/scale 2 · 最长边 2048/)).toBeTruthy();
    // 返回原页信息
    expect(screen.getByText(/原页：第 2 页/)).toBeTruthy();

    // 换位图卡片：rect 坐标可见
    fireEvent.click(screen.getByTestId(`pdf-asset-${'a'.repeat(8)}`));
    await waitFor(() => expect(screen.getByText(/位置 120, 110 · 40 × 40/)).toBeTruthy());
  });

  it('renderRemaining 非空：继续渲染按钮按剩余页数组发起提取', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/spec.pdf')).toBeTruthy());
    fireEvent.click(screen.getByTitle('查看 PDF 图像资产'));

    const btn = await screen.findByTitle('渲染剩余未渲染页');
    fireEvent.click(btn);

    await waitFor(() =>
      expect(mocks.pdfAssetExtractMutate).toHaveBeenCalledWith({ sourceId: 'sid-pdf', render: [3, 4] }),
    );
  });

  it('未提取过的来源显示提取入口，点击发起默认提取', async () => {
    mocks.pdfAssetsQuery.mockResolvedValue({ manifest: null });
    currentSources = sources.map((s) => ({ ...s, sourceId: 'sid-pdf' }));
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/spec.pdf')).toBeTruthy());
    fireEvent.click(screen.getByTitle('查看 PDF 图像资产'));

    const btn = await screen.findByTitle('提取 PDF 图像资产');
    fireEvent.click(btn);

    await waitFor(() => expect(mocks.pdfAssetExtractMutate).toHaveBeenCalledWith({ sourceId: 'sid-pdf' }));
  });

  it('提取失败页与原因可见', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/spec.pdf')).toBeTruthy());
    fireEvent.click(screen.getByTitle('查看 PDF 图像资产'));

    await waitFor(() => expect(screen.getByTestId('pdf-assets-panel')).toBeTruthy());
    expect(screen.getByText(/第 5 页/)).toBeTruthy();
    expect(screen.getByText(/位图对象不可解析/)).toBeTruthy();
  });
});
