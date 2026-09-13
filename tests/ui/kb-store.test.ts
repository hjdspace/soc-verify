// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock data ──────────────────────────────────────

const { mockKbList, mockKbStatus, mockCategories, mockDocuments } = vi.hoisted(() => {
  const mockKbList = [
    {
      id: 'kb-1',
      name: '芯片验证文档库',
      path: 'D:\\docs\\soc-kb',
      registeredAt: 1700000000000,
      documentCount: 24,
      categoryCount: 5,
      isMounted: true,
    },
    {
      id: 'kb-2',
      name: '通用协议手册库',
      path: 'E:\\shared\\amba-refs',
      registeredAt: 1700000001000,
      documentCount: 156,
      categoryCount: 8,
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
      name: '低功耗设计评审纪要（扫描版）',
      sourceExt: '.pdf',
      sourcePath: 'D:\\docs\\soc-kb\\sources\\lp_review_scan.pdf',
      markdownPath: '',
      category: '',
      sourceSize: 12400000,
      markdownSize: 0,
      assetCount: 0,
      status: 'failed' as const,
      errorCode: 'unsupported',
      errorMessage: '扫描版 PDF 无文字层，需 OCR（不支持）',
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

  return { mockKbList, mockKbStatus, mockCategories, mockDocuments };
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
      register: { mutate: vi.fn().mockResolvedValue({ ok: true, id: 'kb-3', name: '新知识库', path: 'D:\\docs\\new-kb', registeredAt: 1700000006000, format: 'wiki' }) },
      unregister: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      mount: { mutate: vi.fn().mockResolvedValue({ ok: true, data: { kbId: 'kb-2', mountedAt: 1700000007000 }, recovery: { cleaned: 0, rolledForward: 0, rolledBack: 0, failures: [] } }) },
      unmount: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      disposals: { query: vi.fn().mockResolvedValue([]) },
      dismissDisposal: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      index: { mutate: vi.fn().mockResolvedValue({ content: '# 知识库索引\n\n## 协议手册\n' }) },
      preview: { query: vi.fn().mockResolvedValue({ content: '# 测试文档\n\n内容' }) },
      moveCategory: { mutate: vi.fn().mockResolvedValue({ ok: true, newPath: 'D:\\docs\\kb\\docs\\新分类\\test.md' }) },
      renameCategory: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
      reclassify: { mutate: vi.fn().mockResolvedValue({ ok: true, category: '验证方法', title: '测试文档', summary: '新摘要', keywords: ['UVM'], moved: true }) },
      deepReindex: { mutate: vi.fn().mockResolvedValue({ ok: true, sessionId: 'temp-session-1', documentCount: 3 }) },
      pickFiles: { mutate: vi.fn().mockResolvedValue({ canceled: true }) },
      getSettings: {
        query: vi.fn().mockResolvedValue({
          settings: { convertEngine: 'anydoc', llm: {} },
          engines: [
            { id: 'anydoc', label: 'anydoc（默认）', description: 'Rust 原生引擎', supportedExtensions: ['.docx', '.pdf'] },
          ],
        }),
      },
      updateSettings: {
        mutate: vi.fn().mockImplementation(async (input: { convertEngine: string; llm: { providerId?: string; model?: string } }) => ({
          settings: { convertEngine: input.convertEngine, llm: input.llm },
        })),
      },
    },
    project: {
      pickFiles: { mutate: vi.fn() },
    },
    scan: {
      pickDirectory: { mutate: vi.fn() },
    },
  },
}));

// ─── Mock toast store ───────────────────────────────────────

const { toastMocks } = vi.hoisted(() => ({
  toastMocks: {
    success: vi.fn() as ReturnType<typeof vi.fn>,
    error: vi.fn() as ReturnType<typeof vi.fn>,
    warning: vi.fn() as ReturnType<typeof vi.fn>,
    info: vi.fn() as ReturnType<typeof vi.fn>,
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector(toastMocks)),
    {
      getState: () => toastMocks,
    },
  ),
}));

// ─── Import after mocks ─────────────────────────────────────

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
    deepReindexing: false,
    deepReindexProgress: null,
    previewDocName: null,
    previewContent: null,
    previewLoading: false,
    kbSettings: null,
    kbSettingsLoading: false,
    kbEngines: [],
  });
}

// ─── Tests ──────────────────────────────────────────────────

describe('KbStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetKbStore();
  });

  // ── 加载库列表 ───────────────────────────────────────────

  describe('loadKbList', () => {
    it('loads KB list from tRPC and populates kbList', async () => {
      await useKbStore.getState().loadKbList();

      const state = useKbStore.getState();
      expect(state.kbList).toEqual(mockKbList);
      expect(state.kbListLoading).toBe(false);
    });

    it('sets kbListLoading during fetch', async () => {
      const promise = useKbStore.getState().loadKbList();
      expect(useKbStore.getState().kbListLoading).toBe(true);
      await promise;
      expect(useKbStore.getState().kbListLoading).toBe(false);
    });

    it('handles error gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.list.query).mockRejectedValueOnce(new Error('Network error'));

      await useKbStore.getState().loadKbList();

      expect(useKbStore.getState().kbListLoading).toBe(false);
      expect(useKbStore.getState().kbList).toEqual([]);
    });

    it('silently handles no-project error without toast', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.list.query).mockRejectedValueOnce(
        new Error('未找到打开的项目，请先打开项目'),
      );

      await useKbStore.getState().loadKbList();

      expect(useKbStore.getState().kbListLoading).toBe(false);
      expect(useKbStore.getState().kbList).toEqual([]);
    });
  });

  // ── 加载挂载状态 ─────────────────────────────────────────

  describe('loadKbStatus', () => {
    it('loads KB status from tRPC', async () => {
      await useKbStore.getState().loadKbStatus();

      const state = useKbStore.getState();
      expect(state.kbStatus).toEqual(mockKbStatus);
      expect(state.kbStatusLoading).toBe(false);
    });

    it('handles not-mounted gracefully without toast', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.status.query).mockRejectedValueOnce(
        new Error('未挂载知识库，请先挂载'),
      );

      await useKbStore.getState().loadKbStatus();

      expect(useKbStore.getState().kbStatus).toBeNull();
      expect(useKbStore.getState().kbStatusLoading).toBe(false);
    });

    it('handles no-project gracefully without toast', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.status.query).mockRejectedValueOnce(
        new Error('未找到打开的项目，请先打开项目'),
      );

      await useKbStore.getState().loadKbStatus();

      expect(useKbStore.getState().kbStatus).toBeNull();
      expect(useKbStore.getState().kbStatusLoading).toBe(false);
    });
  });

  // ── 加载分类树 ───────────────────────────────────────────

  describe('loadCategories', () => {
    it('loads categories from tRPC', async () => {
      await useKbStore.getState().loadCategories();

      expect(useKbStore.getState().categories).toEqual(mockCategories);
    });
  });

  // ── 加载文档列表 ─────────────────────────────────────────

  describe('loadDocuments', () => {
    it('loads documents from tRPC', async () => {
      await useKbStore.getState().loadDocuments();

      expect(useKbStore.getState().documents).toEqual(mockDocuments);
    });
  });

  // ── 分类筛选 ─────────────────────────────────────────────

  describe('setSelectedCategory', () => {
    it('sets selected category', () => {
      useKbStore.getState().setSelectedCategory('协议手册');
      expect(useKbStore.getState().selectedCategory).toBe('协议手册');
    });

    it('clears selected category with null', () => {
      useKbStore.getState().setSelectedCategory('协议手册');
      useKbStore.getState().setSelectedCategory(null);
      expect(useKbStore.getState().selectedCategory).toBeNull();
    });
  });

  // ── 上传文档 ─────────────────────────────────────────────

  describe('uploadFiles', () => {
    it('calls tRPC upload and refreshes data', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      await useKbStore.getState().uploadFiles(['D:\\file1.pdf']);

      expect(trpc.kb.upload.mutate).toHaveBeenCalledWith({ filePaths: ['D:\\file1.pdf'] });
      expect(useKbStore.getState().uploading).toBe(false);
    });

    it('ignores empty file paths', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      await useKbStore.getState().uploadFiles([]);

      expect(trpc.kb.upload.mutate).not.toHaveBeenCalled();
    });

    it('sets uploading flag during upload', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.upload.mutate).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ results: [{ ok: true, document: mockDocuments[0] }] }), 50)),
      );

      const promise = useKbStore.getState().uploadFiles(['D:\\file1.pdf']);
      expect(useKbStore.getState().uploading).toBe(true);
      await promise;
      expect(useKbStore.getState().uploading).toBe(false);
    });

    it('handles upload failures gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.upload.mutate).mockRejectedValueOnce(new Error('Upload failed'));

      await useKbStore.getState().uploadFiles(['D:\\file1.pdf']);

      expect(useKbStore.getState().uploading).toBe(false);
    });

    it('reports partial failures', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.upload.mutate).mockResolvedValueOnce({
        results: [
          { ok: true as const, document: mockDocuments[0] },
          { ok: false as const, error: { code: 'unsupported', message: 'Scan PDF' } },
        ],
      });

      await useKbStore.getState().uploadFiles(['D:\\file1.pdf', 'D:\\file2.pdf']);

      expect(useKbStore.getState().uploading).toBe(false);
    });

    it('AI 降级时不显示成功 toast（提示 AI 分类失败）', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.upload.mutate).mockResolvedValueOnce({
        results: [
          {
            ok: true as const,
            document: {
              ...mockDocuments[0],
              status: 'done' as const,
              category: '未分类',
              aiDegraded: true,
              aiError: 'LLM API 返回 401',
            },
          },
        ],
      });

      await useKbStore.getState().uploadFiles(['D:\\file1.pdf']);

      expect(toastMocks.success).not.toHaveBeenCalled();
      expect(toastMocks.warning).toHaveBeenCalled();
      expect(useKbStore.getState().uploading).toBe(false);
    });
  });

  // ── AI 重新分类 ─────────────────────────────────────────

  describe('reclassifyDocument', () => {
    it('calls tRPC reclassify and refreshes', async () => {
      await useKbStore.getState().reclassifyDocument('AMBA AXI');

      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.reclassify.mutate).toHaveBeenCalledWith({ name: 'AMBA AXI' });
    });

    it('handles noLlmConfig failure without throwing', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.reclassify.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'noLlmConfig', message: '未配置 LLM 凭证' },
      });

      const result = await useKbStore.getState().reclassifyDocument('AMBA AXI');

      expect(result).toBe(false);
      expect(trpc.kb.reclassify.mutate).toHaveBeenCalled();
    });
  });

  // ── 重试文档 ─────────────────────────────────────────────

  describe('retryDocument', () => {
    it('calls tRPC retry and refreshes', async () => {
      await useKbStore.getState().retryDocument('AMBA AXI');

      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.retry.mutate).toHaveBeenCalledWith({ name: 'AMBA AXI' });
    });

    it('handles retry failure', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.retry.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'unsupported', message: 'Still unsupported' },
      });

      await useKbStore.getState().retryDocument('scan.pdf');

      expect(trpc.kb.retry.mutate).toHaveBeenCalled();
    });
  });

  // ── 删除文档 ─────────────────────────────────────────────

  describe('deleteDocument', () => {
    it('calls tRPC delete and refreshes', async () => {
      await useKbStore.getState().deleteDocument('AMBA AXI');

      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.delete.mutate).toHaveBeenCalledWith({ name: 'AMBA AXI' });
    });
  });

  // ── 注册知识库 ───────────────────────────────────────────

  describe('registerKb', () => {
    it('calls tRPC register and refreshes list', async () => {
      const result = await useKbStore.getState().registerKb('新库', 'D:\\docs\\new');

      expect(result.ok).toBe(true);
      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.register.mutate).toHaveBeenCalledWith({ name: '新库', path: 'D:\\docs\\new' });
    });

    it('passes asCopy through for copy-conflict registration', async () => {
      await useKbStore.getState().registerKb('副本库', 'D:\\docs\\copy', true);

      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.register.mutate).toHaveBeenCalledWith({ name: '副本库', path: 'D:\\docs\\copy', asCopy: true });
    });

    it('returns error code for copy conflict (kbIdConflict)', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.register.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'kbIdConflict', message: '该目录是已有知识库的副本' },
      });

      const result = await useKbStore.getState().registerKb('副本库', 'D:\\docs\\copy');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorCode).toBe('kbIdConflict');
    });

    it('returns false on failure', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.register.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'alreadyRegistered', message: 'Already registered' },
      });

      const result = await useKbStore.getState().registerKb('已存在', 'D:\\docs\\existing');

      expect(result.ok).toBe(false);
    });
  });

  // ── 旧格式处置记录 ───────────────────────────────────────

  describe('loadDisposals / dismissDisposal', () => {
    it('loads disposals from tRPC', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      const disposal = {
        id: 'legacy-1',
        path: 'D:\\old-kb',
        name: '旧库',
        kbId: null,
        reason: 'legacyFormat' as const,
        detectedAt: 1700000000000,
      };
      vi.mocked(trpc.kb.disposals.query).mockResolvedValueOnce([disposal]);

      await useKbStore.getState().loadDisposals();

      expect(useKbStore.getState().kbDisposals).toEqual([disposal]);
    });

    it('dismisses disposal and reloads list', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.dismissDisposal.mutate).mockResolvedValueOnce({ ok: true });

      const result = await useKbStore.getState().dismissDisposal('legacy-1');

      expect(result).toBe(true);
      expect(trpc.kb.dismissDisposal.mutate).toHaveBeenCalledWith({ disposalId: 'legacy-1' });
      expect(trpc.kb.disposals.query).toHaveBeenCalled();
    });

    it('returns false when dismiss fails', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.dismissDisposal.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'notRegistered', message: '处置记录不存在' },
      });

      const result = await useKbStore.getState().dismissDisposal('no-such');

      expect(result).toBe(false);
    });
  });

  // ── 挂载/卸载 ────────────────────────────────────────────

  describe('mountKb', () => {
    it('calls tRPC mount and refreshes', async () => {
      const result = await useKbStore.getState().mountKb('kb-2');

      expect(result).toBe(true);
      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.mount.mutate).toHaveBeenCalledWith({ kbId: 'kb-2' });
    });

    it('returns false on failure', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.mount.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'mountLimitExceeded', message: 'Limit exceeded' },
      });

      const result = await useKbStore.getState().mountKb('kb-2');
      expect(result).toBe(false);
    });
  });

  describe('unmountKb', () => {
    it('clears status, categories, documents on success', async () => {
      useKbStore.setState({
        kbStatus: mockKbStatus,
        categories: mockCategories,
        documents: mockDocuments,
      });

      const result = await useKbStore.getState().unmountKb('kb-1');

      expect(result).toBe(true);
      expect(useKbStore.getState().kbStatus).toBeNull();
      expect(useKbStore.getState().categories).toEqual([]);
      expect(useKbStore.getState().documents).toEqual([]);
    });
  });

  // ── 事件处理 ─────────────────────────────────────────────

  describe('handleDocStatusEvent', () => {
    it('updates existing document status', () => {
      useKbStore.setState({ documents: mockDocuments });

      useKbStore.getState().handleDocStatusEvent({
        name: 'DDR5 PHY 寄存器手册',
        status: 'done',
        category: '寄存器手册',
      });

      const docs = useKbStore.getState().documents;
      const doc = docs.find((d) => d.name === 'DDR5 PHY 寄存器手册');
      expect(doc?.status).toBe('done');
      expect(doc?.category).toBe('寄存器手册');
    });

    it('adds new document when event name is not in list', () => {
      useKbStore.setState({ documents: [] });

      useKbStore.getState().handleDocStatusEvent({
        name: '新文档',
        status: 'queued',
      });

      const docs = useKbStore.getState().documents;
      expect(docs).toHaveLength(1);
      expect(docs[0].name).toBe('新文档');
      expect(docs[0].status).toBe('queued');
    });

    it('preserves errorCode and errorMessage on failed status', () => {
      useKbStore.setState({ documents: mockDocuments });

      useKbStore.getState().handleDocStatusEvent({
        name: 'AMBA AXI 协议规范 v4.1',
        status: 'failed',
        errorCode: 'encrypted',
        errorMessage: '文档受密码保护',
      });

      const doc = useKbStore.getState().documents.find(
        (d) => d.name === 'AMBA AXI 协议规范 v4.1',
      );
      expect(doc?.status).toBe('failed');
      expect(doc?.errorCode).toBe('encrypted');
      expect(doc?.errorMessage).toBe('文档受密码保护');
    });
  });

  // ── 刷新全部 ─────────────────────────────────────────────

  describe('refreshAll', () => {
    it('loads status, categories, and documents in parallel', async () => {
      await useKbStore.getState().refreshAll();

      expect(useKbStore.getState().kbStatus).toEqual(mockKbStatus);
      expect(useKbStore.getState().categories).toEqual(mockCategories);
      expect(useKbStore.getState().documents).toEqual(mockDocuments);
    });
  });

  // ── 对话框状态 ───────────────────────────────────────────

  describe('kbModalOpen', () => {
    it('opens and closes modal', () => {
      useKbStore.getState().setKbModalOpen(true);
      expect(useKbStore.getState().kbModalOpen).toBe(true);
      useKbStore.getState().setKbModalOpen(false);
      expect(useKbStore.getState().kbModalOpen).toBe(false);
    });
  });

  // ── Tab 切换 ─────────────────────────────────────────────

  describe('setActiveTab', () => {
    it('switches to index tab', () => {
      useKbStore.getState().setActiveTab('index');
      expect(useKbStore.getState().activeTab).toBe('index');
    });

    it('switches to preview tab', () => {
      useKbStore.getState().setActiveTab('preview');
      expect(useKbStore.getState().activeTab).toBe('preview');
    });

    it('switches back to list tab', () => {
      useKbStore.getState().setActiveTab('index');
      useKbStore.getState().setActiveTab('list');
      expect(useKbStore.getState().activeTab).toBe('list');
    });
  });

  // ── 打开预览 ─────────────────────────────────────────────

  describe('openPreview', () => {
    it('sets previewDocName and switches to preview tab', () => {
      useKbStore.getState().openPreview('AMBA AXI');
      expect(useKbStore.getState().previewDocName).toBe('AMBA AXI');
      expect(useKbStore.getState().activeTab).toBe('preview');
    });
  });

  // ── 加载索引 ─────────────────────────────────────────────

  describe('loadIndex', () => {
    it('loads index content from tRPC', async () => {
      await useKbStore.getState().loadIndex();
      expect(useKbStore.getState().indexContent).toContain('知识库索引');
      expect(useKbStore.getState().indexLoading).toBe(false);
    });

    it('sets indexLoading during fetch', async () => {
      const promise = useKbStore.getState().loadIndex();
      expect(useKbStore.getState().indexLoading).toBe(true);
      await promise;
      expect(useKbStore.getState().indexLoading).toBe(false);
    });

    it('handles error gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.index.mutate).mockRejectedValueOnce(new Error('Network error'));
      await useKbStore.getState().loadIndex();
      expect(useKbStore.getState().indexLoading).toBe(false);
    });
  });

  // ── 保存索引 ─────────────────────────────────────────────

  describe('saveIndex', () => {
    it('saves index content and exits edit mode', async () => {
      useKbStore.getState().setIndexEditing(true);
      await useKbStore.getState().saveIndex('# 新内容');
      expect(useKbStore.getState().indexContent).toBe('# 新内容');
      expect(useKbStore.getState().indexEditing).toBe(false);
      expect(useKbStore.getState().indexSaving).toBe(false);
    });

    it('sets indexSaving during save', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.index.mutate).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ content: '# saved' }), 50)),
      );
      const promise = useKbStore.getState().saveIndex('# saving');
      expect(useKbStore.getState().indexSaving).toBe(true);
      await promise;
      expect(useKbStore.getState().indexSaving).toBe(false);
    });

    it('handles save error gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.index.mutate).mockRejectedValueOnce(new Error('Save failed'));
      await useKbStore.getState().saveIndex('# fail');
      expect(useKbStore.getState().indexSaving).toBe(false);
      expect(useKbStore.getState().indexEditing).toBe(true);
    });
  });

  // ── 索引编辑模式 ───────────────────────────────────────────

  describe('setIndexEditing', () => {
    it('enters edit mode', () => {
      useKbStore.getState().setIndexEditing(true);
      expect(useKbStore.getState().indexEditing).toBe(true);
    });

    it('exits edit mode', () => {
      useKbStore.getState().setIndexEditing(true);
      useKbStore.getState().setIndexEditing(false);
      expect(useKbStore.getState().indexEditing).toBe(false);
    });
  });

  // ── 加载预览文档 ───────────────────────────────────────────

  describe('loadPreview', () => {
    it('loads preview content from tRPC', async () => {
      await useKbStore.getState().loadPreview('AMBA AXI');
      expect(useKbStore.getState().previewDocName).toBe('AMBA AXI');
      expect(useKbStore.getState().previewContent).toContain('测试文档');
      expect(useKbStore.getState().previewLoading).toBe(false);
    });

    it('sets previewLoading during fetch', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.preview.query).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ content: '# delayed' }), 50)),
      );
      const promise = useKbStore.getState().loadPreview('test');
      expect(useKbStore.getState().previewLoading).toBe(true);
      await promise;
      expect(useKbStore.getState().previewLoading).toBe(false);
    });

    it('handles error gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.preview.query).mockRejectedValueOnce(new Error('Preview failed'));
      await useKbStore.getState().loadPreview('fail');
      expect(useKbStore.getState().previewLoading).toBe(false);
      expect(useKbStore.getState().previewContent).toBeNull();
    });
  });

  // ── 移动分类 ─────────────────────────────────────────────

  describe('moveCategory', () => {
    it('calls tRPC moveCategory and refreshes', async () => {
      const result = await useKbStore.getState().moveCategory('AMBA AXI', '新分类');
      expect(result).toBe(true);
      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.moveCategory.mutate).toHaveBeenCalledWith({ name: 'AMBA AXI', category: '新分类' });
    });

    it('returns false on failure', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.moveCategory.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'notFound', message: 'Document not found' },
      });
      const result = await useKbStore.getState().moveCategory('missing', '分类');
      expect(result).toBe(false);
    });

    it('handles network error gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.moveCategory.mutate).mockRejectedValueOnce(new Error('Network error'));
      const result = await useKbStore.getState().moveCategory('test', '分类');
      expect(result).toBe(false);
    });
  });

  // ── 深度重建（Issue #7）─────────────────────────────────

  describe('deepReindex', () => {
    it('calls tRPC deepReindex and refreshes on success', async () => {
      await useKbStore.getState().deepReindex();
      const { trpc } = await import('@renderer/lib/trpc');
      expect(trpc.kb.deepReindex.mutate).toHaveBeenCalledWith({});
      expect(useKbStore.getState().deepReindexing).toBe(false);
    });

    it('sets deepReindexing flag during operation', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.deepReindex.mutate).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, sessionId: 'temp', documentCount: 5 }), 50)),
      );
      const promise = useKbStore.getState().deepReindex();
      expect(useKbStore.getState().deepReindexing).toBe(true);
      await promise;
      expect(useKbStore.getState().deepReindexing).toBe(false);
    });

    it('handles failure gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.deepReindex.mutate).mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'sessionFailed', message: 'LLM error' },
      });
      await useKbStore.getState().deepReindex();
      expect(useKbStore.getState().deepReindexing).toBe(false);
    });

    it('handles network error gracefully', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.deepReindex.mutate).mockRejectedValueOnce(new Error('Network error'));
      await useKbStore.getState().deepReindex();
      expect(useKbStore.getState().deepReindexing).toBe(false);
    });

    it('prevents duplicate calls when already reindexing', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.deepReindex.mutate).mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, sessionId: 'temp', documentCount: 1 }), 50)),
      );
      const firstPromise = useKbStore.getState().deepReindex();
      // Second call while first is in-flight should be ignored
      await useKbStore.getState().deepReindex();
      await firstPromise;
      expect(trpc.kb.deepReindex.mutate).toHaveBeenCalledTimes(1);
    });
  });

  // ── 深度重建进度事件 ───────────────────────────────────────

  describe('handleDeepReindexEvent', () => {
    it('sets deepReindexing and progress on processing event', () => {
      useKbStore.getState().handleDeepReindexEvent({
        phase: 'processing',
        current: 2,
        total: 5,
        message: '正在处理第 2/5 篇文档',
      });
      expect(useKbStore.getState().deepReindexing).toBe(true);
      expect(useKbStore.getState().deepReindexProgress).toEqual({
        current: 2,
        total: 5,
        message: '正在处理第 2/5 篇文档',
      });
    });

    it('clears state on completed event', () => {
      useKbStore.setState({ deepReindexing: true, deepReindexProgress: { current: 5, total: 5, message: '处理中' } });
      useKbStore.getState().handleDeepReindexEvent({
        phase: 'completed',
        message: '深度重建完成',
      });
      expect(useKbStore.getState().deepReindexing).toBe(false);
      expect(useKbStore.getState().deepReindexProgress).toBeNull();
    });

    it('clears state on failed event', () => {
      useKbStore.setState({ deepReindexing: true, deepReindexProgress: { current: 2, total: 5, message: '处理中' } });
      useKbStore.getState().handleDeepReindexEvent({
        phase: 'failed',
        message: '重建失败',
        error: 'sessionFailed',
      });
      expect(useKbStore.getState().deepReindexing).toBe(false);
      expect(useKbStore.getState().deepReindexProgress).toBeNull();
    });
  });

  // ─── 知识库设置 ──────────────────────────────────────────────

  describe('loadKbSettings', () => {
    it('加载设置与引擎元信息', async () => {
      await useKbStore.getState().loadKbSettings();

      const { trpc } = await import('@renderer/lib/trpc');
      expect(vi.mocked(trpc.kb.getSettings.query)).toHaveBeenCalledWith({});
      expect(useKbStore.getState().kbSettings).toEqual({ convertEngine: 'anydoc', llm: {} });
      expect(useKbStore.getState().kbEngines).toHaveLength(1);
      expect(useKbStore.getState().kbSettingsLoading).toBe(false);
    });

    it('加载失败时提示错误', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.getSettings.query).mockRejectedValueOnce(new Error('Network error'));
      await useKbStore.getState().loadKbSettings();

      expect(toastMocks.error).toHaveBeenCalledWith('加载知识库设置失败', 'Network error');
      expect(useKbStore.getState().kbSettingsLoading).toBe(false);
    });
  });

  describe('updateKbSettings', () => {
    it('保存设置并更新 state + 成功提示', async () => {
      const ok = await useKbStore.getState().updateKbSettings({
        convertEngine: 'anydoc',
        llm: { providerId: 'relay', model: 'glm-4.7' },
      });

      const { trpc } = await import('@renderer/lib/trpc');
      expect(ok).toBe(true);
      expect(vi.mocked(trpc.kb.updateSettings.mutate)).toHaveBeenCalledWith({
        convertEngine: 'anydoc',
        llm: { providerId: 'relay', model: 'glm-4.7' },
      });
      expect(useKbStore.getState().kbSettings).toEqual({
        convertEngine: 'anydoc',
        llm: { providerId: 'relay', model: 'glm-4.7' },
      });
      expect(toastMocks.success).toHaveBeenCalledWith('知识库设置已保存');
    });

    it('保存失败返回 false 并提示错误', async () => {
      const { trpc } = await import('@renderer/lib/trpc');
      vi.mocked(trpc.kb.updateSettings.mutate).mockRejectedValueOnce(new Error('Save failed'));
      const ok = await useKbStore.getState().updateKbSettings({ convertEngine: 'anydoc', llm: {} });

      expect(ok).toBe(false);
      expect(toastMocks.error).toHaveBeenCalledWith('保存知识库设置失败', 'Save failed');
    });
  });
});
