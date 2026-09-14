/**
 * KbIndexTab — 索引 Tab（index.md 渲染视图 + 工具栏 + 编辑入口）。
 *
 * 功能：
 *   - 渲染 index.md 为 Markdown（分类节 + 条目：标题/路径/摘要/关键词标签）
 *   - 条目标题可点击跳转预览
 *   - "更新索引"按钮触发增量 Fast Reindex（复用 kb.upload 无新文件时的索引刷新）
 *   - 编辑入口：切换编辑模式，编辑后保存生效
 *   - 说明文案："此文件即 AI Agent 会话启动时注入的库地图"
 *
 * @see docs/prototypes/knowledge-base.html — UI 原型
 */

import { useEffect, useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RefreshCw, Pencil, Save, X, Info } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';

export function KbIndexTab() {
  const indexContent = useKbStore((s) => s.indexContent);
  const indexLoading = useKbStore((s) => s.indexLoading);
  const indexEditing = useKbStore((s) => s.indexEditing);
  const indexSaving = useKbStore((s) => s.indexSaving);
  const loadIndex = useKbStore((s) => s.loadIndex);
  const saveIndex = useKbStore((s) => s.saveIndex);
  const setIndexEditing = useKbStore((s) => s.setIndexEditing);
  const openPreview = useKbStore((s) => s.openPreview);
  const documents = useKbStore((s) => s.documents);

  const [editContent, setEditContent] = useState('');

  // 挂载时加载 index.md
  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // 进入编辑模式时同步内容
  useEffect(() => {
    if (indexEditing) {
      setEditContent(indexContent);
    }
  }, [indexEditing, indexContent]);

  // ── 更新索引（增量 reindex） ─────────────────────────────
  const handleReindex = useCallback(() => {
    // 刷新索引内容
    void loadIndex();
  }, [loadIndex]);

  // ── 保存编辑 ─────────────────────────────────────────────
  const handleSave = useCallback(() => {
    void saveIndex(editContent);
  }, [editContent, saveIndex]);

  // ── 取消编辑 ─────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    setIndexEditing(false);
  }, [setIndexEditing]);

  // ── Markdown 链接处理：条目标题点击跳转预览 ─────────────
  const handleMarkdownClick = useCallback((_e: React.MouseEvent) => {
    // Markdown 渲染不直接支持点击标题跳转
    // 但我们可以通过链接的 onClick 处理
  }, []);

  if (indexLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载索引...
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-[11px] text-muted-foreground">
          此文件即 AI Agent 会话启动时注入的库地图（KB Index）——人工可直接编辑，编辑后下次会话生效
        </span>
        <span className="text-[11px] text-muted-foreground">
          {documents.length} 条目
        </span>
        {!indexEditing ? (
          <>
            <button
              onClick={handleReindex}
              title="更新索引"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              更新索引
            </button>
            <button
              onClick={() => setIndexEditing(true)}
              title="编辑"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
              编辑
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleSave}
              disabled={indexSaving}
              className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              {indexSaving ? '保存中...' : '保存'}
            </button>
            <button
              onClick={handleCancel}
              title="取消"
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
              取消
            </button>
          </>
        )}
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {indexEditing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="h-full w-full resize-none rounded-lg border border-border bg-card p-4 font-mono text-xs outline-none focus:border-primary"
            placeholder="# 知识库索引&#10;&#10;<!-- 编辑 index.md -->"
          />
        ) : (
          <div
            className="mx-auto max-w-[860px] rounded-lg bg-card p-6 text-sm leading-relaxed shadow-sm"
            onClick={handleMarkdownClick}
          >
            {indexContent ? (
              <MarkdownIndexRenderer
                content={indexContent}
                onEntryClick={(title) => {
                  // 从文档列表中查找匹配的文档
                  const doc = documents.find((d) => d.name === title || d.name === title.replace(/\s+/g, '_'));
                  if (doc) {
                    openPreview(doc.name);
                  }
                }}
              />
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                索引为空，上传文档后将自动生成
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Markdown 索引渲染器 ──────────────────────────────────────

/**
 * 渲染 index.md，将 ### 标题转为可点击链接。
 * 使用 ReactMarkdown 渲染，但在标题元素上添加 onClick 跳转。
 */
function MarkdownIndexRenderer({
  content,
  onEntryClick,
}: {
  content: string;
  onEntryClick: (title: string) => void;
}) {
  return (
    <div className="kb-markdown max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h3: ({ children }) => {
            const title = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : String(children);
            return (
              <span
                className="cursor-pointer font-semibold text-primary hover:underline"
                onClick={() => onEntryClick(title)}
              >
                {children}
              </span>
            );
          },
          ul: ({ children }) => <ul className="my-2 list-none space-y-1">{children}</ul>,
          li: ({ children }) => (
            <li className="border-b border-dashed border-border py-1.5 last:border-b-0">
              {children}
            </li>
          ),
          code: ({ children }) => (
            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
              {children}
            </code>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
