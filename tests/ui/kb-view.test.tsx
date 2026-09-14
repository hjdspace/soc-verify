// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted mock data ──────────────────────────────────────

const { mockKbList, mockKbStatus, mockKbStatusLegacy, mockCategories, mockDocuments } = vi.hoisted(() => {
  const mockKbList = [
    {
      id: 'kb-1',
      name: '芯片验证文档库',
      path: 'D:\\docs\\soc-kb',
      registeredAt: 1700000000000,
      format: 'wiki' as const,
      state: 'ok' as const,
      documentCount: 0,
      categoryCount: 0,
      isMounted: true,
    },
    {
      id: 'kb-2',
      name: '通用协议手册库',
      path: 'E:\\shared\\amba-refs',
      registeredAt: 1700000001000,
      format: 'wiki' as const,
      state: 'ok' as const,
      documentCount: 0,
      categoryCount: 0,
      isMounted: false,
    },
  ];

  const mockKbStatus = {
    mounted: {
      kbId: 'kb-1',
      mountedAt: 1700000002000,
      name: '芯片验证文档库',
      path: 'D:\\docs\\soc-kb',
      format: 'wiki' as const,
      state: 'ok' as const,
    },
    health: { hasSources: false, hasDocs: false, hasIndex: false },
    wikiHealth: { hasSchema: true, hasPurpose: true, hasManifest: true, hasRaw: true, hasWiki: true },
  };

  const mockKbStatusLegacy = {
    mounted: {
      kbId: 'kb-1',
      mountedAt: 1700000002000,
      name: '芯片验证文档库',
      path: 'D:\\docs\\soc-kb',
      format: 'legacy' as const,
      state: 'ok' as const,
    },
    health: { hasSources: true, hasDocs: true, hasIndex: true },
    wikiHealth: null,
  };

  const mockCategories = [
    { name: '协议手册', count: 8 },
    { name: 'DVT 计划', count: 4 },
    { name: '寄存器手册', count: 6 },
  ];

  const mockDocuments = [
    {
      name: 'AMBA AXI 协议规范 v4.1',
      sourceExt: '.pdf',
      sourcePath: 'D:\\docs\\soc-kb\\sources\\AMBA_AXI_v4.1.pdf',
      markdownPath: 'D:\\docs\\soc-kb\\docs\\协议手册\\AMBA_AXI_v4.1.md',
      category: '协议手册',
      sourceSize: 4400000,
      markdownSize: 386000,
      assetCount: 27,
      status: 'done' as const,
      convertedAt: 1700000003000,
      classifiedAt: 1700000004000,
    },
    {
      name: 'DDR5 PHY 寄存器手册',
      sourceExt: '.docx',
      sourcePath: 'D:\\docs\\soc-kb\\sources\\ddr5_phy_regs.docx',
      markdownPath: '',
      category: '',
      sourceSize: 6100000,
      markdownSize: 0,
      assetCount: 0,
      status: 'converting' as const,
    },
    {
      name: '低功耗设计评审纪要',
      sourceExt: '.pdf',
      sourcePath: 'D:\\docs\\soc-kb\\sources\\lp_review_scan.pdf',
      markdownPath: '',
      category: '',
      sourceSize: 12400000,
      markdownSize: 0,
      assetCount: 0,
      status: 'failed' as const,
      errorCode: 'unsupported',
      errorMessage: '扫描版 PDF 无文字层',
    },
    {
      name: 'UVM 环境搭建入门培训',
      sourceExt: '.pptx',
      sourcePath: 'D:\\docs\\soc-kb\\sources\\uvm_env_training.pptx',
      markdownPath: 'D:\\docs\\soc-kb\\docs\\培训材料\\uvm_env_training.md',
      category: '培训材料',
      sourceSize: 8900000,
      markdownSize: 210000,
      assetCount: 15,
      status: 'classifying' as const,
      convertedAt: 1700000005000,
    },
  ];

  return { mockKbList, mockKbStatus, mockKbStatusLegacy, mockCategories, mockDocuments };
});

// ─── Mock tRPC ──────────────────────────────────────────────

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      list: { query: vi.fn().mockResolvedValue(mockKbList) },
      status: { query: vi.fn().mockResolvedValue(mockKbStatus) },
      categories: { query: vi.fn().mockResolvedValue(mockCategories) },
      documents: { query: vi.fn().mockResolvedValue(mockDocuments) },
      upload: { mutate: vi.fn().mockResolvedValue({ results: [{ ok: true, document: mockDocuments[0] }] }) },
      retry: { mutate: vi.fn().mockResolvedValue({ ok: true, document: mockDocuments[0] }) },
      delete: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      register: { mutate: vi.fn().mockResolvedValue({ ok: true, id: 'kb-3', name: '新库', path: 'D:\\new', registeredAt: 0, format: 'wiki' }) },
      unregister: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      mount: { mutate: vi.fn().mockResolvedValue({ ok: true, data: { kbId: 'kb-2', mountedAt: 0 }, recovery: { cleaned: 0, rolledForward: 0, rolledBack: 0, failures: [] } }) },
      unmount: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      disposals: { query: vi.fn().mockResolvedValue([]) },
      dismissDisposal: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      index: { mutate: vi.fn().mockResolvedValue({ content: '# 知识库索引\n\n## 协议手册\n\n### AMBA AXI 协议规范 v4.1\n- **路径**: `协议手册/AMBA_AXI_v4.1.md`\n- **摘要**: AXI4 协议规范\n- **关键词**: `AXI` · `总线`\n' }) },
      preview: { query: vi.fn().mockResolvedValue({ content: '# AMBA AXI 协议规范 v4.1\n\nAXI4 通道信号定义。\n\n## Chapter A2' }) },
      pickFiles: { mutate: vi.fn().mockResolvedValue({ canceled: true }) },
    },
    project: {
      pickFiles: { mutate: vi.fn().mockResolvedValue({ canceled: true }) },
    },
    scan: {
      pickDirectory: { mutate: vi.fn().mockResolvedValue({ canceled: true, path: null }) },
    },
  },
}));

// ─── Mock toast store ───────────────────────────────────────

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
      }),
    ),
    {
      getState: () => ({
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
      }),
    },
  ),
}));

// ─── Mock eventBridge ───────────────────────────────────────

const kbDocStatusCallbacks: Array<(data: {
  name: string;
  status: 'queued' | 'converting' | 'classifying' | 'done' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  category?: string;
}) => void> = [];

beforeEach(() => {
  kbDocStatusCallbacks.length = 0;
  (window as unknown as { eventBridge: unknown }).eventBridge = {
    onKbDocStatus: (callback: typeof kbDocStatusCallbacks[0]) => {
      kbDocStatusCallbacks.push(callback);
      return () => {
        const idx = kbDocStatusCallbacks.indexOf(callback);
        if (idx >= 0) kbDocStatusCallbacks.splice(idx, 1);
      };
    },
  };
});

afterEach(() => {
  delete (window as unknown as { eventBridge?: unknown }).eventBridge;
});

// ─── Import after mocks ─────────────────────────────────────

import { KbView } from '@renderer/components/kb/KbView';
import { useKbStore } from '@renderer/stores/kb';

// ─── Helper: reset store ────────────────────────────────────

function resetKbStore() {
  useKbStore.setState({
    kbList: [],
    kbListLoading: false,
    kbStatus: null,
    kbStatusLoading: false,
    categories: [],
    categoriesLoading: false,
    selectedCategory: null,
    documents: [],
    documentsLoading: false,
    uploading: false,
    kbModalOpen: false,
    activeTab: 'list',
    indexContent: '',
    indexLoading: false,
    indexEditing: false,
    indexSaving: false,
    previewDocName: null,
    previewContent: null,
    previewLoading: false,
  });
}

// ─── Tests ──────────────────────────────────────────────────

describe('KbView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetKbStore();
  });

  // ── 未挂载状态 ───────────────────────────────────────────

  describe('unmounted state', () => {
    beforeEach(async () => {
      // Mock loadKbStatus to return unmounted state for these tests
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.status.query).mockResolvedValue({
        mounted: null,
        health: { hasSources: false, hasDocs: false, hasIndex: false },
        wikiHealth: null,
      });
    });

    it('shows "未挂载知识库" message when no KB is mounted', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('未挂载知识库')).toBeTruthy();
      });
    });

    it('shows "注册 / 挂载知识库" button when unmounted', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('注册 / 挂载知识库')).toBeTruthy();
      });
    });

    it('opens kb modal when button clicked', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('注册 / 挂载知识库')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('注册 / 挂载知识库'));

      expect(useKbStore.getState().kbModalOpen).toBe(true);
    });
  });

  // ── 已挂载状态 ───────────────────────────────────────────

  describe('mounted state', () => {
    beforeEach(async () => {
      // Re-set mock default returns (vi.clearAllMocks doesn't clear implementations
      // but unmounted-state's beforeEach may have overridden them)
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.status.query).mockResolvedValue(mockKbStatusLegacy);
      vi.mocked(trpc.kb.list.query).mockResolvedValue(mockKbList);
      vi.mocked(trpc.kb.categories.query).mockResolvedValue(mockCategories);
      vi.mocked(trpc.kb.documents.query).mockResolvedValue(mockDocuments);

      useKbStore.setState({
        kbList: mockKbList,
        kbStatus: mockKbStatusLegacy,
        kbStatusLoading: false,
        categories: mockCategories,
        categoriesLoading: false,
        documents: mockDocuments,
        documentsLoading: false,
      });
    });

    it('renders library header with KB name', () => {
      render(<KbView />);

      expect(screen.getByText('芯片验证文档库')).toBeTruthy();
    });

    it('renders library path with format', () => {
      useKbStore.setState({ kbStatus: mockKbStatus });
      render(<KbView />);

      expect(screen.getByText(/D:\\docs\\soc-kb · wiki/)).toBeTruthy();
    });

    it('renders wiki capability banner for wiki-format mount', () => {
      useKbStore.setState({ kbStatus: mockKbStatus });
      render(<KbView />);

      expect(screen.getByText(/新布局（LLM Wiki）知识库已挂载/)).toBeTruthy();
    });

    it('disables upload button for wiki-format mount', () => {
      useKbStore.setState({ kbStatus: mockKbStatus });
      render(<KbView />);

      const uploadButton = screen.getByText('上传文档').closest('button');
      expect(uploadButton?.disabled).toBe(true);
      expect(uploadButton?.title).toContain('暂不支持文档导入');
    });

    it('renders manifest readiness label instead of index for wiki mount', () => {
      useKbStore.setState({ kbStatus: mockKbStatus });
      render(<KbView />);

      expect(screen.getByText('清单')).toBeTruthy();
      expect(screen.queryByText('索引')).toBeNull();
    });

    it('renders document count stat label', () => {
      render(<KbView />);

      expect(screen.getByText('文档')).toBeTruthy();
    });

    it('renders category count stat label', () => {
      render(<KbView />);

      expect(screen.getByText('分类')).toBeTruthy();
    });

    it('renders upload button', () => {
      render(<KbView />);

      expect(screen.getByText('上传文档')).toBeTruthy();
    });

    // ── 分类树面板 ─────────────────────────────────────────

    it('renders "全部文档" category item', () => {
      render(<KbView />);

      expect(screen.getByText('全部文档')).toBeTruthy();
    });

    it('renders all categories from store', () => {
      render(<KbView />);

      expect(screen.getByText('协议手册')).toBeTruthy();
      expect(screen.getByText('DVT 计划')).toBeTruthy();
      expect(screen.getByText('寄存器手册')).toBeTruthy();
    });

    it('filters documents when category is selected', async () => {
      render(<KbView />);

      // Wait for docs to load
      await waitFor(() => {
        expect(screen.getByText('AMBA AXI 协议规范 v4.1')).toBeTruthy();
      });
      expect(screen.getByText('UVM 环境搭建入门培训')).toBeTruthy();

      // Click a category — use getAllByText and pick the sidebar one
      const catButtons = screen.getAllByText('协议手册');
      const sidebarCat = catButtons.find((el) =>
        el.closest('aside') !== null,
      );
      fireEvent.click(sidebarCat!);

      // Should still show protocol docs
      expect(screen.getByText('AMBA AXI 协议规范 v4.1')).toBeTruthy();
      // Training doc should be filtered out
      expect(screen.queryByText('UVM 环境搭建入门培训')).toBeNull();
    });

    it('shows all documents when "全部文档" is clicked after filtering', async () => {
      render(<KbView />);

      // Wait for docs to load
      await waitFor(() => {
        expect(screen.getByText('AMBA AXI 协议规范 v4.1')).toBeTruthy();
      });

      // Filter to protocol — click the sidebar category
      const catButtons = screen.getAllByText('协议手册');
      const sidebarCat = catButtons.find((el) =>
        el.closest('aside') !== null,
      );
      fireEvent.click(sidebarCat!);
      expect(screen.queryByText('UVM 环境搭建入门培训')).toBeNull();

      // Click "全部文档" in the sidebar
      fireEvent.click(screen.getByText('全部文档'));
      expect(screen.getByText('UVM 环境搭建入门培训')).toBeTruthy();
    });

    // ── 文档列表状态形态 ─────────────────────────────────

    it('renders done status badge for converted documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('✓ 已转换')).toBeTruthy();
      });
    });

    it('renders converting status with spinner', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('转换中')).toBeTruthy();
      });
    });

    it('renders classifying status', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('AI 分类中')).toBeTruthy();
      });
    });

    it('renders failed status with error code', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('转换失败')).toBeTruthy();
      });
      expect(screen.getByText(/unsupported/)).toBeTruthy();
      expect(screen.getByText(/扫描版 PDF 无文字层/)).toBeTruthy();
    });

    // ── 行内操作 ───────────────────────────────────────────

    it('renders retry button for failed documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        const retryButtons = screen.getAllByTitle('重试');
        expect(retryButtons.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('renders delete button for done documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        const deleteButtons = screen.getAllByTitle('删除');
        expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('does not render retry button for done documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        // Only the failed doc should have retry
        const retryButtons = screen.getAllByTitle('重试');
        expect(retryButtons.length).toBe(1);
      });
    });

    it('triggers retry when retry button is clicked', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByTitle('重试')).toBeTruthy();
      });
      const retryButton = screen.getByTitle('重试');
      fireEvent.click(retryButton);

      const { trpc } = await import('@renderer/lib/trpc');
      await waitFor(() => {
        expect(trpc.kb.retry.mutate).toHaveBeenCalled();
      });
    });

    it('shows delete confirmation on first click', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getAllByTitle('删除').length).toBeGreaterThanOrEqual(1);
      });
      const deleteButton = screen.getAllByTitle('删除')[0];
      fireEvent.click(deleteButton);

      const confirmButton = screen.getAllByTitle('再次点击确认删除')[0];
      expect(confirmButton).toBeTruthy();
    });

    it('triggers delete on second click (confirmation)', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getAllByTitle('删除').length).toBeGreaterThanOrEqual(1);
      });
      const deleteButton = screen.getAllByTitle('删除')[0];
      fireEvent.click(deleteButton);

      const confirmButton = screen.getAllByTitle('再次点击确认删除')[0];
      fireEvent.click(confirmButton);

      const { trpc } = await import('@renderer/lib/trpc');
      await waitFor(() => {
        expect(trpc.kb.delete.mutate).toHaveBeenCalled();
      });
    });

    // ── 拖拽上传区 ─────────────────────────────────────────

    it('renders drag-drop upload zone', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('拖拽文档到此处，或点击选择文件')).toBeTruthy();
      });
    });

    it('renders supported format list', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText(/pdf.*doc.*ppt.*xls.*csv/)).toBeTruthy();
      });
    });

    it('renders empty state when documents list is empty', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.documents.query).mockResolvedValue([]);
      useKbStore.setState({ documents: [], documentsLoading: false });
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('暂无文档，上传开始使用知识库')).toBeTruthy();
      });
    });

    // ── 事件驱动刷新 ───────────────────────────────────────

    it('subscribes to kb:docStatus events on mount', () => {
      render(<KbView />);

      expect(kbDocStatusCallbacks.length).toBe(1);
    });

    it('updates document status when kb:docStatus event is received', () => {
      render(<KbView />);

      // Send a done event for the converting doc
      for (const cb of kbDocStatusCallbacks) {
        cb({ name: 'DDR5 PHY 寄存器手册', status: 'done', category: '寄存器手册' });
      }

      const doc = useKbStore.getState().documents.find(
        (d) => d.name === 'DDR5 PHY 寄存器手册',
      );
      expect(doc?.status).toBe('done');
    });

    it('adds new document when event name is not in list', () => {
      render(<KbView />);

      const initialCount = useKbStore.getState().documents.length;

      for (const cb of kbDocStatusCallbacks) {
        cb({ name: '全新文档', status: 'queued' });
      }

      expect(useKbStore.getState().documents.length).toBe(initialCount + 1);
    });

    it('unsubscribes from kb:docStatus events on unmount', () => {
      const { unmount } = render(<KbView />);

      expect(kbDocStatusCallbacks.length).toBe(1);
      unmount();
      expect(kbDocStatusCallbacks.length).toBe(0);
    });

    // ── 文件类型图标 ───────────────────────────────────────

    it('renders PDF file icon for .pdf documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getAllByText('PDF').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('renders DOC file icon for .docx documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('DOC')).toBeTruthy();
      });
    });

    it('renders PPT file icon for .pptx documents', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('PPT')).toBeTruthy();
      });
    });

    // ── Tab 切换 ─────────────────────────────────────────────

    it('renders all three tab buttons', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('文档列表')).toBeTruthy();
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
        expect(screen.getByText('文档预览')).toBeTruthy();
      });
    });

    it('switches to index tab when clicked', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('库索引 index.md'));

      await waitFor(() => {
        // Index tab content should appear — the info message
        expect(screen.getByText(/此文件即 AI Agent/)).toBeTruthy();
      });
    });

    it('switches to preview tab when clicked', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('文档预览')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('文档预览'));

      await waitFor(() => {
        // Preview tab should show "选择文档进行预览" when no doc selected
        expect(screen.getByText('选择文档进行预览')).toBeTruthy();
      });
    });

    it('switches back to list tab from index', async () => {
      render(<KbView />);

      // Go to index
      await waitFor(() => {
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('库索引 index.md'));

      // Back to list
      fireEvent.click(screen.getByText('文档列表'));

      await waitFor(() => {
        expect(screen.getByText('拖拽文档到此处，或点击选择文件')).toBeTruthy();
      });
    });

    // ── 索引 Tab ─────────────────────────────────────────────

    it('renders index content in index tab', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('库索引 index.md'));

      await waitFor(() => {
        expect(screen.getByText('知识库索引')).toBeTruthy();
      });
    });

    it('renders update index button in index tab', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('库索引 index.md'));

      await waitFor(() => {
        expect(screen.getByText('更新索引')).toBeTruthy();
      });
    });

    it('renders edit button in index tab', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('库索引 index.md'));

      await waitFor(() => {
        expect(screen.getByText('编辑')).toBeTruthy();
      });
    });

    it('enters edit mode when edit button clicked', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('库索引 index.md')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('库索引 index.md'));

      await waitFor(() => {
        expect(screen.getByText('编辑')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('编辑'));

      await waitFor(() => {
        expect(screen.getByText('保存')).toBeTruthy();
        expect(screen.getByText('取消')).toBeTruthy();
      });
    });

    // ── 预览 Tab ─────────────────────────────────────────────

    it('opens preview when document row is clicked', async () => {
      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('AMBA AXI 协议规范 v4.1')).toBeTruthy();
      });

      // Click on the document name (the row)
      fireEvent.click(screen.getByText('AMBA AXI 协议规范 v4.1'));

      await waitFor(() => {
        // Should switch to preview tab and show content
        expect(useKbStore.getState().activeTab).toBe('preview');
      });
    });

    it('renders preview content when preview tab is active with doc', async () => {
      useKbStore.setState({
        previewDocName: 'AMBA AXI 协议规范 v4.1',
        previewContent: '# AMBA AXI 协议规范 v4.1\n\nAXI4 通道信号定义。',
        activeTab: 'preview',
      });

      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('AMBA AXI 协议规范 v4.1')).toBeTruthy();
        expect(screen.getByText(/AXI4 通道信号定义/)).toBeTruthy();
      });
    });

    it('renders metadata sidebar in preview tab', async () => {
      useKbStore.setState({
        previewDocName: 'AMBA AXI 协议规范 v4.1',
        previewContent: '# Test',
        activeTab: 'preview',
        documents: mockDocuments,
      });

      render(<KbView />);

      await waitFor(() => {
        expect(screen.getByText('文档信息')).toBeTruthy();
        expect(screen.getByText('源文件')).toBeTruthy();
        // "分类" appears in both KbHeader stats and KbPreviewTab sidebar
        const catLabels = screen.getAllByText('分类');
        expect(catLabels.length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText('大小')).toBeTruthy();
      });
    });

  });
});

// ─── KbModal Tests ─────────────────────────────────────────

describe('KbModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetKbStore();
  });

  it('renders modal title "知识库"', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: mockKbList, kbStatus: mockKbStatus });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    // "知识库" appears as the h2 title and also potentially in kbList names
    const headings = screen.getAllByText('知识库');
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  it('renders registered library list', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: mockKbList, kbStatus: mockKbStatus });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    expect(screen.getByText('芯片验证文档库')).toBeTruthy();
    expect(screen.getByText('通用协议手册库')).toBeTruthy();
  });

  it('shows "挂载中" for mounted library', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: mockKbList, kbStatus: mockKbStatus });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    expect(screen.getByText('挂载中')).toBeTruthy();
  });

  it('shows "挂载" button for unmounted library', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: mockKbList, kbStatus: mockKbStatus });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    expect(screen.getByText('挂载')).toBeTruthy();
  });

  it('renders wiki layout structure hint for new registration', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: mockKbList, kbStatus: mockKbStatus });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    expect(screen.getByText(/schema\.md\s*# 写作规则/)).toBeTruthy();
    expect(screen.getByText(/purpose\.md\s*# 库目标描述/)).toBeTruthy();
    expect(screen.getByText(/raw\/\s*# sources\//)).toBeTruthy();
    expect(screen.getByText(/wiki\/\s*# 知识页/)).toBeTruthy();
    expect(screen.getByText(/\.kb\/\s*# manifest\.json/)).toBeTruthy();
  });

  it('shows copy-conflict hint with "注册为副本" entry on kbIdConflict', async () => {
    const { trpc } = await import('@renderer/lib/trpc');
    vi.mocked(trpc.kb.register.mutate).mockResolvedValueOnce({
      ok: false as const,
      error: { code: 'kbIdConflict', message: '该目录是已有知识库「正本库」的副本（库 ID 相同）。' },
    });

    useKbStore.setState({ kbModalOpen: true, kbList: [], kbStatus: null });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    fireEvent.change(screen.getByPlaceholderText('库名称'), { target: { value: '副本库' } });
    fireEvent.change(screen.getByPlaceholderText('目录路径'), { target: { value: 'E:\\copy\\kb' } });
    fireEvent.click(screen.getByText('注册'));

    // 冲突提示出现，且提供「注册为副本」入口
    await waitFor(() => {
      expect(screen.getByText(/该目录是已有知识库「正本库」的副本/)).toBeTruthy();
    });
    expect(screen.getByText('注册为副本')).toBeTruthy();
  });

  it('re-registers as copy with asCopy: true when clicking the hint entry', async () => {
    const { trpc } = await import('@renderer/lib/trpc');
    vi.mocked(trpc.kb.register.mutate)
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'kbIdConflict', message: '该目录是已有知识库「正本库」的副本（库 ID 相同）。' },
      })
      .mockResolvedValueOnce({ ok: true, id: 'kb-copy-1', name: '副本库', path: 'E:\\copy\\kb', registeredAt: 0, format: 'wiki' });

    useKbStore.setState({ kbModalOpen: true, kbList: [], kbStatus: null });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    fireEvent.change(screen.getByPlaceholderText('库名称'), { target: { value: '副本库' } });
    fireEvent.change(screen.getByPlaceholderText('目录路径'), { target: { value: 'E:\\copy\\kb' } });
    fireEvent.click(screen.getByText('注册'));

    await waitFor(() => {
      expect(screen.getByText('注册为副本')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('注册为副本'));

    await waitFor(() => {
      expect(trpc.kb.register.mutate).toHaveBeenLastCalledWith({ name: '副本库', path: 'E:\\copy\\kb', asCopy: true });
    });
    // 冲突提示消失
    await waitFor(() => {
      expect(screen.queryByText('注册为副本')).toBeNull();
    });
  });

  it('renders legacy disposals with dismiss action', async () => {
    const { trpc } = await import('@renderer/lib/trpc');
    vi.mocked(trpc.kb.disposals.query).mockResolvedValueOnce([
      {
        id: 'legacy-1',
        path: 'D:\\old-kb',
        name: '旧格式库',
        kbId: null,
        reason: 'legacyFormat' as const,
        detectedAt: 1700000000000,
      },
    ]);

    useKbStore.setState({ kbModalOpen: true, kbList: [], kbStatus: null });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    await waitFor(() => {
      expect(screen.getByText(/旧格式库处置记录/)).toBeTruthy();
    });
    expect(screen.getByText('旧格式库')).toBeTruthy();
    expect(screen.getByText('D:\\old-kb')).toBeTruthy();
    expect(screen.getByTitle('仅移除处置记录，不触碰库目录')).toBeTruthy();

    fireEvent.click(screen.getByText('移除记录'));
    await waitFor(() => {
      expect(trpc.kb.dismissDisposal.mutate).toHaveBeenCalledWith({ disposalId: 'legacy-1' });
    });
  });

  it('closes on close button click', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: mockKbList, kbStatus: mockKbStatus });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    fireEvent.click(screen.getByText('关闭'));
    expect(useKbStore.getState().kbModalOpen).toBe(false);
  });

  it('disables register button when name or path is empty', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: [], kbStatus: null });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    const registerButton = screen.getByText('注册');
    expect(registerButton.closest('button')?.disabled).toBe(true);
  });

  it('shows empty message when no KBs are registered', async () => {
    useKbStore.setState({ kbModalOpen: true, kbList: [], kbStatus: null });
    const { KbModal } = await import('@renderer/components/kb/KbModal');
    render(<KbModal />);

    expect(screen.getByText('暂无已注册的知识库')).toBeTruthy();
  });
});
