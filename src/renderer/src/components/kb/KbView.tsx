/**
 * KbView — 知识库主视图组件。
 *
 * Issue #5: 列表 Tab（库头部 + 分类树面板 + 文档列表 + 拖拽上传区）。
 * Issue #6: 索引 Tab（index.md 渲染 + 编辑）+ 预览 Tab（Markdown + 元信息 + AI 摘要 + 移动分类）。
 * 库注册/挂载对话框通过子组件 KbModal 实现。
 * kb:docStatus 事件通过 eventBridge 订阅，实时刷新文档状态。
 *
 * @see docs/prototypes/knowledge-base.html — UI 原型
 */

import { useEffect, useCallback } from 'react';
import { BookOpen, RefreshCw, List, Map, Eye, ListTodo } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { cn } from '@renderer/lib/utils';
import { KbHeader } from './KbHeader';
import { KbCategoryTree } from './KbCategoryTree';
import { KbDocList } from './KbDocList';
import { KbModal } from './KbModal';
import { KbIndexTab } from './KbIndexTab';
import { KbPreviewTab } from './KbPreviewTab';
import { KbWikiTasks } from './KbWikiTasks';

export function KbView() {
  const kbStatus = useKbStore((s) => s.kbStatus);
  const kbStatusLoading = useKbStore((s) => s.kbStatusLoading);
  const loadKbList = useKbStore((s) => s.loadKbList);
  const loadKbStatus = useKbStore((s) => s.loadKbStatus);
  const loadCategories = useKbStore((s) => s.loadCategories);
  const loadDocuments = useKbStore((s) => s.loadDocuments);
  const handleDocStatusEvent = useKbStore((s) => s.handleDocStatusEvent);
  const handleDeepReindexEvent = useKbStore((s) => s.handleDeepReindexEvent);
  const kbModalOpen = useKbStore((s) => s.kbModalOpen);
  const activeTab = useKbStore((s) => s.activeTab);
  const setActiveTab = useKbStore((s) => s.setActiveTab);
  const loadIndex = useKbStore((s) => s.loadIndex);

  // 挂载库标识（只在真正换库时重新加载，status 轮询刷新不重复触发）
  const mountedKbId = kbStatus?.mounted?.kbId ?? null;

  // ─── Mount: 加载初始数据 ──────────────────────────────────
  useEffect(() => {
    void loadKbList();
    void loadKbStatus();
  }, [loadKbList, loadKbStatus]);

  // ─── 挂载库变化时加载分类与文档 ────────────────────────────
  useEffect(() => {
    if (mountedKbId) {
      void loadCategories();
      void loadDocuments();
    }
  }, [mountedKbId, loadCategories, loadDocuments]);

  // ─── 索引 Tab 激活时加载索引内容 ────────────────────────────
  useEffect(() => {
    if (mountedKbId && activeTab === 'index') {
      void loadIndex();
    }
  }, [mountedKbId, activeTab, loadIndex]);

  // ─── 订阅 kb:docStatus 事件 ───────────────────────────────
  useEffect(() => {
    if (!window.eventBridge) return;
    const unlisten = window.eventBridge.onKbDocStatus((event) => {
      handleDocStatusEvent(event);
    });
    return unlisten;
  }, [handleDocStatusEvent]);

  // ─── 订阅 kb:deepReindex 事件（Issue #7）─────────────────
  useEffect(() => {
    if (!window.eventBridge) return;
    const unlisten = window.eventBridge.onKbDeepReindex((event) => {
      handleDeepReindexEvent(event);
    });
    return unlisten;
  }, [handleDeepReindexEvent]);

  const handleRefresh = useCallback(() => {
    void loadKbStatus();
    void loadCategories();
    void loadDocuments();
    if (activeTab === 'index') {
      void loadIndex();
    }
  }, [loadKbStatus, loadCategories, loadDocuments, activeTab, loadIndex]);

  // ─── 未挂载知识库 ─────────────────────────────────────────
  if (!kbStatusLoading && !kbStatus?.mounted) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <BookOpen className="h-12 w-12 text-muted-foreground/40" />
        <div className="text-sm text-muted-foreground">未挂载知识库</div>
        <button
          onClick={() => useKbStore.getState().setKbModalOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <BookOpen className="h-3.5 w-3.5" />
          注册 / 挂载知识库
        </button>
        {kbModalOpen && <KbModal />}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── 库头部 ────────────────────────────────────────── */}
      <KbHeader />

      {/* ── wiki 布局能力提示：旧分类入口已停用 ─────────── */}
      {kbStatus?.mounted?.format === 'wiki' && (
        <div className="border-b border-border bg-secondary/50 px-4 py-1.5 text-[11px] text-muted-foreground">
          新布局（LLM Wiki）知识库已挂载：文档导入、分类与索引能力暂未就绪，将由知识库新流水线提供。
        </div>
      )}

      {/* ── 主体：分类树 + 内容区 ────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* 分类树面板 */}
        <KbCategoryTree />

        {/* 内容区 */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border px-3">
            <button
              onClick={() => setActiveTab('list')}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                activeTab === 'list'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <List className="h-3.5 w-3.5" />
              文档列表
            </button>
            <button
              onClick={() => setActiveTab('index')}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                activeTab === 'index'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Map className="h-3.5 w-3.5" />
              库索引 index.md
            </button>
            <button
              onClick={() => setActiveTab('preview')}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                activeTab === 'preview'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Eye className="h-3.5 w-3.5" />
              文档预览
            </button>
            {kbStatus?.mounted?.format === 'wiki' && (
              <button
                onClick={() => setActiveTab('tasks')}
                className={cn(
                  'flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors',
                  activeTab === 'tasks'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <ListTodo className="h-3.5 w-3.5" />
                导入任务
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={handleRefresh}
              title="刷新"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Tab 内容 */}
          {activeTab === 'list' && <KbDocList />}
          {activeTab === 'index' && <KbIndexTab />}
          {activeTab === 'preview' && <KbPreviewTab />}
          {activeTab === 'tasks' && kbStatus?.mounted?.format === 'wiki' && <KbWikiTasks />}
        </div>
      </div>

      {/* 库注册/挂载对话框 */}
      {kbModalOpen && <KbModal />}
    </div>
  );
}
